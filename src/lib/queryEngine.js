import { coercePropertyValue, extractInlineFields, extractTags, parseFrontmatter, splitListValue } from './markdownParse.js';


// One "page" per note: reserved `file.*` metadata plus every frontmatter
// property and inline field, lowercased for case-insensitive lookup
// (frontmatter wins on a key collision with an inline field — the more
// deliberate, structured source). Rebuilt whenever the vault's indexed
// note bodies change (`getBody`'s backing cache version), same dependency
// pattern the existing tag index already uses.
function buildPagesIndex(filesMeta, linkIndex, getBody) {
  const pages = [];
  const byId = new Map();
  const recordById = new Map(linkIndex.records.map((r) => [r.id, r]));
  for (const f of filesMeta) {
    if (f.kind !== 'note') continue;
    const record = recordById.get(f.id) || f;
    const raw = getBody(f.id) || '';
    const { properties, body } = parseFrontmatter(raw);
    const props = {};
    const setProp = (key, rawVal) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k || k === 'file' || k in props) return;
      if (/^(tags?|aliases?)$/.test(k)) props[k] = splitListValue(rawVal).map((v) => v.replace(/^#/, ''));
      else props[k] = coercePropertyValue(rawVal);
    };
    properties.forEach((p) => setProp(p.key, p.value));
    extractInlineFields(body).forEach((p) => setProp(p.key, p.value));
    const page = {
      ...props,
      file: {
        id: f.id,
        name: record.baseName || f.name,
        path: record.relativePath || f.name,
        folder: record.dir || '',
        link: { type: 'link', target: record.relativePath || record.baseName || f.name, display: record.baseName || f.name },
        tags: extractTags(raw),
        ctime: f.createdTime ? { type: 'date', value: new Date(f.createdTime), raw: f.createdTime } : null,
        mtime: f.modifiedTime ? { type: 'date', value: new Date(f.modifiedTime), raw: f.modifiedTime } : null
      }
    };
    pages.push(page);
    byId.set(f.id, page);
  }
  return { pages, byId };
}


// ---------------------------------------------------------------------------
// Query expression parser — a small recursive-descent boolean expression
// grammar shared by both FROM (source selection: #tags, "folders", AND/OR/-)
// and WHERE (field comparisons: =, !=, <, <=, >, >=, contains(), exists()).
// Same AST either way; FROM and WHERE differ only in how a bare string/
// field atom is *evaluated* (folder-prefix match vs. truthiness) — see
// evalSourceNode vs evalNode below.
// ---------------------------------------------------------------------------
function tokenizeQueryExpr(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { tokens.push({ type: c }); i++; continue; }
    if (c === '-') { tokens.push({ type: 'NOT' }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== quote) { s += src[j]; j++; }
      tokens.push({ type: 'string', value: s });
      i = j + 1;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < n && /[\w/-]/.test(src[j])) j++;
      tokens.push({ type: 'tag', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (src.startsWith('[[', i)) {
      let j = src.indexOf(']]', i + 2);
      if (j === -1) j = n;
      tokens.push({ type: 'link', value: src.slice(i + 2, j) });
      i = j + 2;
      continue;
    }
    if (/[<>=!]/.test(c)) {
      let op = c;
      if (src[i + 1] === '=') { op += '='; i += 2; } else { i += 1; }
      tokens.push({ type: 'op', value: op });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w./-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper });
      else if (upper === 'TRUE') tokens.push({ type: 'bool', value: true });
      else if (upper === 'FALSE') tokens.push({ type: 'bool', value: false });
      else if (['CONTAINS', 'ICONTAINS', 'EXISTS'].includes(upper)) tokens.push({ type: 'func', value: upper.toLowerCase() });
      else tokens.push({ type: 'field', value: word });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}


function parseQueryExprTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'OR') { next(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().type === 'AND') { next(); left = { type: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (peek() && peek().type === 'NOT') { next(); return { type: 'not', expr: parseNot() }; }
    return parseComparison();
  }
  function parseComparison() {
    const left = parseAtomOrCall();
    if (peek() && peek().type === 'op') {
      const op = next().value;
      return { type: 'cmp', op, left, right: parseAtomOrCall() };
    }
    return left;
  }
  function parseAtomOrCall() {
    const t = peek();
    if (!t) return { type: 'lit', value: null };
    if (t.type === '(') {
      next();
      const inner = parseOr();
      if (peek() && peek().type === ')') next();
      return inner;
    }
    if (t.type === 'func') {
      next();
      const args = [];
      if (peek() && peek().type === '(') {
        next();
        while (peek() && peek().type !== ')') {
          args.push(parseAtomOrCall());
          if (peek() && peek().type === ',') next();
        }
        if (peek() && peek().type === ')') next();
      }
      return { type: 'call', fn: t.value, args };
    }
    if (t.type === 'string') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'number') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'bool') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'tag') { next(); return { type: 'tag', value: t.value }; }
    if (t.type === 'link') { next(); return { type: 'link', value: t.value }; }
    if (t.type === 'field') { next(); return { type: 'field', path: t.value }; }
    next();
    return { type: 'lit', value: null };
  }
  return parseOr();
}


