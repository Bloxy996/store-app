import { useCallback, useEffect, useRef, useState } from 'react';

import { mapWithConcurrency, withRetry } from '../lib/concurrency.js';
import { driveGetFileContent } from '../lib/driveApi.js';
import { extractTags } from '../lib/markdownParse.js';
import { FETCH_CONCURRENCY } from '../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// RAM-only full-text search / tag index. `noteBodyCache` never touches
// IndexedDB — it exists purely so the current browser tab can search and
// list tags across the whole vault without re-fetching every note's body
// on every keystroke. It's rebuilt from Drive each time the page loads
// (see useVaultSync's sync pass, which seeds it for free) and wiped on
// sign-out / vault switch by releaseSearchIndex().
// ---------------------------------------------------------------------------
const noteBodyCache = new Map(); // fileId -> content string, RAM only

const searchIndexListeners = new Set();


function bumpSearchIndexVersion() {
  searchIndexListeners.forEach((fn) => fn());
}


function releaseSearchIndex() {
  noteBodyCache.clear();
  bumpSearchIndexVersion();
}


// Fetches (and caches) every note body not already in noteBodyCache, with
// bounded concurrency — the same approach useVaultSync uses for the
// wikilink pass. Called automatically in the background after the first
// sync, and again (awaited) the moment the Search or Tags panel opens, so
// results are never silently incomplete.
function useVaultIndex(token, filesMeta) {
  const [version, setVersion] = useState(0);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const inFlight = useRef(false);

  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    searchIndexListeners.add(listener);
    return () => searchIndexListeners.delete(listener);
  }, []);

  const ensureIndexed = useCallback(async () => {
    if (!token || inFlight.current) return;
    const notes = filesMeta.filter((f) => f.kind === 'note');
    const missing = notes.filter((f) => !noteBodyCache.has(f.id));
    if (!missing.length) return;
    inFlight.current = true;
    setBuilding(true);
    let loaded = 0;
    setProgress({ loaded: 0, total: missing.length });
    await mapWithConcurrency(missing, FETCH_CONCURRENCY, async (file) => {
      try {
        const content = await withRetry(() => driveGetFileContent(token, file.id));
        noteBodyCache.set(file.id, content);
      } catch {
        // leave it unindexed; a later sync/search retry can pick it up
      }
      loaded += 1;
      setProgress({ loaded, total: missing.length });
      if (loaded % 10 === 0) bumpSearchIndexVersion();
    });
    bumpSearchIndexVersion();
    inFlight.current = false;
    setBuilding(false);
  }, [token, filesMeta]);

  // Kick off background indexing shortly after the vault's file list first
  // appears, so Search/Tags are usually ready before the user opens them.
  useEffect(() => {
    if (!token || !filesMeta.length) return;
    const t = setTimeout(() => ensureIndexed(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filesMeta.length]);

  const getBody = useCallback((fileId) => noteBodyCache.get(fileId) || '', []);
  const updateBody = useCallback((fileId, content) => {
    noteBodyCache.set(fileId, content);
    bumpSearchIndexVersion();
  }, []);
  const indexedCount = filesMeta.filter((f) => f.kind === 'note' && noteBodyCache.has(f.id)).length;
  const totalNotes = filesMeta.filter((f) => f.kind === 'note').length;

  return {
    ensureIndexed,
    building,
    progress,
    getBody,
    updateBody,
    ready: indexedCount === totalNotes,
    indexedCount,
    totalNotes,
    version
  };
}


// Tag index: tag -> [{ file }] built from every indexed note's body.
function buildTagIndex(filesMeta, getBody) {
  const byTag = new Map();
  filesMeta.forEach((f) => {
    if (f.kind !== 'note') return;
    const body = getBody(f.id);
    if (!body) return;
    extractTags(body).forEach((tag) => {
      const key = tag.toLowerCase();
      if (!byTag.has(key)) byTag.set(key, { tag, files: [] });
      byTag.get(key).files.push(f);
    });
  });
  return Array.from(byTag.values()).sort((a, b) => a.tag.localeCompare(b.tag));
}


// Turns the flat tag list above into a nested-tag tree for display: every
// prefix of a nested tag ("project" and "project/alpha" for a note tagged
// #project/alpha) becomes its own row, with `depth` for indentation and
// `count` aggregating every distinct note tagged with it or any descendant.
// Clicking a parent row still works with search's existing `tag:` semantics
// (a tag search already matches descendants of the given prefix).
function buildTagTree(tagRows) {
  const filesByPath = new Map(); // full path -> Set(fileId)
  tagRows.forEach(({ tag, files }) => {
    const parts = tag.split('/');
    let path = '';
    parts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      if (!filesByPath.has(path)) filesByPath.set(path, new Set());
      files.forEach((f) => filesByPath.get(path).add(f.id));
    });
  });
  return Array.from(filesByPath.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const parts = path.split('/');
      return { path, name: parts[parts.length - 1], depth: parts.length - 1, count: filesByPath.get(path).size };
    });
}

export { noteBodyCache, searchIndexListeners, bumpSearchIndexVersion, releaseSearchIndex, useVaultIndex, buildTagIndex, buildTagTree };
