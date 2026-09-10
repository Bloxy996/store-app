import { useCallback, useEffect, useState } from 'react';

import { releaseImageUrlCache } from './useDriveImageUrl.js';
import { releaseSearchIndex } from './useVaultIndex.js';
import { BACKEND_URL } from '../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Auth hook — store backend session (see server/README.md)
// ---------------------------------------------------------------------------
// Replaces the old Google Identity Services token-client flow: sign-in is
// now a full redirect to the backend's /auth/login, which does the OAuth
// dance and hands back an httpOnly session cookie holding a refresh token.
// The frontend never sees a Google token at all anymore — no
// localStorage-held access token, no background refresh timer, no GIS
// reentrancy handling — it just asks the backend "am I signed in?" and
// otherwise leaves auth to it. `token` is kept as this hook's return field
// name (and passed around by that name in App.jsx/useVaultSync.js/etc.)
// for compatibility with every existing call site, but it's now just a
// truthy marker — `''` signed out, `{ backend: true }` signed in — not a
// bearer token. driveApi.js's actual Drive/Picker requests carry the
// browser's session cookie instead (see driveApi.js's header comment).
const BACKEND_TOKEN = { backend: true };

function useBackendAuth() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [hasEverSignedIn, setHasEverSignedIn] = useState(() => localStorage.getItem('vault_has_ever_signed_in') === 'true');

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/auth/status`, { credentials: 'include' });
      const data = res.ok ? await res.json() : { authenticated: false };
      setAuthenticated(!!data.authenticated);
      if (data.authenticated) {
        localStorage.setItem('vault_has_ever_signed_in', 'true');
        setHasEverSignedIn(true);
      }
    } catch {
      // Backend unreachable (offline, cold-starting free-tier host, etc.) —
      // treat as "not signed in yet" rather than throwing; the person can
      // retry Sign in, which will surface the failure more concretely.
      setAuthenticated(false);
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // The OAuth redirect round-trip lands back on this page with ?auth=... —
  // re-check status right away instead of waiting for the next mount, and
  // strip the query param so it doesn't linger in the address bar/history.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('auth')) return;
    const wasSuccess = params.get('auth') === 'success';
    params.delete('auth');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', next);
    if (wasSuccess) checkStatus();
  }, [checkStatus]);

  // Mirrors the old visibility-change re-check: a phone that's been
  // backgrounded/locked a long time re-verifies the session as soon as
  // it's foregrounded again, rather than waiting for a Drive call to 401.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && hasEverSignedIn) checkStatus();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [hasEverSignedIn, checkStatus]);

  const signIn = useCallback(() => {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = `${BACKEND_URL}/auth/login?returnTo=${returnTo}`;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch(`${BACKEND_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // Best-effort — clear local state regardless so the UI reflects
      // "signed out" even if the network call itself failed.
    }
    releaseImageUrlCache();
    releaseSearchIndex();
    setAuthenticated(false);
  }, []);

  return { token: authenticated ? BACKEND_TOKEN : '', authReady, signIn, signOut, hasEverSignedIn };
}


// ---------------------------------------------------------------------------
// Auth hook — Apps Script proxy (URL + shared secret, no Google OAuth)
// ---------------------------------------------------------------------------
function useProxyAuth() {
  const [proxyToken, setProxyToken] = useState(() => {
    try {
      const raw = localStorage.getItem('vault_proxy_config');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const signInProxy = useCallback((url, secret) => {
    const cfg = { proxy: true, url: url.trim().replace(/\/$/, ''), secret: secret.trim() };
    localStorage.setItem('vault_proxy_config', JSON.stringify(cfg));
    setProxyToken(cfg);
  }, []);

  const signOutProxy = useCallback(() => {
    localStorage.removeItem('vault_proxy_config');
    releaseImageUrlCache();
    releaseSearchIndex();
    setProxyToken(null);
  }, []);

  return { proxyToken, signInProxy, signOutProxy };
}

export { useBackendAuth, useProxyAuth };
