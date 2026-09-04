import { bestLinkTextFor } from '../../lib/linkGraph.js';


// ---------------------------------------------------------------------------
// [[wikilink and #tag autocomplete, ported from the old textarea hooks onto
// CodeMirror's native completion API (handles positioning, keyboard nav,
// and dismissal for us — no more manual caret-coordinate math).
// ---------------------------------------------------------------------------
function wikilinkTagCompletionSource(ctx) {
  return (context) => {
    const wiki = context.matchBefore(/\[\[[^\]\n|]*$/);
    if (wiki) {
      const query = wiki.text.slice(2).toLowerCase();
      const pool = ctx.getLinkIndex().records.concat(ctx.getPhantomRecords() || []);
      const scoreOf = (hay) => (query ? hay.indexOf(query) : 0);
      let scored = pool.map((r) => ({ r, score: scoreOf(r.baseName.toLowerCase()) })).filter((s) => s.score !== -1);
      if (!scored.length) scored = pool.map((r) => ({ r, score: scoreOf(r.relativePath.toLowerCase()) })).filter((s) => s.score !== -1);
      const options = scored
        .sort((a, b) => a.score - b.score || a.r.baseName.localeCompare(b.r.baseName))
        .slice(0, 8)
        .map((s) => ({
          label: s.r.baseName,
          detail: s.r.isPhantom ? 'new' : s.r.relativePath !== s.r.baseName ? s.r.dir : undefined,
          apply: (view, completion, from, to) => {
            const insertText = bestLinkTextFor(s.r, ctx.getLinkIndex());
            const after = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
            view.dispatch({
              changes: { from, to: after, insert: `[[${insertText}]]` },
              selection: { anchor: from + insertText.length + 4 }
            });
          }
        }));
      if (!options.length) return null;
      return { from: wiki.from + 2, options, filter: false };
    }
    const tag = context.matchBefore(/(^|[\s(])#[\w/-]*$/);
    if (tag) {
      const hashIdx = tag.text.lastIndexOf('#');
      const query = tag.text.slice(hashIdx + 1).toLowerCase();
      const options = (ctx.getAllTags() || [])
        .filter((t) => t.toLowerCase().includes(query))
        .sort((a, b) => {
          const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
          return aStarts - bStarts || a.localeCompare(b);
        })
        .slice(0, 8)
        .map((t) => ({ label: `#${t}`, apply: `#${t}` }));
      if (!options.length) return null;
      return { from: tag.from + hashIdx, options, filter: false };
    }
    return null;
  };
}

export { wikilinkTagCompletionSource };
