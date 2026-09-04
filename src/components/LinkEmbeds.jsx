import { useState } from 'react';

import { IconImageMissing } from './icons.jsx';
import { useDriveImageUrl } from '../hooks/useDriveImageUrl.js';


// ---------------------------------------------------------------------------
// Inline popover for an ambiguous [[link]] — shown when a bare name matches
// more than one file, so the reader can pick which one was actually meant.
// ---------------------------------------------------------------------------
function AmbiguousLink({ label, candidates, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="wikilink-ambiguous-wrap">
      <span
        className="wikilink wikilink-ambiguous"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Multiple files match this name — pick one"
      >
        {label}
      </span>
      {open && (
        <span className="ambiguous-menu" onMouseLeave={() => setOpen(false)}>
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(c);
              }}
            >
              {c.relativePath}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}


// Inline embedded image inside a note's preview — [[image.png]] (with or
// without the Obsidian-style leading "!") renders the picture itself,
// clickable to open the full viewer.
function ImageEmbed({ token, fileId, name, caption, onOpen }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) {
    return (
      <span className="wikilink wikilink-missing-image" title={error}>
        <IconImageMissing size={13} /> {name}
      </span>
    );
  }
  return (
    <span className="image-embed-wrap">
      <span className="image-embed" onClick={onOpen} title={`Open ${name}`}>
        {url ? <img src={url} alt={caption || name} loading="lazy" /> : <span className="image-embed-loading">Loading image…</span>}
      </span>
      {caption && <span className="image-embed-caption">{caption}</span>}
    </span>
  );
}

export { AmbiguousLink, ImageEmbed };
