


// ---------------------------------------------------------------------------
// Editor content — the CodeMirror 6 live-preview editor (source) or rendered
// preview for a single open tab. Mode is a per-tab property now, toggled
// from PaneHeader.
//
// ===========================================================================
// CodeMirror 6 live-preview editor
// ===========================================================================
// Replaces the old hand-rolled <textarea> + syntax-highlight overlay. Two
// layers of "WYSIWYG" live here:
//
//  1. Inline marks (**bold**, *italic*, [[wikilinks]], #tags, ==highlight==,
//     `code`) are decorated in place by `buildInlinePreviewPlugin`. Marker
//     characters are hidden on every line except the one the cursor is
//     currently on, so a token always drops back to raw, editable markdown
//     the moment you touch it — the same "line reveals its own source"
//     model Obsidian's Live Preview uses. Only `view.visibleRanges` are
//     scanned per update (not the whole note), so cost no longer scales
//     with note length the way the old full-note overlay did.
//
//  2. Block constructs that already have a full React renderer — callouts,
//     +++ toggles +++, :::columns-N:::, :::tabs:::, and pipe tables — are
//     swapped for an actual rendered block via `buildBlockWidgetField`
//     whenever the cursor is outside them, reusing `renderMarkdownBlocks`
//     (same component reading view uses) rather than a second parser.
//     Tables get real inline-editable cells (`EditableMarkdownTable`);
//     everything else keeps its existing interactive bits (tab-switching,
//     toggle expand/collapse) because it's the *same* component tree
//     reading view already uses, just mounted as a widget. Clicking any
//     non-interactive part of a rendered block drops it back to raw
//     markdown for editing.
//
// Requires: codemirror, @codemirror/state, @codemirror/view,
// @codemirror/commands, @codemirror/autocomplete (all pulled in by the
// `codemirror` meta-package) — see the install note at the end of this file.
// ---------------------------------------------------------------------------
// Tab / Shift-Tab: indent-outdent whole lines touched by the selection.
// Ported 1:1 from the old textarea implementation's line-based indent so
// list nesting behaves identically.
function cmLeadingWhitespaceLen(text) {
  const m = /^[ \t]*/.exec(text);
  return m[0].length;
}


function cmIndentSelection(view, outdent) {
  const { state } = view;
  const seenLines = new Set();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let ln = startLine; ln <= endLine; ln++) seenLines.add(ln);

    // Carry along any lines "wrapped" under the first touched line — a
    // list item's nested children or a paragraph's continuation lines —
    // so indenting/outdenting a parent line moves its whole subtree with
    // it instead of leaving deeper lines behind at their old indent.
    // These are the subsequent lines whose leading whitespace is deeper
    // than the anchor line's, stopping at the first blank line or the
    // first line back at (or above) the anchor's own indent.
    const anchorIndent = cmLeadingWhitespaceLen(state.doc.line(startLine).text);
    for (let ln = endLine + 1; ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      if (!line.text.trim()) break;
      if (cmLeadingWhitespaceLen(line.text) <= anchorIndent) break;
      seenLines.add(ln);
    }
  }
  const changes = [];
  for (const ln of Array.from(seenLines).sort((a, b) => a - b)) {
    const line = state.doc.line(ln);
    if (outdent) {
      const m = /^( {1,2}|\t)/.exec(line.text);
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
    } else {
      changes.push({ from: line.from, to: line.from, insert: '  ' });
    }
  }
  if (changes.length) view.dispatch({ changes, scrollIntoView: true });
  return true;
}

export { cmLeadingWhitespaceLen, cmIndentSelection };
