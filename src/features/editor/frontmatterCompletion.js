import { findPropertyDef, frontmatterRangeAt, usedKeys } from '../../lib/frontmatterSchema.js';

// ---------------------------------------------------------------------------
// Frontmatter key/value autocomplete, driven by lib/frontmatterSchema.js.
// Same shape as wikilinkTagCompletionSource (ctx getters -> CompletionSource)
// so it plugs into the same `autocompletion({ override: [...] })` list in
// CodeMirrorNoteEditor. Only ever active with the cursor inside a leading
// "---\n...\n---" block; returns null everywhere else so it never competes
// with wikilink/tag completion in the note body.
// ---------------------------------------------------------------------------
function frontmatterCompletionSource(ctx) {
  return (context) => {
    const doc = context.state.doc.toString();
    const range = frontmatterRangeAt(doc, context.pos);
    if (!range) return null;
    const schema = ctx.getFrontmatterSchema();
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = doc.slice(line.from, context.pos);

    // "key: partial-value" — offer this key's schema value options once a
    // key with any are being typed after its colon.
    const kv = /^(\s*)([^:#\s][^:]*):\s*(\S*)$/.exec(beforeCursor);
    if (kv) {
      const def = findPropertyDef(schema, kv[2].trim());
      if (!def || !def.valueOptions?.length) return null;
      const query = kv[3].toLowerCase();
      const options = def.valueOptions
        .filter((v) => v.toLowerCase().includes(query))
        .map((value) => ({
          label: value,
          apply: (view, completion, from, to) => {
            // Picking a value that has children (e.g. `type: game`) also
            // stubs in the properties that value implies, right below this
            // line — skipping any already present anywhere in the block so
            // re-picking the same value twice doesn't duplicate lines.
            const already = usedKeys(range.inner);
            const stub = (def.childrenByValue?.[value] || [])
              .filter((c) => !already.has(c.key))
              .map((c) => `\n${kv[1]}${c.key}: ${c.insert || ''}`)
              .join('');
            view.dispatch({
              changes: { from, to, insert: value + stub },
              selection: { anchor: from + value.length }
            });
          }
        }));
      if (!options.length) return null;
      return { from: line.from + kv[1].length + kv[2].length + 2, options, filter: false };
    }

    // A line with no ":" yet — key completion, offering only schema
    // properties not already present in this frontmatter block.
    const keyMatch = /^(\s*)([\w-]*)$/.exec(beforeCursor);
    if (keyMatch) {
      const already = usedKeys(range.inner);
      const query = keyMatch[2].toLowerCase();
      const options = (schema.properties || [])
        .filter((p) => !already.has(p.key) && p.key.toLowerCase().includes(query))
        .map((p) => ({ label: p.key, apply: `${p.key}: ` }));
      if (!options.length) return null;
      return { from: line.from + keyMatch[1].length, options, filter: false };
    }

    return null;
  };
}

export { frontmatterCompletionSource };
