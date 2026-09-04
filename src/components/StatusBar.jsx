import { IconAlertTriangle, IconCheck, IconLoader } from './icons.jsx';
import { parseFrontmatter } from '../lib/markdownParse.js';


// ---------------------------------------------------------------------------
// Status bar — global footer reflecting the currently focused pane's file:
// word count, character count, backlink count, property count, plus a
// small live sync indicator on the far right.
// ---------------------------------------------------------------------------
function StatusBar({ file, content, backlinkCount, syncing, syncError, dirty, saving, selectionText }) {
  const { properties, body } = parseFrontmatter(content || '');
  const hasSelection = !!selectionText && selectionText.trim().length > 0;
  const countSource = hasSelection ? selectionText : body;
  const words = countSource.trim() ? countSource.trim().split(/\s+/).length : 0;
  const chars = countSource.length;

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        {file && (
          <>
            <span>{backlinkCount} backlink{backlinkCount === 1 ? '' : 's'}</span>
            <span>{properties.length} propert{properties.length === 1 ? 'y' : 'ies'}</span>
            <span>{hasSelection ? 'Selected: ' : ''}{words} word{words === 1 ? '' : 's'}</span>
            <span>{chars} character{chars === 1 ? '' : 's'}</span>
            {file.kind === 'note' && (
              <span className="status-save-state" title={saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}>
                {saving ? <IconLoader size={12} /> : dirty ? null : <IconCheck size={12} />}
              </span>
            )}
          </>
        )}
      </div>
      <div className="status-bar-right">
        {syncError && (
          <span className="status-sync-error" title={syncError}>
            <IconAlertTriangle size={13} />
          </span>
        )}
        <span className={`status-sync-dot ${syncing ? 'syncing' : ''}`} title={syncing ? 'Syncing…' : 'Synced with Drive'} />
      </div>
    </footer>
  );
}

export { StatusBar };
