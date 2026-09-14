import { useMemo, useRef, useState } from 'react';

import { IconImage, IconLink2, IconLoader, IconX } from '../../components/icons.jsx';
import { allSparkCategoryPaths } from '../../lib/sparkStore.js';
import { searchNotesForLink } from '../../lib/search.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';

// ---------------------------------------------------------------------------
// Category input: a plain text field + an inline suggestion list filtered
// from every existing spark category path — same "inline panel, closed via
// useClickOutside" convention as every other floating list in this app
// (3.5), not a portal.
// ---------------------------------------------------------------------------
function CategoryField({ value, onChange, existingPaths }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useClickOutside(wrapRef, () => setOpen(false));

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return existingPaths.slice(0, 8);
    return existingPaths.filter((p) => p.toLowerCase().includes(q)).slice(0, 8);
  }, [value, existingPaths]);

  return (
    <div className="spark-field-wrap" ref={wrapRef}>
      <input
        className="spark-input"
        placeholder="Category (e.g. vehicles/boat/small)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
      />
      {open && suggestions.length > 0 && (
        <div className="spark-suggest-panel">
          {suggestions.map((p) => (
            <button
              key={p}
              className="menu-item"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p);
                setOpen(false);
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Note/file linker: a search box over title + frontmatter + content
// (searchNotesForLink), with picked notes shown as removable chips above.
// ---------------------------------------------------------------------------
function NoteLinker({ filesMeta, getBody, linkedIds, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useClickOutside(wrapRef, () => setOpen(false));

  const results = useMemo(() => searchNotesForLink(query, filesMeta, getBody), [query, filesMeta, getBody]);
  const linkedFiles = linkedIds.map((id) => filesMeta.find((f) => f.id === id)).filter(Boolean);

  return (
    <div className="spark-field-wrap" ref={wrapRef}>
      {linkedFiles.length > 0 && (
        <div className="spark-linked-chips">
          {linkedFiles.map((f) => (
            <span className="spark-chip" key={f.id}>
              <IconLink2 size={11} />
              {f.name.replace(/\.md$/i, '')}
              <button onClick={() => onChange(linkedIds.filter((id) => id !== f.id))} aria-label={`Remove link to ${f.name}`}>
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="spark-input"
        placeholder="Link a note or file (searches title, frontmatter, content)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
      />
      {open && query.trim() && (
        <div className="spark-suggest-panel">
          {results.length === 0 && <p className="muted small empty-hint">No matches.</p>}
          {results
            .filter((f) => !linkedIds.includes(f.id))
            .map((f) => (
              <button
                key={f.id}
                className="menu-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange([...linkedIds, f.id]);
                  setQuery('');
                }}
              >
                {f.name.replace(/\.md$/i, '')}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// `sparks` (existing spark list, for category autocomplete), `filesMeta` +
// `getBody` (for the note linker), `onSubmit({ category, textLines,
// linkedFileIds, screenshotFile })`, `busy` (disables the Add button).
function SparkCaptureForm({ sparks, filesMeta, getBody, onSubmit, busy, autoFocus, canAttachScreenshot = true }) {
  const [category, setCategory] = useState('');
  const [textLines, setTextLines] = useState('');
  const [linkedFileIds, setLinkedFileIds] = useState([]);
  const [screenshotFile, setScreenshotFile] = useState(null);
  const fileInputRef = useRef(null);

  const existingPaths = useMemo(() => allSparkCategoryPaths(sparks), [sparks]);
  const canSubmit = category.trim() && (textLines.trim() || screenshotFile) && !busy;

  const reset = () => {
    setCategory('');
    setTextLines('');
    setLinkedFileIds([]);
    setScreenshotFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit({ category, textLines, linkedFileIds, screenshotFile });
    reset();
  };

  return (
    <div className="spark-capture-form">
      <CategoryField value={category} onChange={setCategory} existingPaths={existingPaths} />
      {screenshotFile ? (
        <div className="spark-screenshot-preview">
          <IconImage size={13} />
          <span className="spark-screenshot-name">{screenshotFile.name}</span>
          <button onClick={() => setScreenshotFile(null)} aria-label="Remove screenshot">
            <IconX size={12} />
          </button>
        </div>
      ) : null}
      <textarea
        className="spark-textarea"
        rows={screenshotFile ? 2 : 4}
        autoFocus={autoFocus}
        placeholder={
          screenshotFile
            ? 'Caption for this screenshot (optional)…'
            : 'Type a spark. One per line — each line becomes its own spark in this category.'
        }
        value={textLines}
        onChange={(e) => setTextLines(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
        }}
      />
      <NoteLinker filesMeta={filesMeta} getBody={getBody} linkedIds={linkedFileIds} onChange={setLinkedFileIds} />
      <div className="spark-capture-actions">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="spark-file-input-hidden"
          onChange={(e) => setScreenshotFile(e.target.files?.[0] || null)}
        />
        <button className="btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={!canAttachScreenshot} title={canAttachScreenshot ? undefined : 'Screenshots require direct Google sign-in'}>
          <IconImage size={14} /> Screenshot
        </button>
        <button className="btn-primary spark-add-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {busy ? <IconLoader size={14} /> : null} Add
        </button>
      </div>
    </div>
  );
}

export { SparkCaptureForm };
