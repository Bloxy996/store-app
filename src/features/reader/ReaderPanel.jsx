import { useState } from 'react';

import { IconAlertTriangle, IconCheck, IconDownload, IconFolderPlus, IconImage, IconLoader, IconUpload } from '../../components/icons.jsx';
import { buildPdfFromImages } from '../../lib/imagePdf.js';
import { aggregateFiles, copyMatchingFiles, isFileSystemAccessSupported, normalizeExts, parseAggregatedText, writeRestoredFiles } from '../../lib/localFiles.js';
import { extractImagesFromMarkdown, imageResultsToFiles } from '../../lib/mdImageExtract.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function FilterFields({ exts, setExts, inc, setInc, exc, setExc }) {
  return (
    <div className="reader-filter-row">
      <input className="reader-input" placeholder="Extensions (.py, .md)" value={exts} onChange={(e) => setExts(e.target.value)} />
      <input className="reader-input" placeholder="Include paths" value={inc} onChange={(e) => setInc(e.target.value)} />
      <input className="reader-input" placeholder="Exclude paths" value={exc} onChange={(e) => setExc(e.target.value)} />
    </div>
  );
}

function splitList(text) {
  return (text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function FolderTools() {
  const [exts, setExts] = useState('');
  const [inc, setInc] = useState('');
  const [exc, setExc] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState('');
  const [restoreText, setRestoreText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [restoreLog, setRestoreLog] = useState(null);

  const filters = () => ({ exts: normalizeExts(splitList(exts)), inc: splitList(inc), exc: splitList(exc) });

  const handleAggregate = async () => {
    setBusy(true);
    setStatus('');
    try {
      const dirHandle = await window.showDirectoryPicker();
      const { exts: e, inc: i, exc: x } = filters();
      const { text, count } = await aggregateFiles(dirHandle, e, i, x);
      setOutput(text);
      setStatus(`Aggregated ${count} file${count === 1 ? '' : 's'} from “${dirHandle.name}”.`);
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToFolder = async () => {
    setBusy(true);
    setStatus('');
    try {
      const sourceHandle = await window.showDirectoryPicker();
      const destHandle = await window.showDirectoryPicker({ id: 'reader-dest', mode: 'readwrite' });
      const { exts: e, inc: i, exc: x } = filters();
      const results = await copyMatchingFiles(sourceHandle, destHandle, e, i, x);
      const errors = results.filter((r) => r.status === 'error').length;
      setStatus(`Copied ${results.length - errors} file${results.length - errors === 1 ? '' : 's'} into “${destHandle.name}”${errors ? ` (${errors} failed)` : ''}.`);
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    setBusy(true);
    setRestoreLog(null);
    try {
      const files = parseAggregatedText(restoreText);
      if (!files.length) {
        setRestoreLog([{ relPath: '(none)', status: 'no-sections-found' }]);
        return;
      }
      const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const results = await writeRestoredFiles(rootHandle, files, overwrite);
      setRestoreLog(results);
    } catch (err) {
      if (err?.name !== 'AbortError') setRestoreLog([{ relPath: '(error)', status: 'error', message: err.message || String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-section">
      <div className="reader-section-title">Aggregate a folder</div>
      <p className="muted small reader-hint">Pick a folder on this device and combine its matching files into one text block, the same filtering rules as before, now with fields instead of CLI flags.</p>
      <FilterFields exts={exts} setExts={setExts} inc={inc} setInc={setInc} exc={exc} setExc={setExc} />
      <div className="reader-actions-row">
        <button className="btn-secondary" onClick={handleAggregate} disabled={busy}>
          {busy ? <IconLoader size={13} /> : <IconFolderPlus size={13} />} Choose folder & aggregate
        </button>
        <button className="btn-secondary" onClick={handleCopyToFolder} disabled={busy}>
          Copy matching files to another folder
        </button>
      </div>
      {status && <div className="reader-status">{status}</div>}
      {output && (
        <>
          <textarea className="reader-output" readOnly value={output} onFocus={(e) => e.target.select()} />
          <button className="btn-secondary" onClick={() => downloadBlob(new Blob([output], { type: 'text/plain' }), 'aggregated.txt')}>
            <IconDownload size={13} /> Download as .txt
          </button>
        </>
      )}

      <div className="reader-section-title reader-section-title-spaced">Restore an aggregated block</div>
      <p className="muted small reader-hint">Paste a previously aggregated block back in — it splits on the same file markers and writes each file back to a folder you choose.</p>
      <textarea className="reader-textarea" rows={4} placeholder="Paste aggregated text here…" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
      <label className="reader-checkbox-row">
        <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite existing files
      </label>
      <button className="btn-secondary" onClick={handleRestore} disabled={busy || !restoreText.trim()}>
        {busy ? <IconLoader size={13} /> : <IconUpload size={13} />} Choose folder & restore
      </button>
      {restoreLog && (
        <div className="reader-output reader-log">
          {restoreLog.map((r, i) => (
            <div key={i} className="reader-log-line">
              {r.status === 'restored' || r.status === 'copied' ? <IconCheck size={12} /> : <IconAlertTriangle size={12} />} {r.relPath} — {r.status}
              {r.message ? `: ${r.message}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImagesToPdf() {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const handleBuild = async () => {
    if (!files.length) return;
    setBusy(true);
    setStatus('');
    try {
      const blob = await buildPdfFromImages(files);
      downloadBlob(blob, 'images.pdf');
      setStatus(`Built a ${files.length}-page PDF.`);
    } catch (err) {
      setStatus(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-section">
      <div className="reader-section-title">Images → PDF</div>
      <input type="file" accept="image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} />
      <button className="btn-secondary" onClick={handleBuild} disabled={busy || !files.length}>
        {busy ? <IconLoader size={13} /> : <IconImage size={13} />} Build PDF ({files.length} image{files.length === 1 ? '' : 's'})
      </button>
      {status && <div className="reader-status">{status}</div>}
    </div>
  );
}

function MarkdownToImages() {
  const [text, setText] = useState('');
  const [results, setResults] = useState(null);

  const handleExtract = () => setResults(extractImagesFromMarkdown(text));
  const files = results ? imageResultsToFiles(results) : [];

  return (
    <div className="reader-section">
      <div className="reader-section-title">Extract images from markdown</div>
      <textarea className="reader-textarea" rows={4} placeholder="Paste markdown with [imageN]: <data:image/png;base64,...> definitions…" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn-secondary" onClick={handleExtract} disabled={!text.trim()}>
        Extract images
      </button>
      {results && (
        <div className="reader-output reader-log">
          {results.length === 0 && <div className="muted small">No embedded images found.</div>}
          {results.map((r, i) => (
            <div key={i} className="reader-log-line">
              {r.error ? <IconAlertTriangle size={12} /> : <IconCheck size={12} />} {r.id}
              {r.error ? `: ${r.error}` : ''}
            </div>
          ))}
        </div>
      )}
      {files.map((f) => (
        <button key={f.name} className="btn-secondary" onClick={() => downloadBlob(f.blob, f.name)}>
          <IconDownload size={13} /> {f.name}
        </button>
      ))}
    </div>
  );
}

function ReaderPanel() {
  if (!isFileSystemAccessSupported()) {
    return (
      <div className="reader-panel">
        <div className="reader-section-title">Local files</div>
        <p className="muted small reader-hint">
          Folder aggregate/restore needs the File System Access API, which this browser doesn't support. The image tools below don't need it and still work.
        </p>
        <ImagesToPdf />
        <MarkdownToImages />
      </div>
    );
  }

  return (
    <div className="reader-panel">
      <FolderTools />
      <ImagesToPdf />
      <MarkdownToImages />
    </div>
  );
}

export { ReaderPanel };
