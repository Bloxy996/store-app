
// ---------------------------------------------------------------------------
// RegExp wikilink parsing
// ---------------------------------------------------------------------------
// Matches [[Target]], [[Target#heading]], [[Target|Alias]], and their
// embed form ![[Target]] (the leading "!" is accepted but not required —
// see the smart-linking section below for why image links don't need it).
function parseWikilinks(content) {
  const re = /!?\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]+))?\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push({ target: m[1].trim(), alias: m[2] ? m[2].trim() : null });
  }
  return links;
}


// ---------------------------------------------------------------------------
// Frontmatter / Properties — a leading "---\n...\n---" YAML-ish block.
// Parsed loosely (key: value per line, values may be inline lists like
// "[a, b]" or comma-separated) — enough to power the Properties panel and
// the tag index without pulling in a real YAML parser.
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content || '');
  if (!m) return { properties: [], body: content || '', raw: '' };
  const raw = m[1];
  const body = content.slice(m[0].length);
  const properties = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let key = kv[1].trim();
    let value = kv[2].trim();
    // Gather an indented "- item" list that follows a bare "key:" line.
    if (!value) {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, '').trim());
        j++;
      }
      if (items.length) {
        value = items.join(', ');
        i = j - 1;
      }
    }
    properties.push({ key, value });
  }
  return { properties, body, raw };
}


function splitListValue(value) {
  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return trimmed
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}


// Tags come from two places, both real Obsidian conventions: a `tags:` (or
// `tag:`) frontmatter property, and inline `#hashtag` tokens anywhere in the
// body. Nested tags ("#parent/child") are kept as their full path. Inline
// tags inside fenced/inline code are skipped so code samples don't pollute
// the tag index.
function extractTags(content) {
  if (!content) return [];
  const { properties, body } = parseFrontmatter(content);
  const tags = new Set();

  properties.forEach((p) => {
    if (/^tags?$/i.test(p.key)) {
      splitListValue(p.value).forEach((t) => {
        const clean = t.replace(/^#/, '').trim();
        if (clean) tags.add(clean);
      });
    }
  });

  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const re = /(^|[\s(])#([A-Za-z][A-Za-z0-9_\-/]*)/g;
  let m;
  while ((m = re.exec(withoutCode)) !== null) {
    tags.add(m[2]);
  }
  return Array.from(tags);
}


// ===========================================================================
// Frontmatter query engine — a small Dataview-style layer over the vault.
//
// Every note becomes a "page" object: its YAML frontmatter properties, plus
// any `key:: value` inline fields found in the body (the other real Dataview
// convention — this is what actually makes frontmatter *queryable* the way
// the person asked for, since most notes put ad hoc facts inline rather
// than in the frontmatter block), plus a reserved `file.*` namespace
// (name/path/folder/link/tags/ctime/mtime). A ```query fenced code block
// (```query or ```dataview, either works) is parsed as a small query
// language — TABLE / LIST / TASK, with FROM / WHERE / SORT / LIMIT — and
// rendered live wherever it appears, in both reading view and the
// CodeMirror live-preview block widgets.
// ===========================================================================

// Dataview's other core convention: a bare `key:: value` line anywhere in
// a note's body (optionally as a list item, `- key:: value`) is a field on
// that page, same as a frontmatter property. Skips fenced code so a code
// sample containing "foo:: bar" doesn't leak into the index.
function extractInlineFields(body) {
  if (!body) return [];
  const withoutFences = body.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /^\s*(?:[-*]\s+)?\[?([A-Za-z_][\w \-]*?)\]?::\s*(.+)$/gm;
  let m2;
  while ((m2 = re.exec(withoutFences))) {
    out.push({ key: m2[1].trim(), value: m2[2].trim() });
  }
  return out;
}


// Turns a raw frontmatter/inline-field string into a typed JS value so
// queries can compare numbers as numbers, dates as dates, etc., rather
// than doing string comparison on everything. `[[Link]]` values become a
// small `{ type: 'link', target, display }` record that both the renderer
// and the query comparators know how to unwrap.
function coercePropertyValue(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === '' || value == null) return null;
  if (typeof value !== 'string') return value;
  const wikilink = value.match(/^\[\[([^\]|]+)(\|([^\]]+))?\]\]$/);
  if (wikilink) return { type: 'link', target: wikilink[1].trim(), display: (wikilink[3] || wikilink[1]).trim() };
  if (/^\[.*\]$/.test(value)) {
    const items = splitListValue(value);
    if (items.length) return items.map((i) => coercePropertyValue(i));
  }
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return { type: 'date', value: d, raw: value };
  }
  if (/^["'].*["']$/.test(value)) return value.slice(1, -1);
  return value;
}

export { parseWikilinks, parseFrontmatter, splitListValue, extractTags, extractInlineFields, coercePropertyValue };
