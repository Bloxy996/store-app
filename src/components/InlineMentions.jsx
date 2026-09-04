import { useMemo, useState } from 'react';

import { IconChevronDown, IconChevronRight } from './icons.jsx';
import { resolveLinkTarget } from '../lib/linkGraph.js';
import { snippetAround } from '../lib/search.js';


function HighlightedSnippet({ text, needle }) {
  const { before, match, after } = snippetAround(text, needle);
  return (
    <>
      {before}
      {match && <mark>{match}</mark>}
      {after}
    </>
  );
}


// Inline "Linked mentions" / "Unlinked mentions" — reproduces Obsidian's
// in-document backlinks pane. Linked mentions are notes that [[link]] here
// (grouped by source note, each occurrence shown with context and the
// link text highlighted); unlinked mentions are notes that mention this
// note's title as plain text without ever linking to it.
function InlineMentions({ file, linkIndex, getBody, backlinkFileIds, allFiles, onOpenNote }) {
  const [linkedOpen, setLinkedOpen] = useState(true);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);

  const linked = useMemo(() => {
    return backlinkFileIds
      .map((id) => allFiles.find((f) => f.id === id))
      .filter(Boolean)
      .map((src) => {
        const body = getBody(src.id);
        const occurrences = [];
        const re = /!?\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]+)?\]\]/g;
        let m;
        while ((m = re.exec(body)) !== null) {
          const res = resolveLinkTarget(m[1].trim(), linkIndex);
          if (res.status === 'resolved' && res.file.id === file.id) {
            occurrences.push(snippetAround(body, m[0]));
          }
        }
        return { src, occurrences: occurrences.length ? occurrences : [snippetAround(body, '')] };
      })
      .sort((a, b) => a.src.name.localeCompare(b.src.name));
  }, [backlinkFileIds, allFiles, getBody, linkIndex, file.id]);

  const unlinked = useMemo(() => {
    const title = (file.baseName || file.name || '').trim();
    if (!title) return [];
    const titleLower = title.toLowerCase();
    const linkedIds = new Set(backlinkFileIds);
    return allFiles
      .filter((f) => f.kind === 'note' && f.id !== file.id && !linkedIds.has(f.id))
      .map((f) => {
        const body = getBody(f.id);
        if (!body || !body.toLowerCase().includes(titleLower)) return null;
        // Skip if every occurrence is actually inside a [[...]] (already
        // counted as linked some other way, or a partial-name collision).
        return { src: f, occurrences: [snippetAround(body, title)] };
      })
      .filter(Boolean)
      .sort((a, b) => a.src.name.localeCompare(b.src.name));
  }, [allFiles, getBody, file, backlinkFileIds]);

  const linkedCount = linked.reduce((n, g) => n + g.occurrences.length, 0);

  return (
    <div className="inline-mentions">
      <div className="mentions-group">
        <button className="mentions-header" onClick={() => setLinkedOpen((v) => !v)}>
          {linkedOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span>Linked mentions</span>
          <span className="mentions-count">{linkedCount}</span>
        </button>
        {linkedOpen && (
          <div className="mentions-body">
            {linked.length === 0 && <p className="muted small">No notes link here yet.</p>}
            {linked.map(({ src, occurrences }) => (
              <div className="mentions-source" key={src.id}>
                <button className="mentions-source-name" onClick={() => onOpenNote(src.id)}>
                  {src.name.replace(/\.md$/i, '')}
                </button>
                {occurrences.map((occ, i) => (
                  <div className="mentions-snippet" key={i} onClick={() => onOpenNote(src.id)}>
                    {occ.before}
                    {occ.match && <mark>{occ.match}</mark>}
                    {occ.after}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mentions-group">
        <button className="mentions-header muted-header" onClick={() => setUnlinkedOpen((v) => !v)}>
          {unlinkedOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span>Unlinked mentions</span>
          <span className="mentions-count">{unlinked.length}</span>
        </button>
        {unlinkedOpen && (
          <div className="mentions-body">
            {unlinked.length === 0 && <p className="muted small">No unlinked mentions.</p>}
            {unlinked.map(({ src, occurrences }) => (
              <div className="mentions-source" key={src.id}>
                <button className="mentions-source-name" onClick={() => onOpenNote(src.id)}>
                  {src.name.replace(/\.md$/i, '')}
                </button>
                {occurrences.map((occ, i) => (
                  <div className="mentions-snippet" key={i} onClick={() => onOpenNote(src.id)}>
                    {occ.before}
                    {occ.match && <mark>{occ.match}</mark>}
                    {occ.after}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export { HighlightedSnippet, InlineMentions };
