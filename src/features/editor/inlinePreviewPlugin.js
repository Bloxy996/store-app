import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';

import { isTableSeparatorRow } from '../../lib/markdownRender.jsx';


// Per-line inline decorations: heading sizing, and marker-dimming for
// bold / italic / strike / highlight / code / wikilinks / tags / md-links /
// callouts / toggles / columns / tabs / tables / task checkboxes. Editor
// never swaps to a rendered widget for any block type (that only happens
// in reading view, via renderMarkdownBlocks); every bit of markdown syntax
// always stays visible here, just dimmed, the same way a heading's leading
// '#'s are. Runs only over visible lines.
// Length (in raw characters, from column 0) of a list line's marker
// prefix — indent + marker + the whitespace before its text — for lines
// that are list items; null for anything else. Order matters: a task
// checkbox line also matches the bullet pattern, so it's checked first.
// Ordered markers accept both `1.`/`1)` and zero-padded forms like `01)`
// (any run of digits); lettered markers accept `a)`/`A.` etc.
function listPrefixLen(text) {
  const task = /^(\s*[-*+]\s+\[(?: |x|X)\]\s+)/.exec(text);
  if (task) return task[1].length;
  const ordered = /^(\s*\d+[.)]\s+)/.exec(text);
  if (ordered) return ordered[1].length;
  const lettered = /^(\s*[A-Za-z][.)]\s+)/.exec(text);
  if (lettered) return lettered[1].length;
  const bullet = /^(\s*[-*+]\s+)/.exec(text);
  if (bullet) return bullet[1].length;
  return null;
}

