


/* ============================================================================
 * VAULT — a markdown notebook that reads/writes .md files directly to and
 * from Google Drive. Architectural rule enforced throughout this file:
 *
 *   Note CONTENT is NEVER written to disk on this device. It lives only in
 *   React state / in-memory caches for as long as the browser tab is open,
 *   and is streamed to/from Drive over the REST API. IndexedDB is used
 *   exclusively as a *transient* cache for: (a) file metadata/modifiedTime,
 *   and (b) the derived wikilink graph — never for raw note bodies.
 *   Clearing IndexedDB never loses data, because Drive remains the single
 *   source of truth.
 *
 *   Images follow the same rule: only their metadata (id/name/modifiedTime)
 *   is cached in IndexedDB. Image bytes are fetched on demand (when actually
 *   viewed or embedded) and kept only as in-memory blob URLs for the current
 *   session — never persisted.
 *
 *   The in-memory full-text search / tag index (see useVaultIndex) is the
 *   same idea taken one step further: note bodies are held in a RAM-only
 *   Map (module scope, never IndexedDB) so full-text search works without
 *   ever touching disk. It's rebuilt from Drive every time the page loads.
 * ==========================================================================*/

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY; // optional, used by Picker

const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID; // optional, used by Picker

// NOTE on scope: drive.file only grants access to files the app itself
// creates (or individual files the user explicitly picks one-by-one).
// Selecting a *folder* via the Picker does NOT retroactively grant access
// to that folder's pre-existing contents — only to the folder resource
// itself and to anything the app subsequently creates inside it. Since this
// app needs to read and edit an existing vault of arbitrary pre-existing
// notes, that per-file model doesn't fit, so it requests the broader
// `drive` scope instead (full read/write across the user's Drive). This is
// a "restricted" scope: Google requires it to be added under OAuth consent
// screen -> Data Access -> Scopes, and — like drive.file — it only needs
// full app verification once you leave Testing mode / add non-test users.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';


const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';


const DB_NAME = 'vault-cache-db';

const DB_VERSION = 2;

const STORE_FILES = 'files'; // { id, name, modifiedTime, parents, mimeType, kind }  -- metadata only

const STORE_FOLDERS = 'folders'; // { id, name, parents } -- structure only, no content

const STORE_LINKS = 'links'; // { fileId, links: [{target, alias}], cachedAt } -- graph only

const STORE_META = 'meta'; // { key, value } -- app settings (vault folder id, bookmarks, etc.)


// How many Drive content requests run in parallel during a sync. Large
// vaults previously fetched every file's body one request at a time (a full
// network round-trip per file, strictly serialized) — that was the single
// biggest cause of "loading a big vault takes forever". Running several
// requests concurrently cuts wall-clock sync time roughly by this factor,
// while staying comfortably under Drive's per-user rate limits.
const FETCH_CONCURRENCY = 8;


// Image files participate in the vault (sidebar, viewing, [[links]]) the
// same way notes do, but their bytes are only ever fetched on demand
// (viewing or embedding) — never during a sync — so a vault full of
// screenshots never adds to sync time.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp'
];


// Video/audio get their own kinds (dedicated <video>/<audio> embeds), and
// everything else with a real extension falls back to a generic 'file' kind
// (download/open chip). Anything left over — no extension, or a known text
// extension — is treated as a note, same as before this was generalized.
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);

const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac']);

const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/aac', 'audio/x-m4a'];

const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt', '']);

// Databases (Notion-style tables) are stored as JSON, one object per file,
// under their own extension so classifyKind can tell them apart from a
// plain note at a glance. Content still round-trips through the exact same
// "text file on Drive, debounced-save" pipeline notes use — only the shape
// of the JSON and the pane that renders it differ.
const DATABASE_EXTENSIONS = new Set(['base']);

// Canvas boards (Obsidian-style infinite canvas) are stored the same way
// databases are — JSON, one object per file — under their own extension so
// classifyKind can tell them apart. See the Canvas section below (search
// "CANVAS BOARD") for the node/edge schema and the CanvasView renderer.
const CANVAS_EXTENSIONS = new Set(['canvas']);


function fileExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}


function isImageName(name) {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}


function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(fileExtension(name));
}


function isAudioName(name) {
  return AUDIO_EXTENSIONS.has(fileExtension(name));
}


// True for any filename whose extension marks it as a non-note asset (i.e.
// it should keep its extension for [[link]] matching/display, the way image
// links always have). Notes (.md/.markdown/.txt/no extension) are the only
// names this returns false for.
function isAssetName(name) {
  return !NOTE_EXTENSIONS.has(fileExtension(name));
}


// Single source of truth for what a synced Drive file "is". Order matters:
// image/video/audio are checked first by extension+mimeType, then anything
// with a note-like extension (or no extension) is a note, and everything
// else is a generic file (pdf, zip, docx, whatever the user drops in).
function classifyKind(name, mimeType) {
  if (isImageName(name) || IMAGE_MIME_TYPES.includes(mimeType)) return 'image';
  if (isVideoName(name) || VIDEO_MIME_TYPES.includes(mimeType)) return 'video';
  if (isAudioName(name) || AUDIO_MIME_TYPES.includes(mimeType)) return 'audio';
  if (DATABASE_EXTENSIONS.has(fileExtension(name))) return 'database';
  if (CANVAS_EXTENSIONS.has(fileExtension(name))) return 'canvas';
  if (NOTE_EXTENSIONS.has(fileExtension(name)) || mimeType === 'text/markdown' || mimeType === 'text/plain') return 'note';
  return 'file';
}


// Kinds that open in the normal tabbed editor pane (vs. the standalone
// image/asset viewer). Notes, databases, and canvases are all "pages" —
// they get a tab, a title field, and live in the pane tree like any note.
function opensInEditorPane(kind) {
  return kind === 'note' || kind === 'database' || kind === 'canvas';
}

// File extension to use when a "page" kind is created or renamed without
// one — mirrors how notes always end up ".md".
function extensionForKind(kind) {
  if (kind === 'database') return 'base';
  if (kind === 'canvas') return 'canvas';
  return 'md';
}

export { CLIENT_ID, API_KEY, APP_ID, DRIVE_SCOPE, DRIVE_FILES_URL, DRIVE_UPLOAD_URL, DB_NAME, DB_VERSION, STORE_FILES, STORE_FOLDERS, STORE_LINKS, STORE_META, FETCH_CONCURRENCY, IMAGE_EXTENSIONS, IMAGE_MIME_TYPES, VIDEO_EXTENSIONS, VIDEO_MIME_TYPES, AUDIO_EXTENSIONS, AUDIO_MIME_TYPES, NOTE_EXTENSIONS, DATABASE_EXTENSIONS, CANVAS_EXTENSIONS, fileExtension, isImageName, isVideoName, isAudioName, isAssetName, classifyKind, opensInEditorPane, extensionForKind };
