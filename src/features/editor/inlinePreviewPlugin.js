import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';

import { TaskCheckboxWidget } from './TaskCheckboxWidget.js';


// Per-line inline decorations: heading sizing, marker-hiding for bold /
// italic / strike / highlight / code / wikilinks / tags / md-links, and the
// live checkbox widget above. Runs only over visible lines.
function buildInlinePreviewPlugin() {
  const MARK_RULES = [
    { re: /\*\*([^*\n]+)\*\*/g, markLen: 2, cls: 'cm-bold' },
    { re: /__([^_\n]+)__/g, markLen: 2, cls: 'cm-bold' },
    { re: /~~([^~\n]+)~~/g, markLen: 2, cls: 'cm-strike' },
    { re: /==([^=\n]+)==/g, markLen: 2, cls: 'cm-highlight' },
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
  function decorateLine(out, line, isActiveLine, doc) {
    const text = line.text;
    const trimmed = text.trim();

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

    // Code fence delimiter (``` or ~~~) — dim just the backticks/tildes,
    // same as heading '#'s, leaving any language tag its normal color.
    const fence = /^( {0,3})(`{3,}|~{3,})/.exec(text);
    if (fence) {
      const markerFrom = line.from + fence[1].length;
      const markerTo = markerFrom + fence[2].length;
      out.push({ from: markerFrom, to: markerTo, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Task checkbox — always live, regardless of cursor line.
    const task = /^(\s*(?:[-*+]\s+))\[( |x|X)\]/.exec(text);
    if (task) {
      const boxFrom = line.from + task[1].length;
      out.push({ from: boxFrom, to: boxFrom + 3, deco: Decoration.replace({ widget: new TaskCheckboxWidget(/[xX]/.test(task[2])) }) });
    }

    // Unordered list marker (-, *, +) — dim it like other syntax markers.
    // Skipped for thematic-break lines, which already matched the rule
    // above and aren't really list items.
    if (!hr) {
      const listMarker = /^(\s*)([-*+])(\s+)/.exec(text);
      if (listMarker) {
        const markerFrom = line.from + listMarker[1].length;
        out.push({ from: markerFrom, to: markerFrom + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
    }

    // Wikilinks / tags / md-links / bold / italic / etc. Hide marker chars
    // unless this is the active line, in which case just style them.
    const inlineFrom = task ? line.from + task[0].length : line.from;
    const inlineText = text.slice(inlineFrom - line.from);

    const wikiRe = /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g;
    let m;
    while ((m = wikiRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const targetLen = m[1].length;
      if (!isActiveLine) {
        out.push({ from, to: from + 2, deco: Decoration.replace({}) });
        out.push({ from: from + 2 + targetLen, to: from + m[0].length, deco: Decoration.replace({}) });
      } else {
        out.push({ from, to: from + 2, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: from + m[0].length - 2, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
      out.push({ from: from + 2, to: from + 2 + targetLen, deco: Decoration.mark({ class: 'cm-wikilink' }) });
      if (m[2]) out.push({ from: from + 2 + targetLen + 1, to: from + m[0].length - 2, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }

    const mdLinkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    while ((m = mdLinkRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const labelLen = m[1].length;
      if (!isActiveLine) {
        out.push({ from, to: from + 1, deco: Decoration.replace({}) });
        out.push({ from: from + 1 + labelLen, to: from + m[0].length, deco: Decoration.replace({}) });
      } else {
        out.push({ from, to: from + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: from + 1 + labelLen, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
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
        if (!isActiveLine) {
          out.push({ from, to: from + rule.markLen, deco: Decoration.replace({}) });
          out.push({ from: to - rule.markLen, to, deco: Decoration.replace({}) });
        } else {
          out.push({ from, to: from + rule.markLen, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
          out.push({ from: to - rule.markLen, to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        }
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
        const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        const lines = [];
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            lines.push(line);
            pos = line.to + 1;
          }
        }
        lines.sort((a, b) => a.from - b.from);
        const entries = [];
        for (const line of lines) {
          decorateLine(entries, line, line.number === cursorLine, view.state.doc);
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