function parseQueryExpr(src) {
  if (!src || !src.trim()) return null;
  return parseQueryExprTokens(tokenizeQueryExpr(src));
}


function getFieldValue(page, path) {
  const parts = String(path || '').split('.');
  let cur = page;
  for (const part of parts) {
    if (cur == null) return undefined;
    const key = part.toLowerCase();
    cur = cur[key] !== undefined ? cur[key] : cur[part];
  }
  return cur;
}


function coerceForCompare(v) {
  if (v && typeof v === 'object' && v.type === 'date') return v.value.getTime();
  if (v && typeof v === 'object' && v.type === 'link') return v.display || v.target;
  return v;
}


function valuesEqual(a, b) {
  const ca = coerceForCompare(a);
  const cb = coerceForCompare(b);
  if (typeof ca === 'string' && typeof cb === 'string') return ca.toLowerCase() === cb.toLowerCase();
  return ca === cb;
}


function compareValues(a, b) {
  const ca = coerceForCompare(a);
  const cb = coerceForCompare(b);
  if (ca == null || cb == null) return null;
  if (typeof ca === 'number' && typeof cb === 'number') return ca < cb ? -1 : ca > cb ? 1 : 0;
  const sa = String(ca).toLowerCase();
  const sb = String(cb).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}


function resolveOperand(node, page) {
  if (!node) return undefined;
  if (node.type === 'field') return getFieldValue(page, node.path);
  if (node.type === 'lit' || node.type === 'tag' || node.type === 'link') return node.value;
  return evalNode(node, page);
}


// WHERE evaluation: a bare field is truthy-checked, everything else is a
// normal boolean-expression tree.
function evalNode(node, page) {
  if (!node) return true;
  switch (node.type) {
    case 'and': return !!(evalNode(node.left, page) && evalNode(node.right, page));
    case 'or': return !!(evalNode(node.left, page) || evalNode(node.right, page));
    case 'not': return !evalNode(node.expr, page);
    case 'cmp': {
      const left = resolveOperand(node.left, page);
      const right = resolveOperand(node.right, page);
      if (node.op === '=') return valuesEqual(left, right);
      if (node.op === '!=') return !valuesEqual(left, right);
      const c = compareValues(left, right);
      if (c === null) return false;
      if (node.op === '<') return c < 0;
      if (node.op === '<=') return c <= 0;
      if (node.op === '>') return c > 0;
      if (node.op === '>=') return c >= 0;
      return false;
    }
    case 'call': {
      if (node.fn === 'exists') {
        const v = resolveOperand(node.args[0], page);
        return v !== undefined && v !== null && v !== '';
      }
      if (node.fn === 'contains' || node.fn === 'icontains') {
        const hay = resolveOperand(node.args[0], page);
        const needle = resolveOperand(node.args[1], page);
        if (Array.isArray(hay)) return hay.some((h) => valuesEqual(h, needle));
        if (hay == null) return false;
        return String(coerceForCompare(hay)).toLowerCase().includes(String(coerceForCompare(needle)).toLowerCase());
      }
      return false;
    }
    case 'tag': {
      const q = node.value.toLowerCase();
      return (page.file?.tags || []).some((t) => t.toLowerCase() === q || t.toLowerCase().startsWith(`${q}/`));
    }
    case 'link': return (page.file?.path || '').toLowerCase() === node.value.toLowerCase();
    case 'field': {
      const v = getFieldValue(page, node.path);
      return v !== undefined && v !== null && v !== false && v !== '';
    }
    case 'lit': return !!node.value;
    default: return true;
  }
}


