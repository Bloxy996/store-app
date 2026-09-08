import './OfflineConflictsPanel.css';
function OfflineConflictsPanel({ conflicts, onResolve }) {
  if (!conflicts.length) return null;
  return <aside className="offline-conflicts-panel" aria-label="Offline conflicts"><header><h3>Offline conflicts</h3><span>{conflicts.length}</span></header>{conflicts.map((c) => <section key={c.fileId} className="offline-conflict"><strong>{c.name}</strong><p>Drive file was {c.type === 'changed' ? 'changed' : 'deleted'} while you were offline.</p><div className="offline-conflict-actions">{c.type === 'changed' ? <><button onClick={() => onResolve(c.fileId, 'keep-mine')}>Keep mine</button><button onClick={() => onResolve(c.fileId, 'keep-drive')}>Keep Drive</button><button onClick={() => onResolve(c.fileId, 'keep-both')}>Keep both</button></> : <><button onClick={() => onResolve(c.fileId, 'restore')}>Restore</button><button onClick={() => onResolve(c.fileId, 'discard')}>Discard</button></>}</div></section>)}</aside>;
}
export { OfflineConflictsPanel };
