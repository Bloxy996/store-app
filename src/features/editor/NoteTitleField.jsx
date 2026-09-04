import { useCallback, useEffect, useRef, useState } from 'react';


// Inline-editable note title, shown above the note content in both edit and
// reading view. Renames the underlying file on blur / Enter, matching
// Obsidian's "click the title to rename" behavior. Keeps its own draft state
// so keystrokes aren't round-tripped through a Drive rename on every change —
// only committed once editing settles.
function NoteTitleField({ file, onRename }) {
  const [draft, setDraft] = useState(() => file.name.replace(/\.md$/i, ''));
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(file.name.replace(/\.md$/i, ''));
  }, [file.id, file.name]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    const current = file.name.replace(/\.md$/i, '');
    if (trimmed && trimmed !== current) {
      onRename(file.id, trimmed);
    } else {
      setDraft(current);
    }
  }, [draft, file.id, file.name, onRename]);

  return (
    <input
      ref={inputRef}
      className="note-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setDraft(file.name.replace(/\.md$/i, ''));
          inputRef.current?.blur();
        }
      }}
      placeholder="Untitled"
      aria-label="Note title"
    />
  );
}

export { NoteTitleField };
