// ---------------------------------------------------------------------------
// Sparks — quick one-line captures (text or a screenshot + caption), each
// filed under a nested category (same "a/b/c" convention as tags) and
// optionally linked to one or more vault notes/files.
//
// Storage: a single plain-text file, `.store/spark.txt`, inside the vault's
// Drive folder — NOT a regular vault note. It is deliberately excluded from
// the file tree, search, the wikilink graph, and the tag index (see
// `splitInternalVaultData` below, applied in `useVaultSync.js`) so it never
// shows up as something the user browses to directly, per the original
// request ("stuff the user isn't supposed to directly access").
//
// File format: one spark per line, tab-separated fields (a spark's own text
// is inherently one line — see `serializeSparkText` below for how a literal
// tab/newline typed into that text is handled). This is a real plain-text
// file on purpose (not JSON) — it stays trivially readable/appendable by
// something outside this app (e.g. a future minimal native writer) without
// needing a JSON parser.
//
//   id \t createdAt \t category \t linkedFileIds(comma) \t screenshotFileId \t text
//
// Screenshot bytes are never inlined here — they're uploaded as their own
// image file (via driveUploadBinary, same as any other vault image) into
// `.store/spark-attachments/`, and this file only stores that file's id, so
// spark.txt itself stays tiny and diffable.
// ---------------------------------------------------------------------------

const SPARK_FOLDER_NAME = '.store';
const SPARK_ATTACHMENTS_FOLDER_NAME = 'spark-attachments';
const SPARK_FILE_NAME = 'spark.txt';

const FIELD_SEP = '\t';
const LINE_SEP = '\n';

function makeSparkId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A spark's text is inherently one line (that's the whole point — newlines
// in the capture textarea split into separate sparks before this ever
// runs). Strip anything that would break the one-line-per-record format if
// it slipped through anyway (a pasted tab/newline).
function sanitizeSparkField(s) {
  return (s || '').replace(/[\t\n\r]+/g, ' ').trim();
}

function parseSparkFile(raw) {
  if (!raw) return [];
  return raw
    .split(LINE_SEP)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, createdAt, category, linkedIds, screenshotFileId, ...rest] = line.split(FIELD_SEP);
      return {
        id: id || makeSparkId(),
        createdAt: Number(createdAt) || Date.now(),
        category: category || '',
        linkedFileIds: (linkedIds || '').split(',').map((s) => s.trim()).filter(Boolean),
        screenshotFileId: screenshotFileId || '',
        // The text itself may legitimately contain the field separator if a
        // very old/foreign line ever had one — rejoin defensively.
        text: rest.join(FIELD_SEP)
      };
    });
}

function serializeSparkFile(sparks) {
  return sparks
    .map((s) =>
      [
        s.id,
        s.createdAt,
        sanitizeSparkField(s.category),
        (s.linkedFileIds || []).join(','),
        s.screenshotFileId || '',
        sanitizeSparkField(s.text)
      ].join(FIELD_SEP)
    )
    .join(LINE_SEP);
}

// Builds one or more new spark records from a single capture-form
// submission. `textLines` is the raw (possibly multi-line) textarea value;
// each non-empty line becomes its own spark sharing `category`/
// `linkedFileIds`, EXCEPT when a screenshot is attached — a screenshot is
// one artifact, so it becomes exactly one spark, and the whole textarea
// value (not split) becomes that spark's caption instead.
function buildSparksFromCapture({ category, textLines, linkedFileIds, screenshotFileId }) {
  const cleanCategory = sanitizeSparkField(category);
  const now = Date.now();
  if (screenshotFileId) {
    return [
      {
        id: makeSparkId(),
        createdAt: now,
        category: cleanCategory,
        linkedFileIds: linkedFileIds || [],
        screenshotFileId,
        text: sanitizeSparkField((textLines || '').replace(/\n/g, ' '))
      }
    ];
  }
  return (textLines || '')
    .split('\n')
    .map((line) => sanitizeSparkField(line))
    .filter(Boolean)
    .map((text) => ({
      id: makeSparkId(),
      createdAt: now,
      category: cleanCategory,
      linkedFileIds: linkedFileIds || [],
      screenshotFileId: '',
      text
    }));
}

