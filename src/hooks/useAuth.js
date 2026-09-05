import { useCallback, useEffect, useState } from 'react';

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

function useGoogleAuth() {
  const [token, setToken] = useState(() => readStoredToken());
  const [tokenClient, setTokenClient] = useState(null);
  const [gisReady, setGisReady] = useState(false);

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
          }
        }
      });
      setTokenClient(client);
      setGisReady(true);
      // Remember-me: if we don't already have a live token (either never
      // signed in this browser, or the stored one expired), try a silent
      // re-auth before falling back to asking the user to click "Sign in".
      // Google will grant this without any UI as long as the person
      // previously consented and still has an active Google session in
      // this browser — same idea as the vault folder being remembered,
      // just re-checked once per app load instead of persisted forever
      // (access tokens can't be persisted forever; only the *consent* can).
      if (!readStoredToken()) {
        client.requestAccessToken({ prompt: 'none' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(() => {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
  }, [tokenClient, token]);

  const signOut = useCallback(() => {
    if (token && window.google?.accounts?.oauth2?.revoke) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    localStorage.removeItem('vault_access_token');
    releaseImageUrlCache();
    releaseSearchIndex();
    setToken('');
  }, [token]);

  return { token, gisReady, signIn, signOut };
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
