import { useMemo, useState } from 'react';

import { IconEdit, IconEye } from '../../components/icons.jsx';
import { EditorContent } from '../editor/EditorContent.jsx';

// ---------------------------------------------------------------------------
// The single-tab, single-pane shell used inside a popped-out note's own
// browser window (see PopoutWindow.jsx). Deliberately not PaneHeader/
// TabBar — there's nothing to tab between or split here, just the one
// note — but it still needs its own edit/reading-view toggle, since the
// main window's PaneHeader (where that control normally lives) isn't
// present in this window.
//
// `handlers` is the exact same object App.jsx hands to every pane, minus
// the two single-slot registrations (`onEditorSelectionChange`,
// `registerActiveEditorNav`) that assume there's only ever one "active"
// pane in the main window — wired here they'd fight with whichever pane
// really is active over there for the main window's status bar / Outline
// panel. Everything else (onOpenById, tag/wikilink handling, attachment
// uploads, frontmatter schema, ...) is untouched, so the note is fully
// editable exactly as it is in the main app. One consequence worth being
// upfront about: clicking a [[wikilink]] here still opens the target note
// back in the main window's active pane, not in this one — this window
// owns no pane tree of its own, only ever this one note.
// ---------------------------------------------------------------------------
function PopoutNotePane({ file, buffer, onChange, linkIndex, phantomRecords, handlers, backlinkIndex, allFiles, getBody, pendingRowOpen, onConsumeRowOpen }) {
  const [mode, setMode] = useState('edit');
  const popoutHandlers = useMemo(
    () => ({ ...handlers, onEditorSelectionChange: undefined, registerActiveEditorNav: undefined }),
    [handlers]
  );

  return (
    <div className="popout-note-pane">
      <div className="popout-note-toolbar">
        {file.kind === 'note' && (
          <button
            className="icon-btn"
            onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
            title={mode === 'edit' ? 'Switch to reading view' : 'Switch to editing view'}
          >
            {mode === 'edit' ? <IconEye size={15} /> : <IconEdit size={15} />}
          </button>
        )}
      </div>
      <EditorContent
        file={file}
        content={buffer?.content || ''}
        onChange={onChange}
        linkIndex={linkIndex}
        phantomRecords={phantomRecords}
        handlers={popoutHandlers}
        mode={mode}
        loadingNote={!!buffer?.loading}
        backlinkIndex={backlinkIndex}
        allFiles={allFiles}
        getBody={getBody}
        isActivePane={false}
        pendingRowOpen={pendingRowOpen}
        onConsumeRowOpen={onConsumeRowOpen}
      />
    </div>
  );
}

export { PopoutNotePane };
