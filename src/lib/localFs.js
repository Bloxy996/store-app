// ---------------------------------------------------------------------------
// Local-disk counterpart to the Drive-backed vault: lets the Compile/Apply
// mass-edit workflow (compile/compileVault.js) run against a folder on the
// user's own machine instead of the Drive vault. Ported from
// temp/processing/converters/reader.py, but reuses the SAME XML compile/
// apply format compileVault.js already has (buildCompiledXml/
// parseApplyXml/applyFileChanges) rather than that script's own plain-text
// `==== FILE: path ====` divider format — one mass-edit format for both
// sources, not two, and it means an LLM reply already understood for the
// vault works unchanged against a local folder.
//
// Runs entirely in the browser via the File System Access API
// (showDirectoryPicker + FileSystemFileHandle read/write) — nothing here
// goes through the backend or Drive, and no handle is ever persisted
// (same "nothing kept beyond the session unless the user asks" spirit as
// 3.1 — re-pick the folder each session). Chromium-based browsers only as
// of writing; isLocalFsSupported() lets callers show a plain message
// instead of a broken picker on Firefox/Safari.
// ---------------------------------------------------------------------------

const LOCAL_ROOT_LABEL = 'local';

const DEFAULT_TEXT_EXTS = ['.md', '.txt', '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.py', '.yml', '.yaml', '.sh', '.mjs', '.cjs'];

function isLocalFsSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

async function pickLocalDirectory() {
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

// Same prefix-match rule as compileVault.js's pathCoveredBy, applied to
// "local/sub/dir/file.ext" paths — kept as its own copy rather than a
// shared import since compileVault.js is meant to stay Drive-agnostic
// pure logic (3.3); this is the one line where the two would otherwise
// need to share.
function pathCoveredBy(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function extOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

async function* walkLocalDirectory(dirHandle, path = LOCAL_ROOT_LABEL) {
  for await (const [name, handle] of dirHandle.entries()) {
    const childPath = `${path}/${name}`;
    if (handle.kind === 'directory') {
      yield* walkLocalDirectory(handle, childPath);
    } else {
      yield { path: childPath, handle };
    }
  }
}

// Flattens every matching file's path under a picked directory — the
// local-disk analogue of compile/CompilePanel.jsx's PathChipInput options
// (flattenVaultTree), for populating an Includes/Excludes autocomplete
// without reading file bodies yet.
async function listLocalPaths(dirHandle) {
  const paths = [];
  for await (const { path } of walkLocalDirectory(dirHandle)) paths.push(path);
  return paths.sort((a, b) => a.localeCompare(b));
}

// Reads every matching file's text content — local-disk equivalent of
// compileVault.js's resolveIncludedFiles + getBody, combined, since there's
// no separate tree structure to resolve paths against on disk.
async function readLocalFiles(dirHandle, { exts, includes = [], excludes = [] } = {}) {
  const extList = exts && exts.length ? exts : DEFAULT_TEXT_EXTS;
  const extSet = new Set(extList.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
  const files = [];
  for await (const { path, handle } of walkLocalDirectory(dirHandle)) {
    if (extSet.size && !extSet.has(extOf(path))) continue;
    if (includes.length && !includes.some((inc) => pathCoveredBy(path, inc))) continue;
    if (excludes.some((exc) => pathCoveredBy(path, exc))) continue;
    const file = await handle.getFile();
    files.push({ path, content: await file.text() });
  }
  return files;
}

// Resolves "local/a/b/c.md" to its parent directory handle, creating
// intermediate directories as needed (for <create>'s new files).
async function ensureParentDir(rootHandle, path) {
  const parts = path.split('/').slice(1, -1); // drop LOCAL_ROOT_LABEL and the filename
  let dir = rootHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

async function writeLocalFile(rootHandle, path, content) {
  const dir = await ensureParentDir(rootHandle, path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function deleteLocalFile(rootHandle, path) {
  const dir = await ensureParentDir(rootHandle, path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  await dir.removeEntry(name).catch(() => {}); // already gone is fine
}

// Applies a parsed apply-XML document (compileVault.js's parseApplyXml) to
// files on disk — the local-disk twin of App.jsx's applyCompiledChanges.
// Takes applyFileChanges as a parameter rather than importing it, so the
// one search/replace implementation stays in compileVault.js (3.4) and
// this file only adds the disk I/O around it.
async function applyLocalChanges(rootHandle, { updates, creates, deletes }, applyFileChanges) {
  const results = { files: [] };
  for (const { path, changes } of updates) {
    try {
      const dir = await ensureParentDir(rootHandle, path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      const fileHandle = await dir.getFileHandle(name);
      const original = await (await fileHandle.getFile()).text();
      const { content, results: changeResults } = applyFileChanges(original, changes);
      const failed = changeResults.filter((r) => r.status !== 'applied');
      if (failed.length) {
        results.files.push({ path, ok: false, message: `${failed.length} of ${changes.length} change(s) failed` });
        continue;
      }
      await writeLocalFile(rootHandle, path, content);
      results.files.push({ path, ok: true, message: 'Updated' });
    } catch (err) {
      results.files.push({ path, ok: false, message: err.message || 'Failed to update' });
    }
  }
  for (const { path, content } of creates) {
    try {
      await writeLocalFile(rootHandle, path, content);
      results.files.push({ path, ok: true, message: 'Created' });
    } catch (err) {
      results.files.push({ path, ok: false, message: err.message || 'Failed to create' });
    }
  }
  for (const { path } of deletes) {
    try {
      await deleteLocalFile(rootHandle, path);
      results.files.push({ path, ok: true, message: 'Deleted' });
    } catch (err) {
      results.files.push({ path, ok: false, message: err.message || 'Failed to delete' });
    }
  }
  return results;
}

export {
  LOCAL_ROOT_LABEL,
  DEFAULT_TEXT_EXTS,
  isLocalFsSupported,
  pickLocalDirectory,
  walkLocalDirectory,
  listLocalPaths,
  readLocalFiles,
  applyLocalChanges
};
