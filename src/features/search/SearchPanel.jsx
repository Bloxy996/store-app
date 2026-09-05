import React, { useEffect, useMemo, useRef, useState } from 'react';

import { DropdownMenu } from '../../components/DropdownMenu.jsx';
import { IconChevronDown, IconChevronRight, IconInfo, IconLoader, IconSearch, IconSliders, IconX } from '../../components/icons.jsx';
import { runVaultSearch } from '../../lib/search.js';


// ---------------------------------------------------------------------------
// Search panel — Obsidian-style operators (path:, file:, tag:, line:,
// section:, [property]), grouped-by-file results with highlighted context
// snippets, collapsible per file.
// ---------------------------------------------------------------------------
const SEARCH_HELP = [
  { op: 'path:', desc: 'match path of the file' },
  { op: 'file:', desc: 'match file name' },
  { op: 'tag:', desc: 'search for tags' },
  { op: 'line:', desc: 'keywords on same line' },
  { op: 'section:', desc: 'keywords under same heading' },
  { op: '[property]', desc: 'match property' }
];


const SearchPanel = React.memo(function SearchPanel({ query, setQuery, filesMeta, linkIndex, getBody, tagsByFileId, onOpenNote, indexing, ensureIndexed, indexVersion }) {
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);
  const inputRef = useRef(null);

  // The heavy work here is runVaultSearch scanning every note body in the
  // vault — expensive enough on a large vault that running it on every
  // single keystroke causes visible input lag on mobile. The input itself
  // stays fully responsive (it's bound to `query`, updated synchronously by
  // the parent on every keystroke); only the actual search execution lags
  // ~150ms behind typing, which is imperceptible as "lag" but cuts the
  // number of full-vault scans for a fast typist by an order of magnitude.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const effectiveGetBody = caseSensitive ? getBody : (id) => getBody(id);
    const r = runVaultSearch(debouncedQuery, filesMeta, linkIndex, effectiveGetBody, tagsByFileId);
    return sortDesc ? r.slice().reverse() : r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, filesMeta, linkIndex, getBody, tagsByFileId, sortDesc, caseSensitive, indexVersion]);

  const toggleCollapsed = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const totalMatches = results.reduce((n, r) => n + (r.matchCount ?? (r.matches.length ? r.matches.length : 1)), 0);

  return (
    <div className="side-panel search-panel">
      <div className="search-bar">
        <IconSearch className="search-bar-icon" size={15} />
        <input
          ref={inputRef}
          className="search-bar-input"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="search-bar-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <IconX size={13} />
          </button>
        )}
        <button
          className={`search-bar-case ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
        >
          Aa
        </button>
        <DropdownMenu
          align="right"
          trigger={(toggle) => (
            <button className="icon-btn" onClick={toggle} title="Search options">
              <IconSliders size={15} />
            </button>
          )}
        >
          <div className="search-options-menu">
            <div className="search-options-title">
              Search options
              <IconInfo size={13} onClick={() => setShowHelp((v) => !v)} />
            </div>
            {SEARCH_HELP.map((h) => (
              <div className="search-options-row" key={h.op}>
                <code>{h.op}</code>
                <span>{h.desc}</span>
              </div>
            ))}
          </div>
        </DropdownMenu>
      </div>

      {indexing.building && (
        <div className="indexing-banner">
          <IconLoader size={13} />
          Indexing store… {indexing.progress.loaded}/{indexing.progress.total}
        </div>
      )}

      {query.trim() ? (
        <>
          <div className="search-results-meta">
            <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
            <button className="link-btn small" onClick={() => setSortDesc((v) => !v)}>
              File name ({sortDesc ? 'Z to A' : 'A to Z'})
            </button>
          </div>
          <div className="side-panel-body search-results">
            {results.length === 0 && <p className="muted small empty-hint">No matches found.</p>}
            {results.map(({ file, path, matches }) => {
              const isCollapsed = collapsed.has(file.id);
              return (
                <div className="search-result-group" key={file.id}>
                  <button className="search-result-header" onClick={() => toggleCollapsed(file.id)}>
                    {isCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                    <span className="search-result-name">{file.name.replace(/\.md$/i, '')}</span>
                    <span className="search-result-count">{matches.length || 1}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="search-result-snippets">
                      {(matches.length ? matches : [{ line: path, lineNumber: null }]).map((m, i) => (
                        <div className="search-snippet" key={i} onClick={() => onOpenNote(file.id)}>
                          <SearchHighlightedLine line={m.line} terms={m.terms || []} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="muted small empty-hint">
          Type to search across your store. Try <code>tag:</code>, <code>path:</code>, or plain text.
        </p>
      )}
    </div>
  );
});


// Highlights every occurrence of any search term within a line of text —
// used for search result snippets (as opposed to HighlightedSnippet, which
// highlights a single [[link]] occurrence for the inline mentions panel).
function SearchHighlightedLine({ line, terms }) {
  if (!terms.length) return <>{line}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = line.split(re);
  return (
    <>
      {parts.map((part, i) => (terms.some((t) => part.toLowerCase() === t.toLowerCase()) ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

export { SEARCH_HELP, SearchPanel, SearchHighlightedLine };
