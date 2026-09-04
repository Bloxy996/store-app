import React, { useState } from 'react';

import { AmbiguousLink, ImageEmbed } from '../components/LinkEmbeds.jsx';
import { IconAlertTriangle, IconCheck, IconChevronDown, IconChevronRight, IconHelp, IconInfo, IconPlus, IconX } from '../components/icons.jsx';
import { AudioEmbed, FileChip, VideoEmbed } from '../features/assets/AssetPane.jsx';
import { QueryBlock } from '../features/query/QueryBlock.jsx';
import { resolveLinkTarget } from './linkGraph.js';
import { opensInEditorPane } from './vaultConfig.js';


// ---------------------------------------------------------------------------
// Minimal markdown + wikilink + tag renderer (no external markdown dependency)
// ---------------------------------------------------------------------------
function renderInline(text, keyPrefix, handlers, linkIndex) {
  const nodes = [];
  const re =
    /(!?\[\[[^[\]]+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^[\]]+\]\([^()\s]+\))|(\*[^*]+\*)|((?:^|[\s(])#[A-Za-z][A-Za-z0-9_\-/]*)/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    let token = match[0];
    let tokenStart = match.index;
    // The tag alternative captures an optional leading space/paren so the
    // word-boundary check works without lookbehind edge cases — push that
    // leading character back out as plain text before handling the tag.
    if (match[6]) {
      const tagToken = match[6];
      const lead = /^[\s(]/.test(tagToken) ? tagToken[0] : '';
      if (lead) {
        if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
        nodes.push(lead);
        lastIndex = tokenStart + lead.length;
        tokenStart = lastIndex;
        token = tagToken.slice(lead.length);
      }
    }
    if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('[[') || token.startsWith('![[')) {
      const core = token.startsWith('!') ? token.slice(1) : token;
      const inner = core.slice(2, -2);
      const [rawTargetAndHeading, rawAlias] = inner.split('|');
      const rawTarget = rawTargetAndHeading.replace(/#.*$/, '').trim();
      const label = (rawAlias || rawTargetAndHeading).trim();
      const resolution = resolveLinkTarget(rawTarget, linkIndex);

      if (resolution.status === 'resolved' && resolution.file.kind === 'image') {
        nodes.push(
          <ImageEmbed
            key={key}
            token={handlers.token}
            fileId={resolution.file.id}
            name={resolution.file.name}
            caption={rawAlias ? label : null}
            onOpen={() => handlers.onOpenAsset(resolution.file)}
          />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'video') {
        nodes.push(
          <VideoEmbed key={key} token={handlers.token} fileId={resolution.file.id} name={resolution.file.name} />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'audio') {
        nodes.push(
          <AudioEmbed key={key} token={handlers.token} fileId={resolution.file.id} name={resolution.file.name} />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'file') {
        nodes.push(
          <FileChip
            key={key}
            name={resolution.file.name}
            label={rawAlias ? label : null}
            onOpen={() => handlers.onOpenAsset(resolution.file)}
          />
        );
      } else if (resolution.status === 'resolved') {
        nodes.push(
          <span
            key={key}
            className="wikilink"
            onClick={() => handlers.onOpenById(resolution.file.id)}
            title={`Open ${resolution.file.baseName}`}
          >
            {label}
          </span>
        );
      } else if (resolution.status === 'ambiguous') {
        nodes.push(
          <AmbiguousLink
            key={key}
            label={label}
            candidates={resolution.candidates}
            onPick={(file) => (opensInEditorPane(file.kind) ? handlers.onOpenById(file.id) : handlers.onOpenAsset(file))}
          />
        );
      } else if (resolution.isAsset) {
        nodes.push(
          <span key={key} className="wikilink wikilink-missing-image" title={`File not found: ${rawTarget}`}>
            {rawTarget}
          </span>
        );
      } else {
        nodes.push(
          <span
            key={key}
            className="wikilink wikilink-new"
            onClick={() => handlers.onCreateOrOpenByName(rawTarget)}
            title={`Create "${rawTarget}"`}
          >
            {label}
          </span>
        );
      }
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const m = token.match(/^\[([^[\]]+)\]\(([^()\s]+)\)$/);
      nodes.push(
        <a key={key} href={m[2]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>
      );
    } else if (token.startsWith('#')) {
      const tagName = token.slice(1);
      nodes.push(
        <span
          key={key}
          className="tag-chip"
          onClick={() => handlers.onOpenTag && handlers.onOpenTag(tagName)}
          title={`Search #${tagName}`}
        >
          #{tagName}
        </span>
      );
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}


// Cell splitter/detector for GFM-style pipe tables: `| a | b |` rows plus a
// `| --- | :--: |` alignment row directly under the header.
function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

function isTableSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function tableColAlign(cell) {
  if (!cell) return null;
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}


// Obsidian-style callout icon per `[!type]`. Unrecognized types still
// render fine — they just fall back to the plain info glyph.
const CALLOUT_ICONS = {
  note: IconInfo,
  info: IconInfo,
  abstract: IconInfo,
  summary: IconInfo,
  tip: IconCheck,
  hint: IconCheck,
  success: IconCheck,
  check: IconCheck,
  done: IconCheck,
  question: IconHelp,
  help: IconHelp,
  faq: IconHelp,
  warning: IconAlertTriangle,
  caution: IconAlertTriangle,
  attention: IconAlertTriangle,
  danger: IconAlertTriangle,
  error: IconAlertTriangle,
  failure: IconAlertTriangle,
  bug: IconAlertTriangle,
  quote: IconInfo,
  example: IconInfo
};


// A `> [!type] Title` blockquote — Obsidian's callout syntax. `lines` are
// the remaining (already `>`-stripped) lines of the same blockquote, which
// render as nested markdown so lists/links/etc still work inside a callout.
function Callout({ type, title, lines, handlers, linkIndex, keyBase }) {
  const Icon = CALLOUT_ICONS[type] || IconInfo;
  return (
    <div className={`callout callout-${type}`}>
      <div className="callout-title">
        <Icon size={15} className="callout-icon" />
        <span>{renderInline(title, `${keyBase}t`, handlers, linkIndex)}</span>
      </div>
      {lines.length > 0 && <div className="callout-body">{renderMarkdownBlocks(lines.join('\n'), handlers, linkIndex, keyBase)}</div>}
    </div>
  );
}


// A Notion-style in-note tab block: `:::tabs` ... one or more `:::tab Name`
// sections ... `:::`. Unlike columns/toggles this block is mutable from
// reading view (add/rename/delete tabs), so it round-trips through a
// parse/serialize pair rather than only ever being read.
function parseTabsBlock(innerLines) {
  const tabs = [];
  let current = null;
  innerLines.forEach((l) => {
    const m = l.match(/^:::tab\s+(.*)$/);
    if (m) {
      current = { name: m[1].trim() || `Tab ${tabs.length + 1}`, lines: [] };
      tabs.push(current);
    } else if (current) {
      current.lines.push(l);
    }
    // Any lines before the first `:::tab` marker are stray/preamble and
    // dropped, same as columns silently drops content before the first
    // `:::column` marker.
  });
  if (!tabs.length) tabs.push({ name: 'Tab 1', lines: innerLines.slice() });
  return tabs;
}

function serializeTabsBlock(tabs) {
  const body = tabs.map((t) => `:::tab ${t.name}\n${t.lines.join('\n')}`).join('\n');
  return `:::tabs\n${body}\n:::`;
}


// Renders a parsed tabs block plus its own tab bar. `rawBlockText` is this
// block's exact source text (from the opening `:::tabs` line to the closing
// `:::` line, inclusive) — edits are applied by asking `handlers.onMutateBlock`
// to swap that exact substring for a freshly-serialized one, so this
// component never needs to know its own position in the wider document.
function TabsBlockView({ tabs, rawBlockText, handlers, linkIndex, foldState, keyBase }) {
  const [active, setActive] = useState(0);
  const safeActive = Math.min(active, tabs.length - 1);
  const [renamingIdx, setRenamingIdx] = useState(null);
  const [draft, setDraft] = useState('');

  const commit = (newTabs, newActive) => {
    handlers.onMutateBlock?.(rawBlockText, serializeTabsBlock(newTabs));
    if (newActive !== undefined) setActive(newActive);
  };

  const addTab = () => {
    const newTabs = [...tabs, { name: `Tab ${tabs.length + 1}`, lines: [''] }];
    commit(newTabs, newTabs.length - 1);
  };

  const deleteTab = (i) => {
    if (tabs.length <= 1) return;
    const newTabs = tabs.filter((_, idx) => idx !== i);
    let newActive = safeActive;
    if (i === safeActive) newActive = Math.max(0, i - 1);
    else if (i < safeActive) newActive = safeActive - 1;
    commit(newTabs, newActive);
  };

  const renameTab = (i, name) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tabs[i].name) return;
    commit(tabs.map((t, idx) => (idx === i ? { ...t, name: trimmed } : t)));
  };

  return (
    <div className="tabs-block">
      <div className="tabs-block-bar">
        {tabs.map((t, i) => (
          <div
            key={i}
            className={`tabs-block-tab ${i === safeActive ? 'active' : ''}`}
            onClick={() => setActive(i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenamingIdx(i);
              setDraft(t.name);
            }}
          >
            {renamingIdx === i ? (
              <input
                className="tabs-block-rename-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  setRenamingIdx(null);
                  renameTab(i, draft);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenamingIdx(null);
                }}
              />
            ) : (
              <span className="tabs-block-tab-label">{t.name}</span>
            )}
            {tabs.length > 1 && (
              <button
                className="tabs-block-tab-close"
                title="Delete tab"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTab(i);
                }}
              >
                <IconX size={11} />
              </button>
            )}
          </div>
        ))}
        <button className="tabs-block-add" title="Add tab" onClick={addTab}>
          <IconPlus size={13} />
        </button>
      </div>
      <div className="tabs-block-body">
        {renderMarkdownBlocks((tabs[safeActive]?.lines || []).join('\n'), handlers, linkIndex, `${keyBase}-${safeActive}-`, foldState)}
      </div>
    </div>
  );
}


// `foldState` (optional) enables Obsidian-style heading fold/collapse in
// reading view: { collapsed: Set<headingId>, onToggle: (headingId) => void,
// collapsedToggles: Set<toggleId>, onToggleToggle: (toggleId) => void }.
// Headings whose id is in `collapsed` render with their content (down to the
// next heading of equal-or-shallower level) hidden. Purely a reading-view
// affordance — the underlying markdown/content is never mutated, so it's
// safe to leave out entirely (edit mode, or any caller that omits
// foldState) and get the old unfolded behavior (toggle blocks default open
// when there's no state to remember a collapse).
function renderMarkdownBlocks(content, handlers, linkIndex, keyBase = '', foldState = null) {
  const lines = content.split('\n');
  const blocks = [];
  let listBuffer = [];
  let listType = null;
  let codeBuffer = null;
  let codeLang = null;
  let quoteBuffer = [];
  // While set, we're inside a collapsed heading's section: everything is
  // parsed (to keep fence/list state consistent) but nothing is pushed to
  // `blocks`, until a heading at this level or shallower closes it.
  let hiddenUntilLevel = null;
  // Index of the last line already consumed by a multi-line block (table,
  // toggle, columns) that scanned ahead — lines up to and including this
  // index are skipped by the main loop.
  let skipUntil = -1;

  const flushList = () => {
    if (!listBuffer.length) return;
    const Tag = listType === 'ol' ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`${keyBase}list-${blocks.length}`}>
        {listBuffer.map((item, idx) => (
          <li key={idx}>{renderInline(item, `${keyBase}li-${blocks.length}-${idx}`, handlers, linkIndex)}</li>
        ))}
      </Tag>
    );
    listBuffer = [];
    listType = null;
  };

  const flushQuote = () => {
    if (!quoteBuffer.length) return;
    const calloutMatch = quoteBuffer[0].match(/^\[!([a-zA-Z]+)\]([+-]?)\s*(.*)$/);
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const titleText = calloutMatch[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const key = `${keyBase}callout-${blocks.length}-`;
      blocks.push(
        <Callout
          key={key}
          type={type}
          title={titleText}
          lines={quoteBuffer.slice(1)}
          handlers={handlers}
          linkIndex={linkIndex}
          keyBase={key}
        />
      );
    } else {
      blocks.push(
        <blockquote key={`${keyBase}q-${blocks.length}`}>
          {quoteBuffer.map((l, i) => (
            <p key={i}>{renderInline(l, `${keyBase}q-${blocks.length}-${i}`, handlers, linkIndex)}</p>
          ))}
        </blockquote>
      );
    }
    quoteBuffer = [];
  };

  lines.forEach((line, idx) => {
    if (idx <= skipUntil) return;
    if (codeBuffer !== null) {
      if (/^```/.test(line.trim())) {
        if (hiddenUntilLevel === null) {
          if (codeLang === 'query' || codeLang === 'dataview') {
            blocks.push(
              <QueryBlock key={`${keyBase}query-${idx}`} raw={codeBuffer.join('\n')} handlers={handlers} linkIndex={linkIndex} />
            );
          } else {
            blocks.push(
              <pre key={`${keyBase}code-${idx}`}>
                <code>{codeBuffer.join('\n')}</code>
              </pre>
            );
          }
        }
        codeBuffer = null;
        codeLang = null;
      } else {
        codeBuffer.push(line);
      }
      return;
    }
    const fence = /^```/.test(line.trim());
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const hr = /^(-{3,}|\*{3,})$/.test(line.trim());
    const taskUl = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    const toggleOpen = line.match(/^\+\+\+\s?(.*)$/);
    const columnsOpen = line.trim().match(/^:::columns-([234])\s*$/);
    const tabsOpen = line.trim().match(/^:::tabs\s*$/);
    const isTableStart =
      !fence &&
      !heading &&
      !hr &&
      line.includes('|') &&
      line.trim() !== '' &&
      idx + 1 < lines.length &&
      isTableSeparatorRow(lines[idx + 1]);

    if (heading) {
      const level = Math.min(heading[1].length, 6);
      if (hiddenUntilLevel !== null) {
        if (level <= hiddenUntilLevel) {
          hiddenUntilLevel = null;
        } else {
          // Nested inside a collapsed ancestor — stays hidden entirely.
          return;
        }
      }
      flushList();
      flushQuote();
      const headingId = heading[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const fullId = `${keyBase}${headingId}`;
      const isCollapsed = !!foldState?.collapsed?.has(fullId);
      blocks.push(
        React.createElement(
          `h${level}`,
          { key: `${keyBase}h-${idx}`, id: fullId },
          foldState && (
            <span
              className={`heading-fold-toggle ${isCollapsed ? 'collapsed' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                foldState.onToggle(fullId);
              }}
              role="button"
              aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
            >
              <IconChevronDown size={12} />
            </span>
          ),
          renderInline(heading[2], `${keyBase}h-${idx}`, handlers, linkIndex)
        )
      );
      if (isCollapsed) hiddenUntilLevel = level;
      return;
    }

    if (hiddenUntilLevel !== null) {
      // Inside a collapsed section: still track fence-open so line
      // interpretation downstream (once we exit) stays correct, but don't
      // render anything.
      if (fence) {
        codeBuffer = [];
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      return;
    }

    if (toggleOpen) {
      flushList();
      flushQuote();
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== '+++') j++;
      const innerLines = lines.slice(idx + 1, j);
      const toggleId = `${keyBase}toggle-${idx}`;
      const isCollapsed = !!foldState?.collapsedToggles?.has(toggleId);
      blocks.push(
        <div className={`toggle-block ${isCollapsed ? 'collapsed' : ''}`} key={toggleId}>
          <div
            className="toggle-header"
            onClick={() => foldState?.onToggleToggle?.(toggleId)}
            role="button"
            aria-label={isCollapsed ? 'Expand toggle' : 'Collapse toggle'}
          >
            <span className="toggle-caret">
              <IconChevronRight size={12} />
            </span>
            <span className="toggle-title">
              {renderInline(toggleOpen[1] || 'Toggle', `${toggleId}-t`, handlers, linkIndex)}
            </span>
          </div>
          {!isCollapsed && (
            <div className="toggle-body">{renderMarkdownBlocks(innerLines.join('\n'), handlers, linkIndex, `${toggleId}-`, foldState)}</div>
          )}
        </div>
      );
      skipUntil = j;
      return;
    }

    if (columnsOpen) {
      flushList();
      flushQuote();
      const colCount = parseInt(columnsOpen[1], 10);
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      const innerLines = lines.slice(idx + 1, j);
      const chunks = [];
      let current = [];
      innerLines.forEach((l) => {
        if (l.trim() === ':::column') {
          chunks.push(current);
          current = [];
        } else {
          current.push(l);
        }
      });
      chunks.push(current);
      const colsKey = `${keyBase}cols-${idx}`;
      blocks.push(
        <div className="md-columns" style={{ '--col-count': colCount }} key={colsKey}>
          {chunks.map((chunkLines, ci) => (
            <div className="md-column" key={`${colsKey}-${ci}`}>
              {renderMarkdownBlocks(chunkLines.join('\n'), handlers, linkIndex, `${colsKey}-${ci}-`, foldState)}
            </div>
          ))}
        </div>
      );
      skipUntil = j;
      return;
    }

    if (tabsOpen) {
      flushList();
      flushQuote();
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      const innerLines = lines.slice(idx + 1, j);
      const rawBlockText = lines.slice(idx, Math.min(j + 1, lines.length)).join('\n');
      const tabsKey = `${keyBase}tabs-${idx}`;
      blocks.push(
        <TabsBlockView
          key={tabsKey}
          keyBase={tabsKey}
          tabs={parseTabsBlock(innerLines)}
          rawBlockText={rawBlockText}
          handlers={handlers}
          linkIndex={linkIndex}
          foldState={foldState}
        />
      );
      skipUntil = j;
      return;
    }

    if (isTableStart) {
      flushList();
      flushQuote();
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[idx + 1]).map(tableColAlign);
      let j = idx + 2;
      const bodyRows = [];
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        bodyRows.push(splitTableRow(lines[j]));
        j++;
      }
      const tKey = `${keyBase}table-${idx}`;
      blocks.push(
        <table className="md-table" key={tKey}>
          <thead>
            <tr>
              {headerCells.map((c, ci) => (
                <th key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                  {renderInline(c, `${tKey}-h-${ci}`, handlers, linkIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                    {renderInline(c, `${tKey}-${ri}-${ci}`, handlers, linkIndex)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      skipUntil = j - 1;
      return;
    }

    if (fence) {
      flushList();
      flushQuote();
      codeBuffer = [];
      codeLang = line.trim().slice(3).trim().toLowerCase();
    } else if (taskUl) {
      flushList();
      flushQuote();
      const checked = taskUl[1].toLowerCase() === 'x';
      blocks.push(
        <div className="task-line" key={`${keyBase}task-${idx}`}>
          <input type="checkbox" checked={checked} readOnly />
          <span className={checked ? 'task-done' : ''}>{renderInline(taskUl[2], `${keyBase}t-${idx}`, handlers, linkIndex)}</span>
        </div>
      );
    } else if (hr) {
      flushList();
      flushQuote();
      blocks.push(<hr key={`${keyBase}hr-${idx}`} />);
    } else if (quote) {
      flushList();
      quoteBuffer.push(quote[1]);
    } else if (ul) {
      flushQuote();
      listType = 'ul';
      listBuffer.push(ul[1]);
    } else if (ol) {
      flushQuote();
      listType = 'ol';
      listBuffer.push(ol[1]);
    } else if (line.trim() === '') {
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      blocks.push(<p key={`${keyBase}p-${idx}`}>{renderInline(line, `${keyBase}p-${idx}`, handlers, linkIndex)}</p>);
    }
  });
  flushList();
  flushQuote();
  if (codeBuffer !== null && hiddenUntilLevel === null) {
    if (codeLang === 'query' || codeLang === 'dataview') {
      blocks.push(<QueryBlock key={`${keyBase}query-end`} raw={codeBuffer.join('\n')} handlers={handlers} linkIndex={linkIndex} />);
    } else {
      blocks.push(
        <pre key={`${keyBase}code-end`}>
          <code>{codeBuffer.join('\n')}</code>
        </pre>
      );
    }
  }
  return blocks;
}

export { renderInline, splitTableRow, isTableSeparatorRow, tableColAlign, CALLOUT_ICONS, Callout, parseTabsBlock, serializeTabsBlock, TabsBlockView, renderMarkdownBlocks };
