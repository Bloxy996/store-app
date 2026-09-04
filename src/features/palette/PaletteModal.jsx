import { useEffect, useMemo, useRef, useState } from 'react';

import { IconCommand, IconSearch } from '../../components/icons.jsx';
import { fuzzyScore } from '../../lib/linkGraph.js';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


function PaletteModal({ mode, files, commands, onClose, onPickFile, onRunCommand }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (mode === 'switcher') {
      return files
        .map((f) => ({ f, score: fuzzyScore(query, opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name) }))
        .filter((s) => s.score !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, 50)
        .map((s) => s.f);
    }
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
      .filter((s) => s.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((s) => s.c);
  }, [mode, query, files, commands]);

  useEffect(() => setActiveIndex(0), [query, mode]);

  const runActive = (opts) => {
    const item = results[activeIndex];
    if (!item) return;
    if (mode === 'switcher') onPickFile(item, opts);
    else onRunCommand(item);
  };

  return (
    <div className="modal-overlay palette-overlay" onClick={onClose}>
      <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          {mode === 'switcher' ? <IconSearch size={16} /> : <IconCommand size={16} />}
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={mode === 'switcher' ? 'Jump to note…' : 'Type a command…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runActive({ newTab: e.metaKey || e.ctrlKey });
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-results">
          {results.length === 0 && <p className="muted small empty-hint">No matches.</p>}
          {mode === 'switcher'
            ? results.map((f, i) => (
                <button
                  key={f.id}
                  className={`palette-result ${i === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={(e) => onPickFile(f, { newTab: e.metaKey || e.ctrlKey })}
                >
                  <span className="palette-result-name">{opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name}</span>
                </button>
              ))
            : results.map((c, i) => (
                <button
                  key={c.id}
                  className={`palette-result ${i === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => onRunCommand(c)}
                >
                  {c.icon}
                  <span className="palette-result-name">{c.label}</span>
                  {c.hint && <span className="palette-result-hint">{c.hint}</span>}
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}

export { PaletteModal };
