import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

import { InlineMentions } from '../../components/InlineMentions.jsx';
import { PropertiesPanel } from '../../components/PropertiesPanel.jsx';
import { AssetPane } from '../assets/AssetPane.jsx';
import { CodeMirrorNoteEditor } from './CodeMirrorNoteEditor.jsx';
import { NoteTitleField } from './NoteTitleField.jsx';
import { parseFrontmatter } from '../../lib/markdownParse.js';
import { renderMarkdownBlocks } from '../../lib/markdownRender.jsx';

// Code-split: most sessions spend their whole time in plain markdown notes
// and never open a .base or .canvas file. Loading these two feature-sized
// views (and everything they pull in — cell editors, the board renderer,
// the force layout, ...) only when a file of that kind is actually opened
// keeps them out of the note-editing hot path's bundle. See CLAUDE.md
// "Mobile performance & bundle size".
const DatabaseView = lazy(() => import('../database/DatabaseView.jsx').then((m) => ({ default: m.DatabaseView })));
const CanvasView = lazy(() => import('../canvas/CanvasView.jsx').then((m) => ({ default: m.CanvasView })));


function EditorContent({ file, content, onChange, linkIndex, phantomRecords, handlers, mode, loadingNote, backlinkIndex, allFiles, getBody, isActivePane }) {
  // Heading fold state (reading-view only), keyed by heading id, reset per
  // note so collapsing a section in one note doesn't leak into another.
  const [collapsedHeadings, setCollapsedHeadings] = useState(() => new Set());
  const collapsedHeadingsFileRef = useRef(file?.id);
  if (collapsedHeadingsFileRef.current !== file?.id) {
    collapsedHeadingsFileRef.current = file?.id;
    // Reset synchronously on file change (avoids a stale-collapse flash).
    if (collapsedHeadings.size) setCollapsedHeadings(new Set());
  }
  // Toggle-block collapse state (`+++ Title` ... `+++`), same per-note reset
  // rule and same "absent = expanded" convention as heading folds above.
  const [collapsedToggles, setCollapsedToggles] = useState(() => new Set());
  const collapsedTogglesFileRef = useRef(file?.id);
  if (collapsedTogglesFileRef.current !== file?.id) {
    collapsedTogglesFileRef.current = file?.id;
    if (collapsedToggles.size) setCollapsedToggles(new Set());
  }
  const foldState = useMemo(
    () => ({
      collapsed: collapsedHeadings,
      onToggle: (headingId) =>
        setCollapsedHeadings((prev) => {
          const next = new Set(prev);
          if (next.has(headingId)) next.delete(headingId);
          else next.add(headingId);
          return next;
        }),
      collapsedToggles,
      onToggleToggle: (toggleId) =>
        setCollapsedToggles((prev) => {
          const next = new Set(prev);
          if (next.has(toggleId)) next.delete(toggleId);
          else next.add(toggleId);
          return next;
        })
    }),
    [collapsedHeadings, collapsedToggles]
  );

  // Selection-based word/char count (status bar) only makes sense while
  // there's an actual editor selection to reflect — clear it whenever we
  // leave edit mode or switch notes, so the status bar doesn't keep
  // showing counts for a selection that no longer exists on screen.
  //
  // `handlers` is a plain object rebuilt (new identity) on lots of
  // unrelated App-level state changes (typing, vault-index progress,
  // sync ticks, ...). It used to sit directly in these effects' deps —
  // which meant nearly any keystroke or background tick re-ran the
  // effect, and its cleanup (`onEditorSelectionChange(null)`) fired in
  // between, instantly wiping out a just-set selection count back to the
  // whole-note number. Stashing the latest handlers in a ref and keying
  // the effects only on `file?.id`/`mode` fixes that: the count now stays
  // until the file/mode actually changes or the selection itself clears.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    return () => handlersRef.current.onEditorSelectionChange?.(null);
  }, [file?.id, mode]);

  // Reading view has no CodeMirror to report selection changes for it, so
  // mirror the same status-bar behavior here off the browser's native
  // selection: any highlight made inside the preview pane updates the
  // word/char count, clearing back to the whole-note count once the
  // highlight is gone.
  const previewRef = useRef(null);
  useEffect(() => {
    if (mode === 'edit') return undefined;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const text = sel && sel.rangeCount && !sel.isCollapsed ? sel.toString() : '';
      if (text.trim() && previewRef.current && previewRef.current.contains(sel.anchorNode)) {
        handlersRef.current.onEditorSelectionChange?.(text);
      } else {
        handlersRef.current.onEditorSelectionChange?.(null);
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [mode, file?.id]);

  // Table-of-contents navigation bridge — registers a scroll-to-heading
  // function for this pane while it's the active one, so the Outline panel
  // can jump to a heading regardless of whether this pane is currently in
  // edit or reading view.
  const cmNavRef = useRef(null);
  useEffect(() => {
    if (!isActivePane || !file) return undefined;
    const scrollToHeading = (lineIndex, headingId) => {
      if (mode === 'edit') {
        cmNavRef.current?.scrollToLine(lineIndex);
      } else {
        const el = document.getElementById(headingId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    handlers.registerActiveEditorNav?.(scrollToHeading);
    return () => handlers.registerActiveEditorNav?.(null);
  }, [isActivePane, file, mode, handlers]);

  if (!file) {
    return (
      <div className="editor-empty">
        <p className="muted">Select a note, or click a [[wikilink]] to create one.</p>
      </div>
    );
  }

  if (file.kind === 'database') {
    return (
      <Suspense fallback={<div className="note-loading-bar" aria-hidden="true" />}>
        <DatabaseView
          file={file}
          content={content}
          onChange={(value) => onChange(value)}
          handlers={handlers}
          linkIndex={linkIndex}
          loading={loadingNote}
        />
      </Suspense>
    );
  }

  if (file.kind === 'canvas') {
    return (
      <Suspense fallback={<div className="note-loading-bar" aria-hidden="true" />}>
        <CanvasView
          file={file}
          content={content}
          onChange={(value) => onChange(value)}
          handlers={handlers}
          linkIndex={linkIndex}
          loading={loadingNote}
          allFiles={allFiles}
        />
      </Suspense>
    );
  }

  if (file.kind !== 'note') {
    return <AssetPane token={handlers.token} file={file} />;
  }

  const { properties, body } = parseFrontmatter(content);

  // Lets a block rendered from `body` (currently just the tabs block) push
  // an edit back to disk without knowing its own absolute position: it
  // hands back its exact original source text and its replacement, and
  // this finds-and-swaps that one substring within `body`, then reattaches
  // the untouched frontmatter prefix before saving. `body` is always the
  // tail of `content` (see parseFrontmatter), so slicing by length is safe.
  const onMutateBlock = (oldBlockText, newBlockText) => {
    const at = body.indexOf(oldBlockText);
    if (at === -1) return;
    const newBody = body.slice(0, at) + newBlockText + body.slice(at + oldBlockText.length);
    const prefixLen = content.length - body.length;
    onChange(content.slice(0, prefixLen) + newBody);
  };
  const readingHandlers = { ...handlers, onMutateBlock, getBody };

  return (
    <div className="editor-panes">
      {loadingNote && <div className="note-loading-bar" aria-hidden="true" />}
      {mode === 'edit' ? (
        <div className="editor-textarea-wrap">
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <CodeMirrorNoteEditor
            fileId={file.id}
            content={content}
            onChange={onChange}
            linkIndex={linkIndex}
            phantomRecords={phantomRecords}
            allTags={handlers.allTags || []}
            handlers={readingHandlers}
            foldState={foldState}
            isActivePane={isActivePane}
            onSelectionChange={handlers.onEditorSelectionChange}
            registerNav={(api) => {
              cmNavRef.current = api;
            }}
          />
        </div>
      ) : (
        <div className="editor-preview" ref={previewRef}>
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <PropertiesPanel properties={properties} handlers={handlers} linkIndex={linkIndex} />
          {renderMarkdownBlocks(body, readingHandlers, linkIndex, '', foldState)}
          <InlineMentions
            file={linkIndex.records.find((r) => r.id === file.id) || file}
            linkIndex={linkIndex}
            getBody={getBody}
            backlinkFileIds={Array.from(backlinkIndex.get(file.id) || [])}
            allFiles={allFiles}
            onOpenNote={handlers.onOpenById}
          />
        </div>
      )}
    </div>
  );
}

export { EditorContent };