// Nested-category tree, same shape/behavior as useVaultIndex.js's
// buildTagTree — every prefix of "vehicles/boat/small" becomes its own row
// with a rolled-up count, so the category autocomplete and the browse tree
// share one calculation (3.4).
function buildSparkCategoryTree(sparks) {
  const countByPath = new Map();
  sparks.forEach((s) => {
    if (!s.category) return;
    const parts = s.category.split('/').filter(Boolean);
    let path = '';
    parts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      countByPath.set(path, (countByPath.get(path) || 0) + 1);
    });
  });
  return Array.from(countByPath.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const parts = path.split('/');
      return { path, name: parts[parts.length - 1], depth: parts.length - 1, count: countByPath.get(path) };
    });
}

// All distinct category paths, for the capture form's autocomplete —
// leaf-or-not doesn't matter there, any existing path (full or partial) is
// a valid suggestion to complete to.
function allSparkCategoryPaths(sparks) {
  const set = new Set();
  sparks.forEach((s) => {
    if (s.category) set.add(s.category);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// fileId -> Spark[] for the "this note has N sparks" indicator, both on the
// note itself and (reverse lookup, same map) from the spark's own row.
function buildSparksByFileId(sparks) {
  const map = new Map();
  sparks.forEach((s) => {
    (s.linkedFileIds || []).forEach((fid) => {
      if (!map.has(fid)) map.set(fid, []);
      map.get(fid).push(s);
    });
  });
  return map;
}

// ---------------------------------------------------------------------------
// Keeps `.store/` (and everything inside it) out of the normal vault: the
// file tree, full-text search, the tag index, and the wikilink graph all
// consume `foldersMeta`/`filesMeta` as returned by useVaultSync — so
// stripping it there, once, is the single point that keeps it invisible
// everywhere (3.4). Only strips a folder actually named SPARK_FOLDER_NAME
// sitting directly at the vault root, and whatever's nested under it.
// ---------------------------------------------------------------------------
function splitInternalVaultData(folders, files, rootId) {
  const internalFolder = folders.find((f) => f.name === SPARK_FOLDER_NAME && (f.parents?.[0] || rootId) === rootId);
  if (!internalFolder) return { folders, files, internalFolder: null, internalFiles: [] };

  const internalFolderIds = new Set([internalFolder.id]);
  // One extra pass is enough — this only ever nests one level deep
  // (spark-attachments/), but walk to a fixed point anyway so a manually
  // reorganized Drive folder can't accidentally leak a nested folder in.
  let grew = true;
  while (grew) {
    grew = false;
    folders.forEach((f) => {
      const parentId = f.parents?.[0];
      if (parentId && internalFolderIds.has(parentId) && !internalFolderIds.has(f.id)) {
        internalFolderIds.add(f.id);
        grew = true;
      }
    });
  }

  const publicFolders = folders.filter((f) => !internalFolderIds.has(f.id));
  const internalFiles = files.filter((f) => internalFolderIds.has(f.parents?.[0]));
  const publicFiles = files.filter((f) => !internalFolderIds.has(f.parents?.[0]));

  return { folders: publicFolders, files: publicFiles, internalFolder, internalFiles };
}

export {
  SPARK_FOLDER_NAME,
  SPARK_ATTACHMENTS_FOLDER_NAME,
  SPARK_FILE_NAME,
  makeSparkId,
  parseSparkFile,
  serializeSparkFile,
  buildSparksFromCapture,
  buildSparkCategoryTree,
  allSparkCategoryPaths,
  buildSparksByFileId,
  splitInternalVaultData
};
