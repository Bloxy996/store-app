import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';

import { isTableSeparatorRow, renderMarkdownBlocks, splitTableRow, tableColAlign } from '../../lib/markdownRender.jsx';


// ---------------------------------------------------------------------------
// Block-level WYSIWYG: tables, callouts, toggles, columns, tabs.
// ---------------------------------------------------------------------------

// Mirrors the block-detection rules in `renderMarkdownBlocks` (see the
// heading/quote/toggleOpen/columnsOpen/tabsOpen/isTableStart checks above)
// so a range found here always self-renders correctly when its raw text is
// handed to that function standalone.
function findWysiwygBlockRanges(lines) {
  const ranges = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      if (!inFence && (lang === 'query' || lang === 'dataview')) {
        let j = i + 1;
        while (j < lines.length && !/^```/.test(lines[j].trim())) j++;
        ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'query' });
        i = j + 1;
        continue;
      }
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }
    if (/^>/.test(line)) {
      let j = i;
      while (j < lines.length && /^>/.test(lines[j])) j++;
      const first = lines[i].replace(/^>\s?/, '');
      if (/^\[![a-zA-Z]+\]/.test(first)) ranges.push({ startLine: i, endLine: j - 1, kind: 'callout' });
      i = j;
      continue;
    }
    if (/^\+\+\+\s?/.test(line) && trimmed !== '+++') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '+++') j++;
      if (j < lines.length) {
        ranges.push({ startLine: i, endLine: j, kind: 'toggle' });
        i = j + 1;
        continue;
      }
    }
    const columnsOpen = trimmed.match(/^:::columns-([234])\s*$/);
    if (columnsOpen) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'columns' });
      i = j + 1;
      continue;
    }
    if (trimmed === ':::tabs') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'tabs' });
      i = j + 1;
      continue;
    }
    const isTableStart =
      !/^#{1,6}\s/.test(line) &&
      line.includes('|') &&
      trimmed !== '' &&
      i + 1 < lines.length &&
      isTableSeparatorRow(lines[i + 1]);
    if (isTableStart) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') j++;
      ranges.push({ startLine: i, endLine: j - 1, kind: 'table' });
      i = j;
      continue;
    }
    i++;
  }
  return ranges;
}


function parseMarkdownTableRaw(raw) {
  const lines = raw.split('\n');
  const header = splitTableRow(lines[0]);
  const aligns = splitTableRow(lines[1] || '').map(tableColAlign);
  const rows = lines.slice(2).filter((l) => l.trim() !== '').map(splitTableRow);
  return { header, aligns, rows };
}


function buildMarkdownTableRaw({ header, aligns, rows }) {
  const alignMark = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
  const escape = (s) => (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const headerLine = `| ${header.map(escape).join(' | ')} |`;
  const sepLine = `| ${header.map((_, i) => alignMark(aligns[i])).join(' | ')} |`;
  const bodyLines = rows.map((r) => `| ${header.map((_, i) => escape(r[i])).join(' | ')} |`);
  return [headerLine, sepLine, ...bodyLines].join('\n');
}


// Real inline-editable table — the flagship "WYSIWYG" ask. Every cell is a
// contentEditable span; on blur the whole table's markdown is rebuilt from
// the DOM and swapped into the document via `onCommit`, which the widget
// wires straight to a CodeMirror transaction (see MarkdownBlockWidget).
function EditableMarkdownTable({ raw, onCommit }) {
  const parsed = useMemo(() => parseMarkdownTableRaw(raw), [raw]);
  const commit = (next) => onCommit(buildMarkdownTableRaw(next));
  const setCell = (ri, ci, text) => {
    const rows = parsed.rows.map((r) => r.slice());
    while (rows[ri].length < parsed.header.length) rows[ri].push('');
    rows[ri][ci] = text;
    commit({ ...parsed, rows });
  };
  const setHeader = (ci, text) => {
    const header = parsed.header.slice();
    header[ci] = text;
    commit({ ...parsed, header });
  };
  const addRow = () => commit({ ...parsed, rows: [...parsed.rows, parsed.header.map(() => '')] });
  const addCol = () =>
    commit({
      header: [...parsed.header, 'Column'],
      aligns: [...parsed.aligns, null],
      rows: parsed.rows.map((r) => [...r, ''])
    });
  const delRow = (ri) => commit({ ...parsed, rows: parsed.rows.filter((_, i) => i !== ri) });
  const delCol = (ci) =>
    commit({
      header: parsed.header.filter((_, i) => i !== ci),
      aligns: parsed.aligns.filter((_, i) => i !== ci),
      rows: parsed.rows.map((r) => r.filter((_, i) => i !== ci))
    });
  const cycleAlign = (ci) => {
    const order = [null, 'center', 'right', 'left'];
    const next = order[(order.indexOf(parsed.aligns[ci] || null) + 1) % order.length];
    const aligns = parsed.aligns.slice();
    aligns[ci] = next;
    commit({ ...parsed, aligns });
  };
  const stopEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return (
    <table className="md-table cm-editable-table" data-cm-interactive="true">
      <thead>
        <tr>
          {parsed.header.map((h, ci) => (
            <th key={ci} style={parsed.aligns[ci] ? { textAlign: parsed.aligns[ci] } : undefined}>
              <span
                contentEditable
                suppressContentEditableWarning
                className="cm-table-cell-edit"
                onBlur={(e) => setHeader(ci, e.currentTarget.textContent)}
                onKeyDown={stopEnter}
              >
                {h}
              </span>
              <span className="cm-table-col-btns">
                <button type="button" title="Cycle alignment" onMouseDown={(e) => { e.preventDefault(); cycleAlign(ci); }}>
                  ⇔
                </button>
                <button type="button" title="Delete column" onMouseDown={(e) => { e.preventDefault(); delCol(ci); }}>
                  ×
                </button>
              </span>
            </th>
          ))}
          <th className="cm-table-add-col">
            <button type="button" title="Add column" onMouseDown={(e) => { e.preventDefault(); addCol(); }}>
              +
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {parsed.rows.map((row, ri) => (
          <tr key={ri}>
            {parsed.header.map((_, ci) => (
              <td key={ci} style={parsed.aligns[ci] ? { textAlign: parsed.aligns[ci] } : undefined}>
                <span
                  contentEditable
                  suppressContentEditableWarning
                  className="cm-table-cell-edit"
                  onBlur={(e) => setCell(ri, ci, e.currentTarget.textContent)}
                  onKeyDown={stopEnter}
                >
                  {row[ci] ?? ''}
                </span>
              </td>
            ))}
            <td className="cm-table-row-btn">
              <button type="button" title="Delete row" onMouseDown={(e) => { e.preventDefault(); delRow(ri); }}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={parsed.header.length + 1}>
            <button type="button" className="cm-table-add-row" onMouseDown={(e) => { e.preventDefault(); addRow(); }}>
              + Add row
            </button>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}


// A single rendered block, mounted as a CodeMirror block widget. Non-table
// blocks reuse `renderMarkdownBlocks` verbatim (the reading-view renderer),
// so toggle expand/collapse and tab-switching already work — their
// `onMutateBlock` calls are translated from block-relative text offsets
// into an absolute CodeMirror transaction here. Clicking anywhere that
// isn't itself interactive (`[data-cm-interactive]`) drops the block back
// to raw markdown for editing.
class MarkdownBlockWidget extends WidgetType {
  constructor(raw, from, to, keyBase, ctx, kind) {
    super();
    this.raw = raw;
    this.from = from;
    this.to = to;
    this.keyBase = keyBase;
    this.ctx = ctx;
    this.kind = kind;
  }
  eq(other) {
    return other.raw === this.raw && other.from === this.from && other.to === this.to && other.kind === this.kind;
  }
  toDOM() {
    const dom = document.createElement('div');
    dom.className = `cm-wysiwyg-block cm-wysiwyg-${this.kind}`;
    const root = createRoot(dom);
    this._root = root;

    const replaceRange = (from, to, insert) => {
      const view = this.ctx.getView();
      if (!view) return;
      view.dispatch({ changes: { from, to, insert } });
    };
    const onMutateBlock = (oldBlockText, newBlockText) => {
      const at = this.raw.indexOf(oldBlockText);
      if (at === -1) return;
      replaceRange(this.from + at, this.from + at + oldBlockText.length, newBlockText);
    };
    const revealRaw = (evt) => {
      if (evt.target.closest && evt.target.closest('[data-cm-interactive]')) return;
      const view = this.ctx.getView();
      if (!view) return;
      evt.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    };

    if (this.kind === 'table') {
      root.render(<EditableMarkdownTable raw={this.raw} onCommit={(newRaw) => replaceRange(this.from, this.to, newRaw)} />);
    } else {
      root.render(
        <div onMouseDown={revealRaw} className="cm-block-generic">
          {renderMarkdownBlocks(
            this.raw,
            { ...this.ctx.getHandlers(), onMutateBlock },
            this.ctx.getLinkIndex(),
            this.keyBase,
            this.ctx.getFoldState()
          )}
        </div>
      );
    }
    return dom;
  }
  destroy(dom) {
    const root = this._root;
    // Unmounting synchronously from inside CodeMirror's own DOM-update pass
    // triggers a React "cannot update a component while rendering" warning;
    // deferring one tick sidesteps it without any visible flicker.
    setTimeout(() => root && root.unmount(), 0);
  }
  ignoreEvent() {
    return true;
  }
}


function buildBlockWidgetPlugin(ctx) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.cachedText = null;
        this.cachedRanges = [];
        this.decorations = this.build(view);
      }
      update(update) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const doc = view.state.doc;
        const text = doc.toString();
        if (text !== this.cachedText) {
          this.cachedText = text;
          this.cachedRanges = findWysiwygBlockRanges(text.split('\n'));
        }
        const sel = view.state.selection.main;
        const selStartLine = doc.lineAt(sel.from).number - 1;
        const selEndLine = doc.lineAt(sel.to).number - 1;
        const builder = new RangeSetBuilder();
        for (const r of this.cachedRanges) {
          if (selEndLine >= r.startLine && selStartLine <= r.endLine) continue; // cursor inside: show raw source
          const fromLine = doc.line(r.startLine + 1);
          const toLine = doc.line(r.endLine + 1);
          const raw = doc.sliceString(fromLine.from, toLine.to);
          const widget = new MarkdownBlockWidget(raw, fromLine.from, toLine.to, `cmblk-${r.startLine}-`, ctx, r.kind);
          builder.add(fromLine.from, toLine.to, Decoration.replace({ widget, block: true }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export { findWysiwygBlockRanges, parseMarkdownTableRaw, buildMarkdownTableRaw, EditableMarkdownTable, MarkdownBlockWidget, buildBlockWidgetPlugin };
