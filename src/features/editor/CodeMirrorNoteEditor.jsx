import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';

import { cmIndentSelection } from './cmIndent.js';
import { buildInlinePreviewPlugin } from './inlinePreviewPlugin.js';
import { wikilinkTagCompletionSource } from './wikilinkCompletion.js';


// ---------------------------------------------------------------------------
// The editor component. Recreates its EditorState (and undo history) only
// when the open file changes — same page-per-note undo boundary the old
// custom undo hook had — and treats `content` as an externally-controlled
// value: doc replaces only happen when `content` changed for a reason other
// than this editor's own last edit, so external updates (initial load,
// rename-triggered reload) never fight the user's cursor.
// ---------------------------------------------------------------------------
function CodeMirrorNoteEditor({ fileId, content, onChange, linkIndex, phantomRecords, allTags, handlers, foldState, onSelectionChange, isActivePane, registerNav }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const lastEmittedRef = useRef(content);
  const ctxRef = useRef(null);

  if (!ctxRef.current) {
    ctxRef.current = {
      getView: () => viewRef.current,
      getLinkIndex: () => linkIndex,
      getPhantomRecords: () => phantomRecords,
      getAllTags: () => allTags,
      getHandlers: () => handlers,
      getFoldState: () => foldState
    };
  }
  ctxRef.current.getLinkIndex = () => linkIndex;
  ctxRef.current.getPhantomRecords = () => phantomRecords;
  ctxRef.current.getAllTags = () => allTags;
  ctxRef.current.getHandlers = () => handlers;
  ctxRef.current.getFoldState = () => foldState;

  // (Re)create the editor whenever the open file changes.
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const ctx = ctxRef.current;
    const state = EditorState.create({
      doc: content,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        cmPlaceholder(
          'Start writing… [[Note Name]] to link, #tag to tag, > [!tip] for callouts, | tables |, +++ toggles +++, :::columns-2 for columns, :::tabs for a tab block.'
        ),
        autocompletion({ override: [wikilinkTagCompletionSource(ctx)], activateOnTyping: true }),
        buildInlinePreviewPlugin(),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on' }),
        keymap.of([
          { key: 'Mod-z', run: cmUndo },
          { key: 'Mod-y', mac: 'Mod-Shift-z', run: cmRedo },
          { key: 'Tab', run: (v) => cmIndentSelection(v, false) },
          { key: 'Shift-Tab', run: (v) => cmIndentSelection(v, true) },
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            lastEmittedRef.current = text;
            onChange(text);
          }
          if (update.selectionSet) {
            const sel = update.state.selection.main;
            onSelectionChange?.(sel.from !== sel.to ? update.state.sliceDoc(sel.from, sel.to) : null);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: 'var(--editor-font-size, 15px)' },
          '.cm-scroller': { fontFamily: 'var(--editor-font-family, inherit)', lineHeight: '1.6' },
          '.cm-content': { padding: '0 0 40vh 0' }
        })
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    if (registerNav) {
      registerNav({
        scrollToLine: (lineIndex) => {
          const ln = Math.min(view.state.doc.lines, lineIndex + 1);
          const line = view.state.doc.line(ln);
          view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
          view.focus();
        }
      });
    }

    return () => {
      registerNav?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // External content changes (not originating from this editor's own last
  // dispatch) — e.g. switching tabs to a note whose content just finished
  // loading — get pushed in as a doc replace without touching undo history
  // semantics beyond what CodeMirror already does for a full-doc change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === lastEmittedRef.current) return;
    lastEmittedRef.current = content;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    });
  }, [content]);

  useEffect(() => {
    if (isActivePane) viewRef.current?.focus();
  }, [isActivePane, fileId]);

  return <div ref={hostRef} className="cm-editor-host" />;
}

export { CodeMirrorNoteEditor };
