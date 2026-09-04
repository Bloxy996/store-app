import { isAssetName, isImageName, opensInEditorPane } from './vaultConfig.js';


// ---------------------------------------------------------------------------
// Smart link resolution — mirrors how Obsidian resolves [[wikilinks]]:
//   - A link that's just a name ("Notes") matches by filename anywhere in
//     the vault, *as long as that name is unique*.
//   - If two or more files share that name, a bare name is ambiguous —
//     disambiguation requires the full path from the vault root
//     ("Projects/Notes").
//   - Note links omit the .md extension, same as before. Image links always
//     keep their extension (e.g. [[diagram.png]]) since that's the only way
//     to tell "diagram.png" and "diagram.svg" apart, and since an image
//     can't be created/renamed from inside a broken link the way a note can.
// ---------------------------------------------------------------------------
function buildLinkIndex(files, folders, rootId) {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const pathCache = new Map();

  function folderPath(folderId) {
    if (!folderId || folderId === rootId) return '';
    if (pathCache.has(folderId)) return pathCache.get(folderId);
    const f = folderById.get(folderId);
    if (!f) return '';
    const parentId = (f.parents && f.parents[0]) || rootId;
    const parentPath = folderPath(parentId);
    const full = parentPath ? `${parentPath}/${f.name}` : f.name;
    pathCache.set(folderId, full);
    return full;
  }

  const records = files.map((f) => {
    const parentId = (f.parents && f.parents[0]) || rootId;
    const dir = folderPath(parentId);
    const kind = f.kind || 'note';
    const isAsset = !opensInEditorPane(kind);
    const isImage = kind === 'image';
    const baseName = isAsset ? f.name : f.name.replace(/\.[^.]+$/i, '');
    const relativePath = dir ? `${dir}/${baseName}` : baseName;
    return { ...f, kind, isAsset, isImage, baseName, relativePath, dir };
  });

  const byBasenameKey = new Map();
  const byRelativePath = new Map();
  records.forEach((r) => {
    const key = `${r.isAsset ? 'asset' : 'note'}:${r.baseName.toLowerCase()}`;
    if (!byBasenameKey.has(key)) byBasenameKey.set(key, []);
    byBasenameKey.get(key).push(r);
    byRelativePath.set(r.relativePath.toLowerCase(), r);
  });

  return { records, byBasenameKey, byRelativePath, folderPath };
}


// Resolves the text inside a [[...]] (already stripped of any |alias or
// #heading) against the current vault. One of:
//   { status: 'resolved', file }
//   { status: 'missing', isAsset }                  -- no such file (yet)
//   { status: 'ambiguous', isAsset, candidates }      -- name matches 2+ files
// `isAsset` (any non-note file: image/video/audio/other) is kept alongside
// the old `isImage` name so existing callers that only cared about images
// still work unchanged for that subset.
function resolveLinkTarget(rawTarget, linkIndex) {
  const target = String(rawTarget || '').trim();
  const isAsset = isAssetName(target);
  const isImage = isImageName(target);
  const cleaned = isAsset ? target : target.replace(/\.md$/i, '');

  if (cleaned.includes('/')) {
    const hit = linkIndex.byRelativePath.get(cleaned.toLowerCase());
    return hit ? { status: 'resolved', file: hit } : { status: 'missing', isAsset, isImage };
  }

  const key = `${isAsset ? 'asset' : 'note'}:${cleaned.toLowerCase()}`;
  const matches = linkIndex.byBasenameKey.get(key) || [];
  if (matches.length === 1) return { status: 'resolved', file: matches[0] };
  if (matches.length === 0) return { status: 'missing', isAsset, isImage };
  return {
    status: 'ambiguous',
    isAsset,
    isImage,
    candidates: matches.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  };
}


// The link text to insert when autocomplete (or a "resolve this" action)
// picks `file` — the bare name if that's unambiguous vault-wide, otherwise
// the full path from the vault root. This is the other half of the smart
// linking behavior: it's what keeps typed links short by default.
function bestLinkTextFor(file, linkIndex) {
  const key = `${file.isAsset ? 'asset' : 'note'}:${file.baseName.toLowerCase()}`;
  const matches = linkIndex.byBasenameKey.get(key) || [];
  return matches.length <= 1 ? file.baseName : file.relativePath;
}


// Builds fileId -> Set(fileId) map of inbound links, resolved through the
// same smart resolver used for click-through and rendering (so backlinks
// stay consistent with what a link actually resolves to, ambiguous and
// missing links included/excluded the same way).
function buildBacklinkIndex(fileRecords, linksByFileId, linkIndex) {
  const backlinks = new Map();
  fileRecords.forEach((f) => backlinks.set(f.id, new Set()));

  for (const [sourceId, links] of linksByFileId.entries()) {
    for (const link of links) {
      const res = resolveLinkTarget(link.target, linkIndex);
      if (res.status === 'resolved' && res.file.id !== sourceId) {
        if (!backlinks.has(res.file.id)) backlinks.set(res.file.id, new Set());
        backlinks.get(res.file.id).add(sourceId);
      }
    }
  }
  return backlinks;
}


// Fuzzy subsequence matcher used by the quick switcher and command palette.
// Returns null on no match, otherwise a score where lower is better (so
// results sort ascending). Contiguous runs and early matches score better,
// same general idea as Obsidian's / VS Code's fuzzy finders.
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti - lastMatch - 1; // gap penalty
      if (lastMatch !== -1 && ti === lastMatch + 1) score -= 1; // contiguity bonus
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score += lastMatch; // prefer earlier overall matches
  return score;
}

export { buildLinkIndex, resolveLinkTarget, bestLinkTextFor, buildBacklinkIndex, fuzzyScore };
