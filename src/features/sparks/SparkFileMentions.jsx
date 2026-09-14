import { IconZap } from '../../components/icons.jsx';

// `sparksByFileId` (Map fileId -> Spark[]) and `onOpenSparksForFile` both
// ride along on the shared `handlers` object already threaded into
// EditorContent (same as `handlers.allTags`) — no new prop plumbing needed
// through PaneNode/LeafPane.
function SparkFileMentions({ fileId, sparksByFileId, onOpenSparksForFile }) {
  const sparks = sparksByFileId?.get(fileId);
  if (!sparks || sparks.length === 0) return null;
  return (
    <button className="spark-file-mentions" onClick={() => onOpenSparksForFile(fileId)}>
      <IconZap size={13} />
      {sparks.length === 1 ? '1 spark links here' : `${sparks.length} sparks link here`}
    </button>
  );
}

export { SparkFileMentions };
