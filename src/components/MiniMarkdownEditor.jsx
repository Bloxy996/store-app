import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';

import { buildInlinePreviewPlugin } from '../features/editor/inlinePreviewPlugin.js';
import { wikilinkTagCompletionSource } from '../features/editor/wikilinkCompletion.js';


// A small, self-contained CodeMirror instance for editing markdown "in
// place" somewhere that isn't a note pane — a database cell, a canvas text
// card. Deliberately NOT CodeMirrorNoteEditor (features/editor/): that one
// owns a whole pane's undo-history-per-file lifecycle, active-pane focus
// wiring, and line-nav plumbing, none of which apply to a cell/card that
// mounts fresh on every edit and unmounts on commit. What both actually
// need is shared here instead of duplicated:
//  - buildInlinePreviewPlugin (coloring/formatting-as-you-type — bold,
//    headings, callouts, wikilinks, etc.) is reused completely unmodified;
//    it's already a pure function of the document with no note-pane
//    context, so it works exactly the same here.
//  - wikilinkTagCompletionSource is reused too; its ctx only needs 3 of the
//    5 getters the full note editor gives it (getLinkIndex/
//    getPhantomRecords/getAllTags — getHandlers/getFoldState are unused by
//    that source), so phantomRecords (the "create new note" suggestions)
//    is the only thing intentionally not wired up here — callers of this
//    component don't have it threaded down to them, and wikilink
//    completion degrades gracefully to "existing notes only" without it.
//
// Commits only on blur or Escape, never per keystroke — same as the plain
// <textarea>/<input> this replaces, so a cell/card edit doesn't push a
// Drive save on every character typed.
function MiniMarkdownEditor({ value, onCommit, placeholderText, linkIndex, allTags, autoFocus = true, className = '' }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const ctxRef = useRef(null);

  if (!ctxRef.current) {
    ctxRef.current = { getLinkIndex: () => linkIndex, getPhantomRecords: () => null, getAllTags: () => allTags };
  }
  ctxRef.current.getLinkIndex = () => linkIndex;
  ctxRef.current.getAllTags = () => allTags;

  // Mount-only: this component's whole lifetime IS one edit session (parent
  // renders it only while `editing` is true and unmounts it on commit), so
  // there's no separate "file changed, recreate state" case to handle the
  // way the full note editor does.
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const ctx = ctxRef.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value || '',
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          cmPlaceholder(placeholderText || 'Type markdown…'),
          autocompletion({ override: [wikilinkTagCompletionSource(ctx)], activateOnTyping: true }),
          buildInlinePreviewPlugin(),
          EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on' }),
          keymap.of([
            { key: 'Mod-z', run: cmUndo },
            { key: 'Mod-y', mac: 'Mod-Shift-z', run: cmRedo },
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap
          ]),
          EditorView.theme({ '&': { height: '100%' }, '.cm-content': { padding: 0 } })
        ]
      })
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      className={`cm-editor-host cm-mini-editor ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Stop Delete/Backspace/Escape/etc. from reaching whatever
        // keyboard-shortcut handler owns the surrounding surface (canvas
        // node deletion, database row navigation, ...) — same reason the
        // plain <textarea>/<input> it replaces always did this.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          viewRef.current?.contentDOM.blur();
        }
      }}
      onBlur={() => onCommit(viewRef.current ? viewRef.current.state.doc.toString() : value || '')}
    />
  );
}

export { MiniMarkdownEditor };
