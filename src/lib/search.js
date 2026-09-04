import { parseFrontmatter } from './markdownParse.js';


// ---------------------------------------------------------------------------
// Search query parsing — a subset of Obsidian's search syntax:
//   path:foo        only files whose path contains "foo"
//   file:foo        only files whose name contains "foo"
//   tag:foo / #foo  only files tagged #foo (or a descendant "#foo/bar")
//   line:(a b)      terms must all appear on the same line
//   section:(a b)   terms must all appear under the same heading
//   [key] / [key:value]   frontmatter property match
//   "exact phrase"  literal phrase match
//   bare words      plain content terms (AND-ed together)
// ---------------------------------------------------------------------------
function parseSearchQuery(raw) {
  const clauses = { path: [], file: [], tag: [], line: [], section: [], property: [], phrase: [], term: [] };
  let s = raw;

  s = s.replace(/\[([^:\]]+):([^\]]+)\]/g, (_, k, v) => {
    clauses.property.push({ key: k.trim().toLowerCase(), value: v.trim().toLowerCase() });
    return ' ';
  });
  s = s.replace(/\[([^\]]+)\]/g, (_, k) => {
    clauses.property.push({ key: k.trim().toLowerCase(), value: null });
    return ' ';
  });
  s = s.replace(/"([^"]+)"/g, (_, v) => {
    clauses.phrase.push(v.toLowerCase());
    return ' ';
  });
  s = s.replace(/path:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.path.push(v.replace(/^\(|\)$/g, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/file:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.file.push(v.replace(/^\(|\)$/g, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/tag:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.tag.push(v.replace(/^\(|\)$/g, '').replace(/^#/, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/line:\(([^)]*)\)/gi, (_, v) => {
    clauses.line.push(v.trim().toLowerCase().split(/\s+/).filter(Boolean));
    return ' ';
  });
  s = s.replace(/section:\(([^)]*)\)/gi, (_, v) => {
    clauses.section.push(v.trim().toLowerCase().split(/\s+/).filter(Boolean));
    return ' ';
  });
  s = s.replace(/(^|\s)#([A-Za-z][A-Za-z0-9_\-/]*)/g, (_, pre, v) => {
    clauses.tag.push(v.toLowerCase());
    return ' ';
  });

  clauses.term = s.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  return clauses;
}


// Runs a parsed query against the in-memory vault index, returning results
// grouped by file: [{ file, matches: [{ line, lineNumber, ranges }] }],
// sorted by file name to match the reference search UI.
function runVaultSearch(query, filesMeta, linkIndex, getBody, tagsByFileId) {
  const clauses = parseSearchQuery(query);
  const hasStructural = clauses.path.length || clauses.file.length || clauses.tag.length || clauses.property.length;
  const hasContent = clauses.term.length || clauses.phrase.length || clauses.line.length || clauses.section.length;
  if (!hasStructural && !hasContent) return [];

  const results = [];
  filesMeta.forEach((f) => {
    if (f.kind !== 'note') return;
    const rec = linkIndex.records.find((r) => r.id === f.id);
    const path = (rec ? rec.relativePath : f.name).toLowerCase();
    const name = f.name.toLowerCase();

    if (clauses.path.some((v) => !path.includes(v))) return;
    if (clauses.file.some((v) => !name.includes(v))) return;

    const body = getBody(f.id);
    const { properties, body: bodyNoFrontmatter } = parseFrontmatter(body);
    const propMap = new Map(properties.map((p) => [p.key.toLowerCase(), p.value.toLowerCase()]));
    if (
      clauses.property.some(({ key, value }) => {
        if (!propMap.has(key)) return true;
        if (value === null) return false;
        return !propMap.get(key).includes(value);
      })
    )
      return;

    const fileTags = (tagsByFileId.get(f.id) || []).map((t) => t.toLowerCase());
    if (
      clauses.tag.some((v) => !fileTags.some((t) => t === v || t.startsWith(v + '/')))
    )
      return;

    if (!hasContent) {
      results.push({ file: f, path: rec ? rec.relativePath : f.name, matches: [] });
      return;
    }
    if (!body) return; // not indexed yet — will appear once indexing finishes

    const lines = bodyNoFrontmatter.split('\n');
    const lower = bodyNoFrontmatter.toLowerCase();
    const allTermsPresent =
      clauses.term.every((t) => lower.includes(t)) && clauses.phrase.every((p) => lower.includes(p));
    if (!allTermsPresent) return;

    // Build heading sections for section: matching.
    let currentHeading = '';
    const headingByLine = lines.map((l) => {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (h) currentHeading = h[1];
      return currentHeading;
    });

    const wanted = [...clauses.term, ...clauses.phrase];
    const matches = [];
    lines.forEach((line, idx) => {
      const lowerLine = line.toLowerCase();
      const lineHasAll = wanted.length ? wanted.every((t) => lowerLine.includes(t)) : false;
      const lineOk = clauses.line.every((group) => group.every((t) => lowerLine.includes(t)));
      const sectionOk = clauses.section.every((group) =>
        group.every((t) => headingByLine[idx].toLowerCase().includes(t) || lowerLine.includes(t))
      );
      const contributesLine = wanted.length ? lineHasAll : true;
      if (contributesLine && lineOk && sectionOk && (wanted.length || clauses.line.length || clauses.section.length)) {
        matches.push({ line, lineNumber: idx + 1, terms: wanted });
      }
    });

    // line:/section: without plain terms still need at least one satisfying
    // line to count as a file match.
    if ((clauses.line.length || clauses.section.length) && !matches.length) return;

    if (wanted.length && !matches.length) {
      // Terms appear in the file (allTermsPresent) but never together on one
      // line — still a file-level match; show the first line containing any term.
      const idx = lines.findIndex((l) => wanted.some((t) => l.toLowerCase().includes(t)));
      if (idx !== -1) matches.push({ line: lines[idx], lineNumber: idx + 1, terms: wanted });
    }

    results.push({ file: f, path: rec ? rec.relativePath : f.name, matches: matches.slice(0, 6), matchCount: matches.length });
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}


// Extracts a short, highlighted context snippet around the first
// occurrence of `needle` in `haystack` — used by both the search results
// panel and the inline "Linked/Unlinked mentions" sections at the bottom
// of a note, so both features share one look.
function snippetAround(haystack, needle, radius = 60) {
  const lower = haystack.toLowerCase();
  const idx = needle ? lower.indexOf(needle.toLowerCase()) : -1;
  if (idx === -1) {
    return { before: haystack.slice(0, radius * 2), match: '', after: '' };
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(haystack.length, idx + needle.length + radius);
  return {
    before: (start > 0 ? '…' : '') + haystack.slice(start, idx),
    match: haystack.slice(idx, idx + needle.length),
    after: haystack.slice(idx + needle.length, end) + (end < haystack.length ? '…' : '')
  };
}

export { parseSearchQuery, runVaultSearch, snippetAround };
