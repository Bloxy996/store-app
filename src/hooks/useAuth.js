import { useCallback, useEffect, useRef, useState } from 'react';

import { releaseImageUrlCache } from './useDriveImageUrl.js';
import { releaseSearchIndex } from './useVaultIndex.js';
import { CLIENT_ID, DRIVE_SCOPE } from '../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Auth hook — Google Identity Services token client
// ---------------------------------------------------------------------------
// Access tokens are stored with an expiry so a stale one (Google tokens
// last ~1hr) is never handed to driveApi.js as if it were still valid.
function readStoredToken() {
  try {
    const raw = localStorage.getItem('vault_access_token');
    if (!raw) return '';
    const { token, expiresAt } = JSON.parse(raw);
    if (!token || !expiresAt || Date.now() >= expiresAt) return '';
    return token;
  } catch {
    return '';
  }
}

function storeToken(token, expiresInSeconds) {
  // 60s safety margin so nothing treats a token as valid in the last
  // moment before Google would have expired it anyway.
  const expiresAt = Date.now() + Math.max(0, (expiresInSeconds || 3600) - 60) * 1000;
  localStorage.setItem('vault_access_token', JSON.stringify({ token, expiresAt }));
}

// Margin (in seconds) before actual expiry that a background refresh fires.
// Bigger than storeToken's 60s safety margin so the refresh has landed
// *before* readStoredToken() would start reporting the token as unusable.
const REFRESH_MARGIN_SECONDS = 300;

function useGoogleAuth() {
  const [token, setToken] = useState(() => readStoredToken());
  const [gisReady, setGisReady] = useState(false);
  const [hasEverSignedIn, setHasEverSignedIn] = useState(() => localStorage.getItem('vault_has_ever_signed_in') === 'true');

  const tokenClientRef = useRef(null);
  const refreshTimerRef = useRef(null);
  // GIS's token client is not reentrant: firing a second
  // requestAccessToken() before the first call's callback (success *or*
  // error) has landed reliably breaks the first request instead of
  // queuing it. Previously nothing guarded against this, so the
  // mount-time "remember me" silent check and a person's own "Sign in"
  // click could land on top of each other and the click would appear to
  // do nothing — needing a second click to actually open the consent
  // popup. Every request now goes through requestToken() below so only
  // one is ever in flight; anything asked for while one is pending is
  // remembered and replayed as soon as the pending one settles, with an
  // interactive prompt always taking priority over a queued silent one.
  const pendingRef = useRef(false);
  const queuedPromptRef = useRef(null);

  const requestToken = useCallback((prompt) => {
    const client = tokenClientRef.current;
    if (!client) return;
    if (pendingRef.current) {
      if (prompt !== 'none' || queuedPromptRef.current === null) {
        queuedPromptRef.current = prompt;
      }
      return;
    }
    pendingRef.current = true;
    client.requestAccessToken({ prompt });
  }, []);

  const settleRequest = useCallback(() => {
    pendingRef.current = false;
    if (queuedPromptRef.current !== null) {
      const next = queuedPromptRef.current;
      queuedPromptRef.current = null;
      requestToken(next);
    }
  }, [requestToken]);

  // Renew the token in the background well before it actually goes stale,
  // so a tab left open across the ~1hr lifetime keeps working instead of
  // silently starting to 401 until the person reloads the page or is
  // dropped back to the sign-in screen mid-session.
  const scheduleRefresh = useCallback((expiresInSeconds) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delayMs = Math.max(10, (expiresInSeconds || 3600) - REFRESH_MARGIN_SECONDS) * 1000;
    refreshTimerRef.current = setTimeout(() => requestToken('none'), delayMs);
  }, [requestToken]);

  useEffect(() => {
    let cancelled = false;
    (function init() {
      if (cancelled) return;
      if (!window.google || !window.google.accounts) {
        setTimeout(init, 150);
        return;
      }
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp && resp.access_token) {
            storeToken(resp.access_token, resp.expires_in);
            setToken(resp.access_token);
            localStorage.setItem('vault_has_ever_signed_in', 'true');
            setHasEverSignedIn(true);
            scheduleRefresh(resp.expires_in);
          }
          settleRequest();
        },
        // Without this, a failed silent/interactive attempt would never
        // release pendingRef above and every request after it would sit
        // queued forever instead of actually firing.
        error_callback: () => {
          settleRequest();
        }
      });
      tokenClientRef.current = client;
      setGisReady(true);
      // Remember-me: only attempt this for a browser that has actually
      // signed in before — a fresh visitor has no prior consent for a
      // silent re-auth to succeed against, so there's nothing to gain
      // from firing it unconditionally on every load, and doing so is
      // exactly what could race the person's own first "Sign in" click
      // (see requestToken above).
      const existingToken = readStoredToken();
      if (!existingToken) {
        if (localStorage.getItem('vault_has_ever_signed_in') === 'true') {
          requestToken('none');
        }
      } else {
        // A still-valid token from a previous load: pick up the refresh
        // schedule using whatever's left of its actual lifetime.
        try {
          const { expiresAt } = JSON.parse(localStorage.getItem('vault_access_token'));
          scheduleRefresh(Math.round((expiresAt - Date.now()) / 1000));
        } catch {
          // Ignore — worst case the token just gets renewed reactively
          // instead of ahead of time.
        }
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A laptop that sleeps longer than the token's remaining lifetime wakes
  // up with a background refresh timer that either never fired or fired
  // too late to matter. Catch that as soon as the tab is visible again
  // instead of waiting for the next Drive call to fail with a 401.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !readStoredToken() && hasEverSignedIn) {
        requestToken('none');
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [hasEverSignedIn, requestToken]);

  const signIn = useCallback(() => {
    requestToken(token ? '' : 'consent');
  }, [requestToken, token]);

  const signOut = useCallback(() => {
    if (token && window.google?.accounts?.oauth2?.revoke) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    localStorage.removeItem('vault_access_token');
    releaseImageUrlCache();
    releaseSearchIndex();
    setToken('');
  }, [token]);

  return { token, gisReady, signIn, signOut, hasEverSignedIn };
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

export { useGoogleAuth, useProxyAuth };
