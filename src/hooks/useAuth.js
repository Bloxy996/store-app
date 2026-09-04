import { useCallback, useEffect, useState } from 'react';

import { releaseImageUrlCache } from './useDriveImageUrl.js';
import { releaseSearchIndex } from './useVaultIndex.js';
import { CLIENT_ID, DRIVE_SCOPE } from '../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Auth hook — Google Identity Services token client
// ---------------------------------------------------------------------------
function useGoogleAuth() {
  const [token, setToken] = useState(() => sessionStorage.getItem('vault_access_token') || '');
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
            sessionStorage.setItem('vault_access_token', resp.access_token);
            setToken(resp.access_token);
          }
        }
      });
      setTokenClient(client);
      setGisReady(true);
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
    sessionStorage.removeItem('vault_access_token');
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
