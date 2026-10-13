import { useState } from 'react';

import { IconZap } from '../../components/icons.jsx';
import { isProxy } from '../../lib/driveApi.js';
import { SparkCaptureForm } from './SparkCaptureForm.jsx';

// `?embed=spark` — the compact capture sheet the Android companion opens
// over whatever app you're in (a partial Chrome Custom Tab, see
// android/README.md). Same form, session and vault as the full app; just
// no workspace around it. `storesparks://` links are handled by the
// companion's SparkCaptureActivity, which closes the sheet / opens the app.
const EMBED_SPARK = new URLSearchParams(window.location.search).get('embed') === 'spark';

function leave(host) {
  window.location.href = `storesparks://${host}`;
  // No companion app (desktop, not installed): fall back to the full app.
  if (host === 'open') setTimeout(() => { window.location.href = import.meta.env.BASE_URL; }, 1500);
}

function SparkQuickCapture({ token, sparks, loaded, busy, error, filesMeta, getBody, onSubmit }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="spark-embed">
      <div className="spark-embed-head">
        <IconZap size={14} /> Add spark
        <button className="btn-secondary spark-embed-open" onClick={() => leave('open')}>Open app</button>
      </div>
      {saved ? (
        <div className="spark-embed-saved">
          <div>Saved</div>
          <button className="btn-primary" onClick={() => leave('done')}>Done</button>
          <button className="btn-secondary" onClick={() => setSaved(false)}>Add another</button>
        </div>
      ) : (
        <>
          <SparkCaptureForm
            sparks={sparks}
            filesMeta={filesMeta}
            getBody={getBody}
            busy={busy || !loaded}
            autoFocus
            canAttachScreenshot={!isProxy(token)}
            onSubmit={async (payload) => {
              await onSubmit(payload);
              setSaved(true);
            }}
          />
          {!loaded && <div className="muted small">Loading your sparks…</div>}
          {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
        </>
      )}
    </div>
  );
}

export { EMBED_SPARK, SparkQuickCapture };