// FROM evaluation: a bare string/field atom means "this page's path is
// under this folder" (Dataview's `FROM "Projects"` convention) rather than
// a truthiness check — the one place FROM and WHERE actually diverge.
function evalSourceNode(node, page) {
  if (!node) return true;
  const path = (page.file?.path || '').toLowerCase();
  switch (node.type) {
    case 'and': return evalSourceNode(node.left, page) && evalSourceNode(node.right, page);
    case 'or': return evalSourceNode(node.left, page) || evalSourceNode(node.right, page);
    case 'not': return !evalSourceNode(node.expr, page);
    case 'tag': {
      const q = node.value.toLowerCase();
      return (page.file?.tags || []).some((t) => t.toLowerCase() === q || t.toLowerCase().startsWith(`${q}/`));
    }
    case 'link':
      return path === node.value.toLowerCase() || (page.file?.name || '').toLowerCase() === node.value.toLowerCase();
    case 'lit': {
      const folder = String(node.value || '').replace(/\/$/, '').toLowerCase();
      return path === folder || path.startsWith(`${folder}/`);
    }
    case 'field': {
      const folder = String(node.path || '').replace(/\/$/, '').toLowerCase();
      return path === folder || path.startsWith(`${folder}/`);
    }
    default: return true;
  }
}


// Splits a TABLE column spec ("file.name AS \"Note\", status, due") on
// top-level commas (respecting quotes) and pulls out any "AS <label>".
function parseQueryColumnList(text) {
  const parts = [];
  let cur = '';
  let inQuote = null;
  for (const ch of text) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = p.trim().match(/^(.+?)\s+AS\s+(.+)$/i);
    if (m) return { field: m[1].trim(), label: m[2].trim().replace(/^["']|["']$/g, '') };
    return { field: p.trim(), label: p.trim() };
  });
}


// Parses the whole fenced block's text: line 1 is `TABLE <cols>` / `LIST` /
// `TASK`; every following line is its own `FROM` / `WHERE` / `SORT` /
// `LIMIT` clause. One clause per line, matching how these queries are
// written in practice (and in every Dataview example the person is likely
// to already know).
function parseQueryBlock(raw) {
  const lines = (raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Empty query.' };
  const typeMatch = lines[0].match(/^(TABLE|LIST|TASK)\b(.*)$/i);
  if (!typeMatch) return { error: 'Query must start with TABLE, LIST, or TASK.' };
  const type = typeMatch[1].toUpperCase();
  const columns = type === 'TABLE' && typeMatch[2].trim() ? parseQueryColumnList(typeMatch[2].trim()) : [];
  let from = null;
  let where = null;
  let sort = [];
  let limit = null;
  for (const line of lines.slice(1)) {
    const m = line.match(/^(FROM|WHERE|SORT|LIMIT)\b(.*)$/i);
    if (!m) continue;
    const kw = m[1].toUpperCase();
    const val = m[2].trim();
    if (kw === 'FROM') from = val;
    else if (kw === 'WHERE') where = val;
    else if (kw === 'LIMIT') limit = parseInt(val, 10) || null;
    else if (kw === 'SORT') {
      sort = val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const sm = s.match(/^(.+?)\s+(ASC|DESC)$/i);
          return sm ? { field: sm[1].trim(), dir: sm[2].toUpperCase() } : { field: s, dir: 'ASC' };
        });
    }
  }
  return { type, columns, from, where, sort, limit, error: null };
}


function runVaultQuery(queryText, pagesIndex) {
  const q = parseQueryBlock(queryText);
  if (q.error) return { error: q.error };
  let fromNode;
  let whereNode;
  try {
    fromNode = q.from ? parseQueryExpr(q.from) : null;
    whereNode = q.where ? parseQueryExpr(q.where) : null;
  } catch {
    return { error: 'Could not parse FROM/WHERE.' };
  }
  let rows = pagesIndex.pages.filter((p) => (fromNode ? evalSourceNode(fromNode, p) : true));
  if (whereNode) rows = rows.filter((p) => evalNode(whereNode, p));
  if (q.sort.length) {
    rows = rows.slice().sort((a, b) => {
      for (const s of q.sort) {
        const c = compareValues(getFieldValue(a, s.field), getFieldValue(b, s.field)) ?? 0;
        if (c !== 0) return s.dir === 'DESC' ? -c : c;
      }
      return 0;
    });
  } else {
    rows = rows.slice().sort((a, b) => (a.file.name || '').localeCompare(b.file.name || ''));
  }
  if (q.limit) rows = rows.slice(0, q.limit);
  return { query: q, rows };
}

export { buildPagesIndex, tokenizeQueryExpr, parseQueryExprTokens, parseQueryExpr, getFieldValue, coerceForCompare, valuesEqual, compareValues, resolveOperand, evalNode, evalSourceNode, parseQueryColumnList, parseQueryBlock, runVaultQuery };
