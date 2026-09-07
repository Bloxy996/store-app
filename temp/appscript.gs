/**
 * store Drive Proxy
 * ------------------
 * Deploy this as a Web App ("Execute as: Me", "Who has access: Anyone").
 * It runs under YOUR (personal) Google identity, so it already has
 * permission to read/write your Drive — visitors never need their own
 * Google OAuth grant, so a Workspace admin's "unconfigured app" block
 * never gets triggered.
 *
 * SETUP (one time, done inside the Apps Script editor — not the browser
 * you're locked out of):
 *   1. Left sidebar → Services (+) → add "Drive API" → pick version 3.
 *      Apps Script will prompt you to enable it in the linked Cloud
 *      project too — click through that.
 *   2. Replace YOUR_SECRET_HERE below with a long random string
 *      (e.g. generate one at https://www.uuidgenerator.net/ or run
 *      `openssl rand -hex 24` locally). Pick the function "setSecret"
 *      in the toolbar dropdown and click Run once. This stores the
 *      secret in Script Properties (not in the file itself).
 *   3. Deploy → New deployment → type "Web app" → Execute as "Me" →
 *      Who has access "Anyone" → Deploy. Authorize when prompted
 *      (this is you, the owner, authorizing — not a visitor).
 *   4. Copy the "Web app URL" (ends in /exec). That + your secret is
 *      what you paste into store's "Use Apps Script proxy" form.
 *   5. Test it by visiting, in any browser:
 *      <WebAppURL>?action=ping&secret=<your secret>
 *      You should see {"ok":true}.
 *
 * Whenever you edit this file, you must push a new version for the
 * change to reach your live URL: Deploy → Manage deployments → Edit
 * (pencil) → Version: New version → Deploy.
 */

function setSecret() {
  PropertiesService.getScriptProperties().setProperty('STORE_SECRET', 'ab3ed64d-99f5-4c3a-9f00-97516f8a1285');
}

// Run this once manually (select it in the function dropdown → Run) the
// first time you deploy, or any time you see a permissions error — it
// forces the authorization dialog to appear so you can approve it. A
// deployed Web App can never show that dialog itself.
function authorize_() {
  DriveApp.getRootFolder();
}

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('STORE_SECRET');
}

