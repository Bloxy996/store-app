// ---------------------------------------------------------------------------
// Compile / Apply — bundles a chosen slice of the vault's .md notes into one
// XML blob for pasting into an LLM conversation, and parses the matching
// `<update>/<change>` XML an LLM replies with back into concrete
// search/replace edits. Pure logic only (no Drive calls, no React) so the
// matching/parsing rules can be reasoned about — and, if this project ever
// adds tests, tested — independent of the panel UI or Drive I/O.
// ---------------------------------------------------------------------------

// The example in the spec uses "vault" as the root segment regardless of
// the Drive folder's real name — every compiled/applied path is rooted at
// this fixed label rather than `folder.name`, so a compiled XML file stays
// valid if the same vault is ever reconnected under a different Drive
// folder name.
const VAULT_ROOT_LABEL = 'vault';

// Walks buildVaultTree's output once into two flat lookup lists: every
// folder's id + full path, and every note (.md) file's id + full path.
// Both include/exclude lists, the apply-XML importer's path->id
// resolution, and create/delete's path->folder-id resolution are all built
// from this same single walk rather than several separate ones.
function flattenVaultTree(tree) {
  const folders = []; // { id, path }
  const files = []; // { id, path }
  const walk = (nodes, prefix) => {
    nodes.forEach((node) => {
      const path = `${prefix}/${node.name}`;
      if (node.type === 'folder') {
        folders.push({ id: node.id, path });
        walk(node.children || [], path);
      } else if (node.kind === 'note') {
        files.push({ id: node.id, path });
      }
    });
  };
  walk(tree || [], VAULT_ROOT_LABEL);
  return { folders, files };
}

// Resolves a folder path (e.g. from splitNotePath below) to a Drive folder
// id — the vault root label itself resolves to `rootFolderId` (a top-level
// note's "parent folder" is the vault root, which isn't in `folders`
// itself since flattenVaultTree only walks children of the root). Returns
// null if the path doesn't match any existing folder — callers treat that
// as "create the folder first" rather than guessing/auto-creating one.
function folderIdForPath(folders, rootFolderId, folderPath) {
  if (folderPath === VAULT_ROOT_LABEL) return rootFolderId;
  return folders.find((f) => f.path === folderPath)?.id ?? null;
}

// Splits a full note path into its parent folder's path and the note's own
// raw name (`driveCreateFile` accepts the name with or without the `.md`
// suffix, so this doesn't need to strip it).
function splitNotePath(path) {
  const idx = path.lastIndexOf('/');
  return { parentPath: path.slice(0, idx), rawName: path.slice(idx + 1) };
}

// True if `path` is exactly `prefix` or nested under it (`prefix/...`) —
// the shared "does this include/exclude entry cover this file" rule for
// both folder and file entries (a file entry only ever matches itself).
function pathCoveredBy(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// Resolves the include/exclude lists (arrays of path strings, each either a
// folder or a file path picked from the autocomplete) against the vault
// tree into the concrete list of note files to compile. Empty `includes`
// means "everything in the vault" per the original request.
function resolveIncludedFiles(tree, includes, excludes) {
  const { files } = flattenVaultTree(tree);
  const included = !includes.length ? files : files.filter((f) => includes.some((inc) => pathCoveredBy(f.path, inc)));
  return included.filter((f) => !excludes.some((exc) => pathCoveredBy(f.path, exc)));
}

// Minimal XML-attribute escaping — file content itself goes inside a CDATA
// section (see buildCompiledXml) so it never needs entity-escaping and stays
// byte-for-byte round-trippable; only the `path="..."` attribute value
// needs this.
function escapeXmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// The exact mass-editing output format from the original request, shipped
// alongside the compiled document so pasting one blob into Claude gives it
// both the content and the instructions for how to reply.
const APPLY_FORMAT_PROMPT = `You are a mass-editing assistant. You must output your changes using the following strict XML format.

To edit an existing note, use <update> with one or more <change> blocks. Do not output the entire file — only the lines that change.
CRITICAL: Inside the <search> block, you MUST include at least two lines of unchanged text before and after the line(s) you are changing to ensure the match is 100% unique within the file.
<update path="vault/Projects/App.md">
  <change>
    <search>
    [Exact unique lines to find]
    </search>
    <replace>
    [Exact lines to replace them with]
    </replace>
  </change>
</update>

To create a new note, use <create> with the note's full content as its text. The parent folder in the path must already exist in the vault — this does not create folders.
<create path="vault/Projects/New Note.md">
[Full markdown content of the new note]
</create>

To delete a note, use a self-closing <delete>.
<delete path="vault/Projects/Old Note.md" />`;

// `files`: [{ path, content }]. CDATA keeps every note's raw content
// (including its own literal `<`/`&`/wikilinks) safe without per-character
// escaping — the only thing that breaks CDATA is a literal `]]>`, handled
// by splitting it across two sections the way every CDATA-writer does.
function buildCompiledXml(files) {
  const body = files
    .map((f) => {
      const safeContent = f.content.replace(/]]>/g, ']]]]><![CDATA[>');
      return `  <file path="${escapeXmlAttr(f.path)}"><![CDATA[\n${safeContent}\n]]></file>`;
    })
    .join('\n');
  return `<documents>\n${body}\n</documents>`;
}

