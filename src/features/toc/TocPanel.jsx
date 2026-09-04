import React, { useMemo } from 'react';

import { parseFrontmatter } from '../../lib/markdownParse.js';


// ---------------------------------------------------------------------------
// Table of contents / outline panel — Obsidian-style, lists the active
// note's headings, indented by level, click to jump to that heading. Works
// in both edit and reading view via `onNavigate` (see EditorContent /
// App-level `activeEditorNav` for how the actual scrolling happens
// differently in each mode).
// ---------------------------------------------------------------------------
function extractHeadings(content) {
  const { body } = parseFrontmatter(content || '');
  const lines = body.split('\n');
  const headings = [];
  lines.forEach((line, lineIndex) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) return;
    const level = Math.min(m[1].length, 6);
    const text = m[2].trim();
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    headings.push({ level, text, id, lineIndex });
  });
  return headings;
}


const TocPanel = React.memo(function TocPanel({ file, content, onNavigate }) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  if (!file) {
    return (
      <div className="side-panel">
        <div className="side-panel-header">
          <span className="side-panel-title">Outline</span>
        </div>
        <div className="side-panel-body">
          <p className="muted small empty-hint">Open a note to see its outline.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Outline</span>
      </div>
      <div className="side-panel-body toc-panel-body">
        {headings.length === 0 && <p className="muted small empty-hint">No headings in this note yet.</p>}
        {headings.map((h, idx) => (
          <button
            key={`${h.id}-${idx}`}
            className="toc-row"
            style={{ paddingLeft: `${10 + (h.level - 1) * 14}px` }}
            onClick={() => onNavigate(h.lineIndex, h.id)}
            title={h.text}
          >
            {h.text || <span className="muted">Untitled heading</span>}
          </button>
        ))}
      </div>
    </div>
  );
});

//   { type: 'leaf', id, tabs: [{ id, fileId, mode, history, historyIndex }], activeTabId }
//   { type: 'split', id, direction: 'row'|'column', children: [node,...], sizes: [%,...] }
// ---------------------------------------------------------------------------
let uidCounter = 0;

export { extractHeadings, TocPanel };