function buildInlinePreviewPlugin() {
  const MARK_RULES = [
    { re: /\*\*([^*\n]+)\*\*/g, markLen: 2, cls: 'cm-bold' },
    { re: /__([^_\n]+)__/g, markLen: 2, cls: 'cm-bold' },
    { re: /~~([^~\n]+)~~/g, markLen: 2, cls: 'cm-strike' },
    { re: /==([^=\n]+)==/g, markLen: 2, cls: 'cm-highlight' },
    { re: /\+\+([^+\n]+)\+\+/g, markLen: 2, cls: 'cm-underline' },
    { re: /`([^`\n]+)`/g, markLen: 1, cls: 'cm-inline-code' },
    { re: /(?<![*_\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, markLen: 1, cls: 'cm-italic' },
    { re: /(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g, markLen: 1, cls: 'cm-italic' }
  ];

  // Same color grouping as the reading-view `.callout-*` CSS (see
  // markdownRender.jsx / GraphViewModal.css) so a callout keeps its look
  // while its raw markdown is being edited, instead of the wysiwyg block
  // widget disappearing into plain unstyled text.
  const calloutGroup = (type) => {
    if (/^(warning|caution|attention)$/.test(type)) return 'warn';
    if (/^(danger|error|failure|bug)$/.test(type)) return 'danger';
    if (/^(tip|hint|success|check|done)$/.test(type)) return 'tip';
    return 'note';
  };
  // A callout's type lives only on its first line (`> [!type] Title`); walk
  // upward through the contiguous `>` lines to find it so continuation
  // lines get the same color.
  const findCalloutType = (doc, line) => {
    let n = line.number;
    while (n >= 1) {
      const text = doc.line(n).text;
      if (!/^>/.test(text)) return null;
      const m = /^>\s?\[!([a-zA-Z]+)\]/.exec(text);
      if (m) return m[1].toLowerCase();
      n--;
    }
    return null;
  };

  // Every call pushes {from, to, deco, lineDeco} entries into `out` rather
  // than adding to the RangeSetBuilder directly — the builder requires
  // strictly ascending `from` across the *whole* document, but the several
  // regex passes below (wikilinks, md-links, tags, bold/italic/...) each
  // produce their own ascending-within-themselves sequence that isn't
  // ascending relative to each other. Collecting into a flat array and
  // sorting once before adding (see build(), below) satisfies the
  // builder's ordering requirement regardless of which rule fires where.
  // A contiguous run of non-blank `|` lines whose top row is followed by a
  // valid separator row (`isTableSeparatorRow`) is a table; every row in it
  // — header, separator, body — gets its pipes dimmed the same way.
  const findTableHeaderLine = (doc, line) => {
    let n = line.number;
    while (n > 1) {
      const prevText = doc.line(n - 1).text;
      if (!prevText.includes('|') || prevText.trim() === '') break;
      n--;
    }
    if (n >= doc.lines) return null;
    const headerText = doc.line(n).text;
    if (/^#{1,6}\s/.test(headerText) || !headerText.includes('|') || headerText.trim() === '') return null;
    return isTableSeparatorRow(doc.line(n + 1)?.text || '') ? n : null;
  };

  function decorateLine(out, line, doc, frontmatterEnd) {
    const text = line.text;
    const trimmed = text.trim();

    // Frontmatter (the leading `---`/`---` block) isn't markdown, so it
    // just gets greyed out wholesale like a comment — no heading/list/etc.
    // parsing inside it.
    if (frontmatterEnd && line.number <= frontmatterEnd) {
      out.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      return;
    }

    // Hanging indent: a line's leading whitespace is real, typed text (not
    // stripped), so without help a soft-wrapped continuation resets to
    // column 0. Shifting the whole line's CSS start left by that many `ch`
    // via text-indent, then padding it back out by the same amount, cancels
    // out for the line's own first (real) row but leaves every wrapped row
    // sitting at that padding — i.e. the wrap keeps the line's indent.
    //
    // For list items specifically, the hang point isn't just the leading
    // whitespace — it's wherever the item's actual text starts, past the
    // marker too (`- `, `- [ ] `, `1. `, `01) `, `a) `, ...), so a wrapped
    // line of a bullet lines up under the bullet's text instead of under
    // the bullet character itself. `listPrefixLen` finds that full prefix;
    // plain indented (non-list) lines fall back to just their whitespace.
    const prefixLen = listPrefixLen(text);
    const leadingWs = /^[ \t]*/.exec(text)[0];
    const hangLen = prefixLen != null ? prefixLen : leadingWs.length;
    if (hangLen) {
      const ch = text.slice(0, hangLen).replace(/\t/g, '  ').length;
      out.push({ from: line.from, to: line.from, deco: Decoration.line({ attributes: { style: `padding-left: ${ch}ch; text-indent: -${ch}ch;` } }) });
    }

    // Heading: size the whole line, dim the leading hashes.
    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-heading cm-heading-${heading[1].length}` }) });
      out.push({ from: line.from, to: line.from + heading[1].length + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Blockquote / callout marker. Dimmed like a heading's '#'s — always
    // visible, never hidden — so editing a callout still reads as a
    // callout instead of reverting to bare markdown while focused. The
    // whole line also gets the callout's color as a line decoration, and
    // the `[!type] Title` portion of the first line is bolded to match the
    // rendered widget's title row.
    const quote = /^>\s?/.exec(text);
    if (quote) {
      out.push({ from: line.from, to: line.from + quote[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      const calloutType = findCalloutType(doc, line);
      if (calloutType) {
        const group = calloutGroup(calloutType);
        out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-callout-line cm-callout-${group}` }) });
        const title = /^>\s?\[!([a-zA-Z]+)\]([+-]?)\s*/.exec(text);
        if (title) {
          out.push({ from: line.from + quote[0].length, to: line.from + title[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
          out.push({ from: line.from + title[0].length, to: line.to, deco: Decoration.mark({ class: 'cm-callout-title-text' }) });
        }
      }
    }

    // Toggle (`+++ Title` / closing `+++`) and columns/tabs (`:::columns-N`,
    // `:::tabs`, `:::column`, `:::tab Name`, closing `:::`) delimiters — same
    // "dim, never hide" treatment as a heading's '#'s, so these blocks don't
    // turn into unstyled plain text while their raw markdown is being edited.
    const toggleDelim = /^\+\+\+\s?/.exec(text);
    if (toggleDelim) {
      const to = trimmed === '+++' ? line.to : line.from + toggleDelim[0].length;
      out.push({ from: line.from, to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }
    const tabDelim = /^:::tab\s+/.exec(text);
    if (tabDelim) {
      out.push({ from: line.from, to: line.from + tabDelim[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    } else if (trimmed === ':::' || trimmed === ':::tabs' || trimmed === ':::column' || /^:::columns-[234]$/.test(trimmed)) {
      out.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Thematic break (---, ***, ___) — dim the whole rule line, same
    // treatment as a heading's leading '#' markers.
    const hr = /^ {0,3}([-*_])(?: *\1){2,} *$/.exec(text);
    if (hr) {
      out.push({ from: line.from, to: line.from + text.length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Table pipes and separator row — dim like everything else above.
    if (text.includes('|') && findTableHeaderLine(doc, line) != null) {
      let idx = text.indexOf('|');
      while (idx !== -1) {
        out.push({ from: line.from + idx, to: line.from + idx + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        idx = text.indexOf('|', idx + 1);
      }
      if (isTableSeparatorRow(text)) {
        out.push({ from: line.from, to: line.to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
    }

    // Code fence delimiter (``` or ~~~) — dim just the backticks/tildes,
    // same as heading '#'s, leaving any language tag its normal color.
    const fence = /^( {0,3})(`{3,}|~{3,})/.exec(text);
    if (fence) {
      const markerFrom = line.from + fence[1].length;
      const markerTo = markerFrom + fence[2].length;
      out.push({ from: markerFrom, to: markerTo, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Task checkbox marker — dimmed like every other syntax marker, same
    // "always visible, never hidden, never swapped for a widget" rule as
    // the rest of this file; no live/clickable checkbox in edit mode.
    const task = /^(\s*(?:[-*+]\s+))\[( |x|X)\]/.exec(text);
    if (task) {
      const boxFrom = line.from + task[1].length;
      out.push({ from: boxFrom, to: boxFrom + 3, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // List markers — dimmed like every other syntax marker. Ordered
    // (`1.`/`1)`, leading zeros like `01)` allowed) and lettered
    // (`a)`/`A.`) markers dim the whole marker token; a plain bullet
    // (-, *, +) just dims the single marker character, as before. Skipped
    // on thematic-break lines and task lines (the checkbox rule above
    // already dimmed those markers).
    if (!hr && !task) {
      const orderedMarker = /^(\s*)(\d+[.)])(\s+)/.exec(text);
      const letterMarker = !orderedMarker && /^(\s*)([A-Za-z][.)])(\s+)/.exec(text);
      if (orderedMarker) {
        const markerFrom = line.from + orderedMarker[1].length;
        out.push({ from: markerFrom, to: markerFrom + orderedMarker[2].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      } else if (letterMarker) {
        const markerFrom = line.from + letterMarker[1].length;
        out.push({ from: markerFrom, to: markerFrom + letterMarker[2].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      } else {
        const listMarker = /^(\s*)([-*+])(\s+)/.exec(text);
        if (listMarker) {
          const markerFrom = line.from + listMarker[1].length;
          out.push({ from: markerFrom, to: markerFrom + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        }
      }
    }

    // Wikilinks / tags / md-links / bold / italic / etc. Markers always
    // stay visible (dimmed), never hidden — same rule as every other
    // syntax marker on this page, so nothing you're not actively looking
    // at silently disappears.
    const inlineFrom = task ? line.from + task[0].length : line.from;
    const inlineText = text.slice(inlineFrom - line.from);

    const wikiRe = /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g;
    let m;
    while ((m = wikiRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const targetLen = m[1].length;
      out.push({ from, to: from + 2, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      out.push({ from: from + m[0].length - 2, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      out.push({ from: from + 2, to: from + 2 + targetLen, deco: Decoration.mark({ class: 'cm-wikilink' }) });
      if (m[2]) out.push({ from: from + 2 + targetLen + 1, to: from + m[0].length - 2, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }

    const mdLinkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    while ((m = mdLinkRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const labelLen = m[1].length;
      out.push({ from, to: from + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      out.push({ from: from + 1 + labelLen, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      out.push({ from: from + 1, to: from + 1 + labelLen, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }

    const tagRe = /(^|[\s(])#([\w/-]+)/g;
    while ((m = tagRe.exec(inlineText))) {
      const from = inlineFrom + m.index + m[1].length;
      out.push({ from, to: from + 1 + m[2].length, deco: Decoration.mark({ class: 'cm-tag' }) });
    }

    for (const rule of MARK_RULES) {
      rule.re.lastIndex = 0;
      while ((m = rule.re.exec(inlineText))) {
        const from = inlineFrom + m.index;
        const to = from + m[0].length;
        out.push({ from, to: from + rule.markLen, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: to - rule.markLen, to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: from + rule.markLen, to: to - rule.markLen, deco: Decoration.mark({ class: rule.cls }) });
      }
    }
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const doc = view.state.doc;
        // Computed once per rebuild (not per line) so a frontmatter-less
        // note never pays for a doc-length scan per visible line.
        let frontmatterEnd = 0;
        if (doc.lines >= 2 && doc.line(1).text.trim() === '---') {
          for (let n = 2; n <= doc.lines; n++) {
            if (doc.line(n).text.trim() === '---') {
              frontmatterEnd = n;
              break;
            }
          }
        }
        const lines = [];
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = doc.lineAt(pos);
            lines.push(line);
            pos = line.to + 1;
          }
        }
        lines.sort((a, b) => a.from - b.from);
        const entries = [];
        for (const line of lines) {
          decorateLine(entries, line, doc, frontmatterEnd);
        }
        entries.sort((a, b) => a.from - b.from || a.to - b.to);
        const builder = new RangeSetBuilder();
        for (const e of entries) builder.add(e.from, e.to, e.deco);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export { buildInlinePreviewPlugin };