function authOk_(secret) {
  const stored = getSecret_();
  return !!stored && !!secret && secret === stored;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (!authOk_(p.secret)) return json_({ error: 'unauthorized' });

    switch (p.action) {
      case 'ping':
        return json_({ ok: true });
      case 'listFolderTree':
        return json_({ folders: listFolderTree_(p.root) });
      case 'listStoreFiles':
        return json_({ files: listStoreFiles_((p.folders || '').split(',').filter(Boolean)) });
      case 'getContent':
        return getContent_(p.id);
      case 'getBlob':
        return json_(getBlobBase64_(p.id));
      case 'browse':
        return json_({ folders: browseFolders_(p.parent || 'root') });
      case 'resolveFolder':
        return json_(resolveFolder_(p.id));
      default:
        return json_({ error: 'unknown action' });
    }
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (!authOk_(body.secret)) return json_({ error: 'unauthorized' });

    switch (body.action) {
      case 'createFile':
        return json_(createFile_(body.folderId, body.name, body.content || ''));
      case 'createFolder':
        return json_(createFolder_(body.parentId, body.name));
      case 'updateContent':
        return json_(updateContent_(body.id, body.content || ''));
      case 'rename':
        return json_(renameItem_(body.id, body.newName));
      case 'trash':
        return json_(trashItem_(body.id));
      default:
        return json_({ error: 'unknown action' });
    }
  } catch (err) {
    return json_({ error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Drive operations (Advanced Drive Service — mirrors the Drive v3 REST API
// calls store already makes, so behavior matches what it expects)
// ---------------------------------------------------------------------------

// Every list/get/create/update call below sets these three so Shared Drive
// content (e.g. a drive called "Laptops") is visible, not just My Drive.
// corpora: 'allDrives' is what makes an explicit parent-folder query reach
// into Shared Drives at all; supportsAllDrives + includeItemsFromAllDrives
// are required alongside it by the API.
const ALL_DRIVES_PARAMS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  corpora: 'allDrives'
};

function listFolderTree_(rootId) {
  const out = [];
  let frontier = [rootId];
  while (frontier.length) {
    const next = [];
    frontier.forEach((parentId) => {
      const q = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      let pageToken = null;
      do {
        const res = Drive.Files.list(
          Object.assign({ q, fields: 'files(id,name,parents),nextPageToken', pageSize: 1000, pageToken }, ALL_DRIVES_PARAMS)
        );
        (res.files || []).forEach((f) => {
          out.push(f);
          next.push(f.id);
        });
        pageToken = res.nextPageToken || null;
      } while (pageToken);
    });
    frontier = next;
  }
  return out;
}

function listStoreFiles_(folderIds) {
  const mimeClauses = [
    "mimeType = 'text/markdown'",
    "mimeType = 'text/plain'",
    "fileExtension = 'md'",
    "mimeType = 'image/png'",
    "mimeType = 'image/jpeg'",
    "mimeType = 'image/gif'",
    "mimeType = 'image/webp'",
    "mimeType = 'image/svg+xml'",
    "mimeType = 'image/bmp'"
  ].join(' or ');

  const out = [];
  folderIds.forEach((id) => {
    const q = `'${id}' in parents and trashed = false and (${mimeClauses})`;
    let pageToken = null;
    do {
      const res = Drive.Files.list(
        Object.assign(
          {
            q,
            fields: 'files(id,name,modifiedTime,parents,mimeType),nextPageToken',
            pageSize: 1000,
            orderBy: 'name',
            pageToken
          },
          ALL_DRIVES_PARAMS
        )
      );
      (res.files || []).forEach((f) => {
        out.push(Object.assign({}, f, { kind: IMAGE_RE.test(f.name) ? 'image' : 'note' }));
      });
      pageToken = res.nextPageToken || null;
    } while (pageToken);
  });
  return out;
}

// Drive.Files.get(id, {alt:'media'}) via the Advanced Service is flaky for
// non-JSON content (i.e. every note) — it can throw an HttpResponseException
// even on a genuine 200, with the real file content embedded in the
// exception's message. DriveApp — Apps Script's built-in, non-"Advanced"
// Drive service — doesn't have that bug and needs no extra OAuth scope
// beyond the Drive access this project already has.
function getContent_(id) {
  const blob = DriveApp.getFileById(id).getBlob();
  return ContentService.createTextOutput(blob.getDataAsString('UTF-8')).setMimeType(ContentService.MimeType.TEXT);
}

function getBlobBase64_(id) {
  const blob = DriveApp.getFileById(id).getBlob();
  return { base64: Utilities.base64Encode(blob.getBytes()), mimeType: blob.getContentType() };
}

function createFile_(folderId, rawName, content) {
  const name = /\.md$/i.test(rawName) ? rawName : `${rawName}.md`;
  const resource = { name: name, parents: [folderId], mimeType: 'text/markdown' };
  const blob = Utilities.newBlob(content, 'text/markdown', name);
  return Drive.Files.create(resource, blob, { fields: 'id,name,modifiedTime,parents', supportsAllDrives: true });
}

function createFolder_(parentId, name) {
  const resource = { name: name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' };
  return Drive.Files.create(resource, null, { fields: 'id,name,parents', supportsAllDrives: true });
}

function updateContent_(id, content) {
  const blob = Utilities.newBlob(content, 'text/markdown');
  return Drive.Files.update({}, id, blob, { fields: 'id,modifiedTime', supportsAllDrives: true });
}

function renameItem_(id, newName) {
  return Drive.Files.update({ name: newName }, id, null, { fields: 'id,name', supportsAllDrives: true });
}

function trashItem_(id) {
  return Drive.Files.update({ trashed: true }, id, null, { fields: 'id,trashed', supportsAllDrives: true });
}

// Lists what to show one level below `parentId` for store's proxy-mode
// folder browser (replaces the Google Picker, which needs an OAuth token
// a proxied visitor doesn't have). At the top level ('root') this returns
// both your My Drive subfolders AND your Shared Drives (e.g. "Laptops") as
// siblings — a Shared Drive isn't a child of My Drive, so it has to be
// listed separately via Drive.Drives.list(). Below the top level, a Shared
// Drive's own ID doubles as its root folder ID, so the same folder query
// works whether you're inside My Drive or inside a Shared Drive.
//
// Folder *shortcuts* are resolved transparently: if you create a shortcut
// (right-click a folder → Organize → Add shortcut) to somewhere the API
// can't otherwise reach — most notably a folder under "Computers", Drive's
// desktop-backup section, which has no browsing API at all — it'll now
// just appear here like a normal folder, using the real target folder's ID.
function browseFolders_(parentId) {
  const items = [];
  const fields = 'files(id,name,mimeType,shortcutDetails)';
  const folderOrShortcut =
    "(mimeType = 'application/vnd.google-apps.folder' or mimeType = 'application/vnd.google-apps.shortcut')";

  function pushFolderLike(f) {
    if (f.mimeType === 'application/vnd.google-apps.shortcut') {
      if (f.shortcutDetails && f.shortcutDetails.targetMimeType === 'application/vnd.google-apps.folder') {
        items.push({ id: f.shortcutDetails.targetId, name: f.name, isDrive: false });
      }
      return; // shortcut to a non-folder — nothing to browse into
    }
    items.push({ id: f.id, name: f.name, isDrive: false });
  }

  if (parentId === 'root') {
    const q = `'root' in parents and ${folderOrShortcut} and trashed = false`;
    const res = Drive.Files.list(Object.assign({ q, fields, pageSize: 1000, orderBy: 'name' }, ALL_DRIVES_PARAMS));
    (res.files || []).forEach(pushFolderLike);

    let pageToken = null;
    do {
      const dres = Drive.Drives.list({ pageSize: 100, pageToken });
      (dres.drives || []).forEach((d) => items.push({ id: d.id, name: d.name, isDrive: true }));
      pageToken = dres.nextPageToken || null;
    } while (pageToken);
  } else {
    const q = `'${parentId}' in parents and ${folderOrShortcut} and trashed = false`;
    const res = Drive.Files.list(Object.assign({ q, fields, pageSize: 1000, orderBy: 'name' }, ALL_DRIVES_PARAMS));
    (res.files || []).forEach(pushFolderLike);
  }

  return items;
}

// Resolves a raw folder ID (or the front end already having stripped it out
// of a pasted Drive URL) to {id, name} — used for folders the browse action
// can never reach on its own, chiefly anything under "Computers". There is
// no Drive API to enumerate that section, but a folder inside it is a
// perfectly normal, readable/writable Drive file once you already know its
// ID — you just have to supply that ID rather than navigate to it.
function resolveFolder_(id) {
  const meta = Drive.Files.get(id, { fields: 'id,name,mimeType', supportsAllDrives: true });
  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That ID/link is not a folder');
  }
  return { id: meta.id, name: meta.name };
}