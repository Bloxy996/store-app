import { useState } from 'react';

import { ProxyFolderBrowser } from './ProxyFolderBrowser.jsx';


// Derives the human label + percent for the loading step from a sync
// progress object — shared between the "opening" and "fetching content"
// moments so both go through the same OnboardingFlow step.
function loadingStepProps(progress) {
  const { phase, loaded, total } = progress;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : null;
  const label =
    phase === 'opening'
      ? 'Opening your store…'
      : phase === 'listing-folders'
      ? 'Scanning folders…'
      : phase === 'listing-files'
      ? 'Listing notes and images…'
      : phase === 'fetching-content'
      ? total > 0
        ? `Loading ${loaded} of ${total} notes…`
        : 'Loading notes…'
      : 'Loading your store…';
  return { label, pct };
}


// The single onboarding shell. `step` selects which content renders inside
// it; the shell itself (background, heading) never unmounts between steps.
function OnboardingFlow({
  step,
  onSignIn,
  ready,
  onSignInProxy,
  onPickFolder,
  proxyToken,
  onProxyFolderPick,
  loadingLabel,
  loadingPct
}) {
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem('vault_proxy_url_draft') || '');
  const [proxySecret, setProxySecret] = useState('');

  const submitProxy = (e) => {
    e.preventDefault();
    if (!proxyUrl.trim() || !proxySecret.trim()) return;
    localStorage.setItem('vault_proxy_url_draft', proxyUrl.trim());
    onSignInProxy(proxyUrl.trim(), proxySecret.trim());
  };

  return (
    <div className="center-screen">
      <h1>store</h1>

      {step === 'signin' && (
        <>
          <button className="btn btn-neutral" disabled={!ready} onClick={onSignIn}>
            {ready ? 'Sign in with Google' : 'Loading…'}
          </button>
          {!showProxyForm ? (
            <button className="btn-secondary" onClick={() => setShowProxyForm(true)}>
              Use Apps Script proxy instead
            </button>
          ) : (
            <form className="proxy-form" onSubmit={submitProxy}>
              <input
                type="url"
                placeholder="Apps Script Web App URL"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                required
              />
              <input
                type="password"
                placeholder="Shared secret"
                value={proxySecret}
                onChange={(e) => setProxySecret(e.target.value)}
                required
              />
              <button type="submit" className="btn btn-neutral">
                Connect
              </button>
            </form>
          )}
        </>
      )}

      {step === 'folder' && (
        <>
          <p className="muted">Pick the Google Drive folder that holds (or will hold) your files.</p>
          <button className="btn btn-neutral" onClick={onPickFolder}>
            Select Drive folder
          </button>
        </>
      )}

      {step === 'proxy-folder' && (
        <ProxyFolderBrowser token={proxyToken} onPick={onProxyFolderPick} variant="inline" />
      )}

      {step === 'loading' && (
        <>
          <p className="muted">{loadingLabel}</p>
          <div className="progress-bar">
            <div
              className={`progress-bar-fill neutral ${loadingPct === null ? 'indeterminate' : ''}`}
              style={loadingPct !== null ? { width: `${loadingPct}%` } : undefined}
            />
          </div>
          {loadingPct !== null && <p className="muted small">{loadingPct}%</p>}
        </>
      )}
    </div>
  );
}

export { loadingStepProps, OnboardingFlow };
