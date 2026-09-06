import { parseFrontmatter } from './markdownParse.js';

// ---------------------------------------------------------------------------
// Frontmatter property schema — the customizable model behind the
// GUIDE.md-style note-type workflow: base properties that offer value
// autocomplete, and a value -> child-properties map so picking a value
// (e.g. `type: game`) auto-adds the properties that value implies (e.g.
// `aliases`). Stored as plain user data (localStorage, same pattern as
// accent color in features/accent/accentColor.js) rather than hardcoded to
// GUIDE.md's five types, so it's genuinely editable via Settings
// (features/settings/FrontmatterSchemaSettings.jsx) and not a
// reimplementation of one specific guide.
// ---------------------------------------------------------------------------
const SCHEMA_STORAGE_KEY = 'vault_frontmatter_schema';

// Ships as the out-of-the-box schema so GUIDE.md's workflow works with zero
// setup; every field below is editable/removable afterward.
const DEFAULT_SCHEMA = {
  properties: [
    {
      key: 'type',
      valueOptions: ['info', 'entity', 'event', 'game', 'concept', 'reference'],
      childrenByValue: {
        entity: [{ key: 'aliases', insert: '[ALIAS]' }],
        event: [{ key: 'after', insert: '\n  - "[[]]"' }],
        game: [{ key: 'aliases', insert: '[ALIAS]' }],
        concept: [{ key: 'category', insert: '' }, { key: 'scale', insert: '' }],
        reference: [{ key: 'kind', insert: '' }, { key: 'genre', insert: '[]' }]
      }
    },
    { key: 'aliases', valueOptions: [] },
    {
      key: 'category',
      valueOptions: ['mechanic', 'ai', 'vfx', 'sfx', 'ui', 'task', 'mode', 'world', 'lore', 'style'],
      // "Mechanic is only used if the category is mechanic" (GUIDE.md).
      childrenByValue: { mechanic: [{ key: 'mechanic', insert: '' }] }
    },
    { key: 'mechanic', valueOptions: ['movement', 'combat', 'interaction', 'progression'] },
    { key: 'scale', valueOptions: ['high', 'med', 'low'] },
    { key: 'kind', valueOptions: ['game', 'tool', 'article'] },
    { key: 'genre', valueOptions: [] },
    { key: 'after', valueOptions: [] }
  ]
};

function cloneDefaultSchema() {
  return JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
}

function loadFrontmatterSchema() {
  try {
    const raw = localStorage.getItem(SCHEMA_STORAGE_KEY);
    if (!raw) return cloneDefaultSchema();
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.properties) ? parsed : cloneDefaultSchema();
  } catch {
    return cloneDefaultSchema();
  }
}

function saveFrontmatterSchema(schema) {
  try {
    localStorage.setItem(SCHEMA_STORAGE_KEY, JSON.stringify(schema));
  } catch {
    // localStorage unavailable (private mode, quota) — schema still applies
    // for this session via state, just won't persist. Same tradeoff
    // useAccentColor already accepts for the same storage mechanism.
  }
}

function findPropertyDef(schema, key) {
  return (schema?.properties || []).find((p) => p.key === key) || null;
}

// Character range of the inner YAML body of a leading "---\n...\n---" block
// in `docText`, or null if `pos` falls outside one. Reuses parseFrontmatter's
// own delimiter regex (CLAUDE.md 3.4 — one source of truth for what counts
// as a frontmatter block) rather than re-deriving the "---" match here.
function frontmatterRangeAt(docText, pos) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(docText || '');
  if (!m) return null;
  const innerStart = docText.indexOf('\n') + 1;
  const innerEnd = innerStart + m[1].length;
  if (pos < innerStart || pos > innerEnd) return null;
  return { innerStart, innerEnd, inner: m[1] };
}

function usedKeys(innerText) {
  return new Set(parseFrontmatter(`---\n${innerText}\n---\n`).properties.map((p) => p.key));
}

// Compact text format the Settings panel edits directly instead of raw
// JSON: one line per value, "value: key=insert, key2=insert2".
function serializeChildrenByValue(childrenByValue) {
  return Object.entries(childrenByValue || {})
    .map(([value, children]) => `${value}: ${(children || []).map((c) => `${c.key}=${c.insert || ''}`).join(', ')}`)
    .join('\n');
}

function parseChildrenByValue(text) {
  const out = {};
  (text || '').split('\n').forEach((line) => {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) return;
    const value = m[1].trim();
    if (!value) return;
    const children = m[2]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf('=');
        return eq === -1 ? { key: part, insert: '' } : { key: part.slice(0, eq).trim(), insert: part.slice(eq + 1).trim() };
      })
      .filter((c) => c.key);
    if (children.length) out[value] = children;
  });
  return out;
}

export {
  SCHEMA_STORAGE_KEY,
  DEFAULT_SCHEMA,
  loadFrontmatterSchema,
  saveFrontmatterSchema,
  findPropertyDef,
  frontmatterRangeAt,
  usedKeys,
  serializeChildrenByValue,
  parseChildrenByValue
};
