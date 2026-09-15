import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { driveCreateFile, driveCreateFolder, driveGetFileContent, driveUpdateFileContent, driveUploadBinary } from '../lib/driveApi.js';
import {
  SPARK_ATTACHMENTS_FOLDER_NAME,
  SPARK_FILE_NAME,
  SPARK_FOLDER_NAME,
  buildSparkCategoryTree,
  buildSparksByFileId,
  buildSparksFromCapture,
  makeSparkId,
  parseSparkFile,
  serializeSparkFile
} from '../lib/sparkStore.js';
import { insertStatementsSorted } from '../lib/statementSort.js';

// ---------------------------------------------------------------------------
// Sparks — RAM-only, same "content lives in memory for the session, Drive
// is the source of truth" discipline as useVaultIndex's noteBodyCache (3.1).
// Nothing here ever touches IndexedDB: spark.txt is small (a session's
// worth of quick captures, not a vault of note bodies), so there's no
// perf reason to cache it locally, and every capture already round-trips
// to Drive immediately (no debounced/dirty-buffer save like notes have).
//
// Lazily creates `.store/` and `.store/spark.txt` on the FIRST capture, not
// eagerly on load — most sessions never open the Sparks panel, so most
// vaults never need this folder to exist at all.
// ---------------------------------------------------------------------------
function useSparks(token, folder, sync) {
  const [sparks, setSparks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Cached across renders so a second capture in the same session doesn't
  // re-resolve folder/file ids; reset whenever the vault folder changes.
  const idsRef = useRef({ folderId: null, sparkFileId: null, attachmentsFolderId: null });

  useEffect(() => {
    idsRef.current = { folderId: null, sparkFileId: null, attachmentsFolderId: null };
    setSparks([]);
    setLoaded(false);
  }, [folder?.id]);

  // Once useVaultSync's own sync pass has found (or not found) `.store/`,
  // load spark.txt if it's there. If it isn't, there's nothing to load yet
  // — the panel just shows zero sparks until the first capture creates it.
  useEffect(() => {
    if (!token || !folder?.id || loaded) return;
    if (!sync.internalFolder) {
      // Sync has run at least once (internalFiles is always an array) and
      // found no `.store/` folder — nothing to load, but still "loaded".
      if (sync.internalFiles) setLoaded(true);
      return;
    }
    const sparkFile = sync.internalFiles.find((f) => f.name === SPARK_FILE_NAME);
    idsRef.current.folderId = sync.internalFolder.id;
    if (!sparkFile) {
      setLoaded(true);
      return;
    }
    idsRef.current.sparkFileId = sparkFile.id;
    let cancelled = false;
    driveGetFileContent(token, sparkFile.id)
      .then((raw) => {
        if (cancelled) return;
        setSparks(parseSparkFile(raw));
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load sparks');
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, folder?.id, loaded, sync.internalFolder, sync.internalFiles]);

  // Ensures .store/ and .store/spark.txt exist, creating whichever is
  // missing, and returns their ids. Safe to call on every capture — it's a
  // no-op (just returns the cached ids) once both exist.
  const ensureSparkFile = useCallback(async () => {
    if (idsRef.current.sparkFileId) return idsRef.current;
    let folderId = idsRef.current.folderId;
    if (!folderId) {
      const created = await driveCreateFolder(token, folder.id, SPARK_FOLDER_NAME);
      folderId = created.id;
      idsRef.current.folderId = folderId;
    }
    const created = await driveCreateFile(token, folderId, SPARK_FILE_NAME, '', 'txt', 'text/plain');
    idsRef.current.sparkFileId = created.id;
    return idsRef.current;
  }, [token, folder?.id]);

  const ensureAttachmentsFolder = useCallback(async (parentFolderId) => {
    if (idsRef.current.attachmentsFolderId) return idsRef.current.attachmentsFolderId;
    const created = await driveCreateFolder(token, parentFolderId, SPARK_ATTACHMENTS_FOLDER_NAME);
    idsRef.current.attachmentsFolderId = created.id;
    return created.id;
  }, [token]);

  const persist = useCallback(
    async (nextSparks) => {
      const { sparkFileId } = await ensureSparkFile();
      await driveUpdateFileContent(token, sparkFileId, serializeSparkFile(nextSparks));
      setSparks(nextSparks);
    },
    [token, ensureSparkFile]
  );

  // { category, textLines, linkedFileIds, screenshotFile } -> saves one or
  // more new sparks (see buildSparksFromCapture for the split-vs-single
  // rule) and uploads the screenshot, if any, first.
  const addSparkCapture = useCallback(
    async ({ category, textLines, linkedFileIds, screenshotFile }) => {
      setBusy(true);
      setError('');
      try {
        let screenshotFileId = '';
        if (screenshotFile) {
          const { folderId } = await ensureSparkFile();
          const attachmentsFolderId = await ensureAttachmentsFolder(folderId);
          const uploaded = await driveUploadBinary(token, attachmentsFolderId, screenshotFile);
          screenshotFileId = uploaded.id;
        }
        const newSparks = buildSparksFromCapture({ category, textLines, linkedFileIds, screenshotFileId });
        if (!newSparks.length) return [];
        await persist([...sparks, ...newSparks]);
        return newSparks;
      } catch (err) {
        setError(err.message || 'Failed to save spark');
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [sparks, persist, ensureSparkFile, ensureAttachmentsFolder, token]
  );

  const deleteSpark = useCallback(
    async (id) => {
      setBusy(true);
      setError('');
      try {
        await persist(sparks.filter((s) => s.id !== id));
      } catch (err) {
        setError(err.message || 'Failed to delete spark');
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [sparks, persist]
  );

  const insertSortedStatements = useCallback(
    async (category, rawText, weights) => {
      setBusy(true);
      setError('');
      try {
        const positions = [];
        sparks.forEach((s, i) => {
          if (s.category === category) positions.push(i);
        });
        const existingPhrases = positions.map((i) => sparks[i].text);
        const { phrases: nextPhrases, report } = insertStatementsSorted(existingPhrases, rawText, weights);

        const now = Date.now();
        const byText = new Map(positions.map((i) => [sparks[i].text, sparks[i]]));
        const nextRecords = nextPhrases.map((text) => {
          const existing = byText.get(text);
          if (existing) return existing;
          return { id: makeSparkId(), createdAt: now, category, linkedFileIds: [], screenshotFileId: '', text };
        });

        const firstPos = positions.length ? positions[0] : sparks.length;
        const withoutCategory = [];
        let insertAt = 0;
        sparks.forEach((s, i) => {
          if (s.category === category) return;
          if (i < firstPos) insertAt++;
          withoutCategory.push(s);
        });
        const nextSparks = [...withoutCategory.slice(0, insertAt), ...nextRecords, ...withoutCategory.slice(insertAt)];

        await persist(nextSparks);
        return report;
      } catch (err) {
        setError(err.message || 'Failed to sort statements');
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [sparks, persist]
  );

  const categoryTree = useMemo(() => buildSparkCategoryTree(sparks), [sparks]);
  const sparksByFileId = useMemo(() => buildSparksByFileId(sparks), [sparks]);

  return {
    sparks,
    loaded,
    busy,
    error,
    addSparkCapture,
    deleteSpark,
    insertSortedStatements,
    categoryTree,
    sparksByFileId
  };
}

export { useSparks };
