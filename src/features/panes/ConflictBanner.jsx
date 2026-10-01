// Shown above an editor when an autosave found the file changed elsewhere in
// a way that couldn't be merged automatically (see lib/conflict.js). The
// local text stays on screen untouched until one of these is chosen.
function ConflictBanner({ conflict, isNote, onResolve }) {
  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner-text">This file was also changed somewhere else, so your edits haven't been saved yet.</span>
      <button className="conflict-btn" onClick={() => onResolve('mine')} title="Overwrite the other version with what you have here">Keep mine</button>
      <button className="conflict-btn" onClick={() => onResolve('theirs')} title="Discard your unsaved edits and load the other version">Use theirs</button>
      {isNote && conflict.merged != null && (
        <button className="conflict-btn" onClick={() => onResolve('both')} title="Keep both — overlapping parts get <<<<<<< / ======= / >>>>>>> markers to sort out">Keep both</button>
      )}
    </div>
  );
}

export { ConflictBanner };
