import { driveGetFileContent, driveGetFileMetadata, isProxy } from './driveApi.js';
import { merge3 } from './merge3.js';

// Run just before an autosave writes to Drive: has someone else changed the
// file since this buffer last loaded/saved it? (Last-write-wins otherwise
// silently throws their edit away.)
//   { status: 'clean' }                 — safe to write `value` as-is
//   { status: 'merged', value }         — non-overlapping edits, write `value` (the merge)
//   { status: 'conflict', conflict }    — overlapping edits; don't write, ask the person
// `buf` carries modifiedTime + baseContent (what Drive had when we last
// synced this buffer). Notes get an automatic three-way merge; other kinds
// (JSON/.vec/etc.) can't be line-merged safely, so they go straight to a choice.
async function checkSaveConflict({ token, fileId, buf, value, isNote }) {
  let remoteModified;
  if (!isProxy(token)) {
    // Fast path: one tiny metadata call; unchanged timestamp = no conflict.
    remoteModified = (await driveGetFileMetadata(token, fileId)).modifiedTime;
    if (remoteModified && remoteModified === buf.modifiedTime) return { status: 'clean' };
  }
  const remote = await driveGetFileContent(token, fileId);
  if (remote === buf.baseContent || remote === value) return { status: 'clean' };
  let merged = null;
  if (isNote && buf.baseContent !== undefined) {
    const r = merge3(buf.baseContent, value, remote);
    if (r && !r.conflict) return { status: 'merged', value: r.merged };
    merged = r ? r.merged : null;
  }
  return { status: 'conflict', conflict: { remoteContent: remote, remoteModifiedTime: remoteModified, merged } };
}

export { checkSaveConflict };
