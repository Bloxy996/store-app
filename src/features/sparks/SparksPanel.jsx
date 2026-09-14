import React, { useMemo, useState } from 'react';

import { IconLink2, IconLoader, IconPlus, IconTrash, IconX, IconZap } from '../../components/icons.jsx';
import { useDriveImageUrl } from '../../hooks/useDriveImageUrl.js';
import { isProxy } from '../../lib/driveApi.js';
import { SparkCaptureForm } from './SparkCaptureForm.jsx';

function SparkScreenshotThumb({ token, fileId }) {
  const { url } = useDriveImageUrl(token, fileId);
  if (!url) return <div className="spark-thumb spark-thumb-loading" />;
  return <img className="spark-thumb" src={url} alt="" />;
}

// `focusFileId`, when set (via a note's "N sparks" indicator — see
// SparkFileMentions.jsx), pre-filters the list to sparks linked to that
// file instead of by category, and shows a "clear filter" chip.
const SparksPanel = React.memo(function SparksPanel({ token, sparks, categoryTree, busy, addSparkCapture, deleteSpark, filesMeta, getBody, onOpenNote, focusFileId, onClearFocusFile, autoOpenCapture }) {
  const [activeCategory, setActiveCategory] = useState(null);
  const [captureOpen, setCaptureOpen] = useState(!!autoOpenCapture);

  const visible = useMemo(() => {
    let list = sparks;
    if (focusFileId) {
      list = list.filter((s) => (s.linkedFileIds || []).includes(focusFileId));
    } else if (activeCategory) {
      list = list.filter((s) => s.category === activeCategory || s.category.startsWith(`${activeCategory}/`));
    } else {
      return [];
    }
    return list.slice().sort((a, b) => b.createdAt - a.createdAt);
  }, [sparks, activeCategory, focusFileId]);

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Sparks</span>
        <span className="side-panel-count">{sparks.length}</span>
        <button className="icon-btn" title="New spark" onClick={() => setCaptureOpen((v) => !v)}>
          <IconPlus size={14} />
        </button>
      </div>
      {captureOpen && (
        <div className="spark-capture-panel">
          <SparkCaptureForm
            sparks={sparks}
            filesMeta={filesMeta}
            getBody={getBody}
            busy={busy}
            autoFocus={autoOpenCapture}
            canAttachScreenshot={!isProxy(token)}
            onSubmit={async (payload) => {
              await addSparkCapture(payload);
            }}
          />
        </div>
      )}
      {focusFileId && (
        <div className="spark-focus-banner">
          Showing sparks linked to this file
          <button className="icon-btn" onClick={onClearFocusFile} title="Show all sparks">
            <IconX size={12} />
          </button>
        </div>
      )}
      <div className="side-panel-body spark-panel-body">
        {!focusFileId && (
          <div className="spark-category-list">
            {categoryTree.length === 0 && <p className="muted small empty-hint">No sparks yet. Tap + to capture one.</p>}
            {categoryTree.map(({ path, name, depth, count }) => (
              <button
                key={path}
                className={`tag-row ${activeCategory === path ? 'active' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                title={path}
                onClick={() => setActiveCategory(activeCategory === path ? null : path)}
              >
                <IconZap size={13} className="tag-row-icon" />
                <span className="tag-row-name">{name}</span>
                <span className="tag-row-count">{count}</span>
              </button>
            ))}
          </div>
        )}
        {(activeCategory || focusFileId) && (
          <div className="spark-list">
            {visible.length === 0 && <p className="muted small empty-hint">No sparks here.</p>}
            {visible.map((s) => (
              <div className="spark-row" key={s.id}>
                {s.screenshotFileId && <SparkScreenshotThumb token={token} fileId={s.screenshotFileId} />}
                <div className="spark-row-body">
                  {s.text && <div className="spark-row-text">{s.text}</div>}
                  <div className="spark-row-meta">
                    <span className="spark-row-category">{s.category}</span>
                    {(s.linkedFileIds || []).map((fid) => {
                      const f = filesMeta.find((ff) => ff.id === fid);
                      if (!f) return null;
                      return (
                        <button key={fid} className="spark-chip" onClick={() => onOpenNote(fid)}>
                          <IconLink2 size={10} />
                          {f.name.replace(/\.md$/i, '')}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button className="icon-btn spark-delete-btn" title="Delete spark" onClick={() => deleteSpark(s.id)}>
                  {busy ? <IconLoader size={13} /> : <IconTrash size={13} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export { SparksPanel };