// Strips exactly one leading and one trailing newline-plus-indentation from
// a <search>/<replace> text node — the artifact of the block being
// pretty-printed on its own lines in the XML — while leaving every other
// byte (including internal indentation) untouched, since that's the actual
// file content being matched/inserted.
function trimXmlBlockText(text) {
  return (text || '').replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

// Parses an LLM's reply containing `<update>`, `<create>`, and/or
// `<delete>` blocks (see APPLY_FORMAT_PROMPT for the exact shape of each).
// Returns { updates, creates, deletes, parseError }:
//   - `updates`: [{ path, changes: [{ search, replace }] }]
//   - `creates`: [{ path, content }]
//   - `deletes`: [{ path }]
// A malformed document (not XML at all, or none of the three element
// types present) sets `parseError` instead of throwing, since this is
// user-pasted/uploaded input, not trusted data.
function parseApplyXml(xmlText) {
  const empty = { updates: [], creates: [], deletes: [] };
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  } catch {
    return { ...empty, parseError: 'Could not parse this as XML.' };
  }
  if (doc.querySelector('parsererror')) return { ...empty, parseError: 'Could not parse this as XML.' };
  const updateEls = Array.from(doc.querySelectorAll('update'));
  const createEls = Array.from(doc.querySelectorAll('create'));
  const deleteEls = Array.from(doc.querySelectorAll('delete'));
  if (!updateEls.length && !createEls.length && !deleteEls.length) {
    return { ...empty, parseError: 'No <update>, <create>, or <delete> blocks found in this document.' };
  }
  const updates = updateEls.map((el) => ({
    path: el.getAttribute('path') || '',
    changes: Array.from(el.querySelectorAll('change')).map((c) => ({
      search: trimXmlBlockText(c.querySelector('search')?.textContent),
      replace: trimXmlBlockText(c.querySelector('replace')?.textContent)
    }))
  }));
  const creates = createEls.map((el) => ({
    path: el.getAttribute('path') || '',
    content: trimXmlBlockText(el.textContent)
  }));
  const deletes = deleteEls.map((el) => ({ path: el.getAttribute('path') || '' }));
  return { updates, creates, deletes, parseError: null };
}

// Applies one update's changes to `content` in order, left to right,
// requiring each `search` to match exactly once (per the format prompt's
// own uniqueness requirement) — 0 or 2+ matches is reported rather than
// guessed at, since silently picking a match would risk editing the wrong
// occurrence. Later changes in the same file see earlier changes' output,
// so multiple edits to one file compose correctly even when a later
// search string only exists after an earlier replace runs.
function applyFileChanges(content, changes) {
  let next = content;
  const results = [];
  changes.forEach((change, i) => {
    if (!change.search) {
      results.push({ index: i, status: 'empty_search' });
      return;
    }
    const count = next.split(change.search).length - 1;
    if (count === 0) {
      results.push({ index: i, status: 'not_found' });
    } else if (count > 1) {
      results.push({ index: i, status: 'ambiguous', count });
    } else {
      next = next.replace(change.search, () => change.replace);
      results.push({ index: i, status: 'applied' });
    }
  });
  return { content: next, results };
}

export {
  VAULT_ROOT_LABEL,
  flattenVaultTree,
  folderIdForPath,
  splitNotePath,
  resolveIncludedFiles,
  buildCompiledXml,
  parseApplyXml,
  applyFileChanges,
  APPLY_FORMAT_PROMPT
};
