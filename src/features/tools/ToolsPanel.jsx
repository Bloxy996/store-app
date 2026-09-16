import { useMemo, useRef, useState } from 'react';

import { IconAudio, IconBraces, IconCheck, IconDownload, IconFolder, IconImage, IconRefresh } from '../../components/icons.jsx';
import { APPLY_FORMAT_PROMPT, applyFileChanges, buildCompiledXml, flattenVaultTree, parseApplyXml } from '../compile/compileVault.js';
import { extractEmbeddedImages } from '../../lib/embeddedImages.js';
import { buildPdfFromImages } from '../../lib/imagesToPdf.js';
import { applyLocalChanges, DEFAULT_TEXT_EXTS, isLocalFsSupported, pickLocalDirectory, readLocalFiles } from '../../lib/localFs.js';
import { downloadMusic } from '../../lib/musicApi.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- 1. Local folder compile/apply (reader.py) ------------------------------
function LocalFolderSection() {
  const [dirHandle, setDirHandle] = useState(null);
  const [dirName, setDirName] = useState('');
  const [extsText, setExtsText] = useState(DEFAULT_TEXT_EXTS.join(' '));
  const [compiled, setCompiled] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [copyStatus, setCopyStatus] = useState('idle');
  const [applyXmlText, setApplyXmlText] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState(null);
  const fileInputRef = useRef(null);

  if (!isLocalFsSupported()) {
    return (
      <div className="compile-panel-section">
        <div className="compile-panel-title">
          <IconFolder size={14} /> Local folder
        </div>
        <p className="muted compile-panel-hint">
          Not supported in this browser — local folder access needs a Chromium-based browser (Chrome, Edge, Brave...).
        </p>
      </div>
    );
  }

  const handlePick = async () => {
    try {
      const handle = await pickLocalDirectory();
      setDirHandle(handle);
      setDirName(handle.name);
      setCompiled(null);
      setApplyResults(null);
    } catch {
      // User cancelled the picker — nothing to do.
    }
  };

  const handleCompile = async () => {
    if (!dirHandle) return;
    setCompiling(true);
    setCopyStatus('idle');
    const exts = extsText.split(/\s+/).filter(Boolean);
    const files = await readLocalFiles(dirHandle, { exts });
    setCompiled({ xml: buildCompiledXml(files), count: files.length });
    setCompiling(false);
  };

  const fullOutput = compiled ? `${compiled.xml}\n\n${APPLY_FORMAT_PROMPT}` : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullOutput);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1500);
    } catch {
      // Clipboard permission denied — download still works.
    }
  };

  const handleFilePick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setApplyXmlText);
    e.target.value = '';
  };

  const handleApply = async () => {
    if (!dirHandle) return;
    setApplying(true);
    const parsed = parseApplyXml(applyXmlText);
    if (parsed.parseError) {
      setApplyResults({ parseError: parsed.parseError });
    } else {
      const results = await applyLocalChanges(dirHandle, parsed, applyFileChanges);
      setApplyResults(results);
    }
    setApplying(false);
  };

  return (
    <div className="compile-panel-section">
      <div className="compile-panel-title">
        <IconFolder size={14} /> Local folder
      </div>
      <p className="muted compile-panel-hint">
        Bundle a folder on this device into the same XML mass-edit format as Compile to XML — for paths outside the vault.
      </p>
      <button className="btn-secondary compile-run-btn" onClick={handlePick}>
        <IconFolder size={13} /> {dirName || 'Pick a folder…'}
      </button>
      {dirHandle && (
        <>
          <label className="spark-field-wrap">
            <span className="compile-chip-label">File extensions to include</span>
            <input className="spark-input" value={extsText} onChange={(e) => setExtsText(e.target.value)} />
          </label>
          <button className="btn-secondary compile-run-btn" onClick={handleCompile} disabled={compiling}>
            {compiling ? <IconRefresh size={13} className="spin" /> : <IconBraces size={13} />}
            {compiling ? 'Compiling…' : 'Compile'}
          </button>
        </>
      )}
      {compiled && (
        <div className="compile-result">
          <div className="compile-result-count">{compiled.count} file{compiled.count === 1 ? '' : 's'} compiled</div>
          <textarea className="compile-output" readOnly value={fullOutput} onFocus={(e) => e.target.select()} />
          <div className="compile-result-actions">
            <button className="btn-secondary" onClick={handleCopy}>
              {copyStatus === 'copied' ? <IconCheck size={13} /> : null} {copyStatus === 'copied' ? 'Copied' : 'Copy to clipboard'}
            </button>
            <button className="btn-secondary" onClick={() => downloadBlob(new Blob([fullOutput]), 'local-compile.xml')}>
              <IconDownload size={13} /> Download .xml
            </button>
          </div>
        </div>
      )}
      {dirHandle && (
        <>
          <div className="compile-panel-title" style={{ marginTop: 8 }}>
            Apply changes
          </div>
          <textarea
            className="compile-apply-input"
            placeholder="Paste XML here…"
            value={applyXmlText}
            onChange={(e) => setApplyXmlText(e.target.value)}
          />
          <div className="compile-result-actions">
            <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
              Upload .xml
            </button>
            <input ref={fileInputRef} type="file" accept=".xml,text/xml" style={{ display: 'none' }} onChange={handleFilePick} />
            <button className="btn-secondary" onClick={handleApply} disabled={!applyXmlText.trim() || applying}>
              {applying ? 'Applying…' : 'Apply to folder'}
            </button>
          </div>
          {applyResults && (
            <div className="compile-apply-results">
              {applyResults.parseError && <div className="compile-apply-row error">{applyResults.parseError}</div>}
              {applyResults.files?.map((f) => (
                <div key={f.path} className={`compile-apply-row ${f.ok ? '' : 'error'}`}>
                  <span className="compile-apply-path">{f.path}</span>
                  <span className="compile-apply-status">{f.message}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- 2. Images -> PDF (imgs2pdf.py) -----------------------------------------
function ImagesToPdfSection() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = async (e) => {
    const files = e.target.files;
    e.target.value = '';
    if (!files?.length) return;
    setBusy(true);
    setStatus('');
    try {
      const blob = await buildPdfFromImages(files);
      downloadBlob(blob, 'images.pdf');
      setStatus(`Downloaded PDF from ${files.length} file(s).`);
    } catch (err) {
      setStatus(err.message || 'Could not build PDF.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="compile-panel-section">
      <div className="compile-panel-title">
        <IconImage size={14} /> Images → PDF
      </div>
      <p className="muted compile-panel-hint">Pick a set of .jpg/.jpeg/.png files and download them as one PDF, one image per page.</p>
      <button className="btn-secondary compile-run-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? <IconRefresh size={13} className="spin" /> : <IconImage size={13} />}
        {busy ? 'Building…' : 'Pick images…'}
      </button>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg" multiple style={{ display: 'none' }} onChange={handleFiles} />
      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

// --- 3. Extract embedded images (md2imgs.py) --------------------------------
function EmbeddedImagesSection({ token, folder, activeNoteName, activeNoteContent, uploadBinary }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const handleExtract = async () => {
    setBusy(true);
    setStatus('');
    try {
      const images = extractEmbeddedImages(activeNoteContent || '');
      if (!images.length) {
        setStatus('No embedded base64 images found in this note.');
        return;
      }
      let uploaded = 0;
      for (const img of images) {
        const file = new File([img.bytes], `${img.id}.${img.ext}`, { type: img.mimeType });
        await uploadBinary(token, folder.id, file);
        uploaded += 1;
      }
      setStatus(`Uploaded ${uploaded} image(s) to "${folder.name}".`);
    } catch (err) {
      setStatus(err.message || 'Extraction failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="compile-panel-section">
      <div className="compile-panel-title">
        <IconImage size={14} /> Extract embedded images
      </div>
      <p className="muted compile-panel-hint">
        Pulls `[image1]: &lt;data:image/png;base64,...&gt;`-style embedded images out of the open note and uploads them as real
        images to the vault root.
      </p>
      {activeNoteName ? (
        <>
          <button className="btn-secondary compile-run-btn" onClick={handleExtract} disabled={busy}>
            {busy ? <IconRefresh size={13} className="spin" /> : <IconImage size={13} />}
            {busy ? 'Working…' : `Extract from "${activeNoteName}"`}
          </button>
          {status && <p className="muted small">{status}</p>}
        </>
      ) : (
        <p className="muted small">Open a note first.</p>
      )}
    </div>
  );
}

// --- 4. Music downloader (music/app.py) -------------------------------------
function MusicSection({ tree, folder }) {
  const [linksText, setLinksText] = useState('');
  const [targetFolderId, setTargetFolderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const folderOptions = useMemo(() => {
    const { folders } = flattenVaultTree(tree);
    return [{ id: folder.id, path: 'vault' }, ...folders];
  }, [tree, folder.id]);

  const handleDownload = async () => {
    const links = linksText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!links.length) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await downloadMusic({ links, folderId: targetFolderId || folder.id });
      setResult(data);
    } catch (err) {
      setResult({ uploaded: [], failed: [{ url: '', error: err.message }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="compile-panel-section">
      <div className="compile-panel-title">
        <IconAudio size={14} /> YouTube → audio
      </div>
      <p className="muted compile-panel-hint">
        One link per line (videos or playlists). Downloads audio, tags it, and saves it into the vault folder below — needs the
        Python service running (server/python/README.md).
      </p>
      <textarea
        className="compile-apply-input"
        placeholder="https://www.youtube.com/watch?v=…"
        value={linksText}
        onChange={(e) => setLinksText(e.target.value)}
      />
      <select className="spark-input" value={targetFolderId} onChange={(e) => setTargetFolderId(e.target.value)}>
        {folderOptions.map((f) => (
          <option key={f.id} value={f.id}>
            {f.path}
          </option>
        ))}
      </select>
      <button className="btn-secondary compile-run-btn" onClick={handleDownload} disabled={busy || !linksText.trim()}>
        {busy ? <IconRefresh size={13} className="spin" /> : <IconAudio size={13} />}
        {busy ? 'Downloading…' : 'Download'}
      </button>
      {result && (
        <div className="compile-apply-results">
          {result.uploaded.map((u) => (
            <div key={u.url} className="compile-apply-row">
              <span className="compile-apply-path">{u.title || u.name}</span>
              <span className="compile-apply-status">Saved</span>
            </div>
          ))}
          {result.failed.map((f, i) => (
            <div key={f.url || i} className="compile-apply-row error">
              <span className="compile-apply-path">{f.url || 'Download'}</span>
              <span className="compile-apply-status">{f.error}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Sidebar panel bundling the local-folder mass-edit flow, images→PDF,
// embedded-image extraction, and the music downloader — the app's
// integrations of temp/processing's standalone .py scripts (CLAUDE.md
// section 3 notes where each one's own logic lives now).
function ToolsPanel({ tree, folder, token, activeNoteName, activeNoteContent, uploadBinary }) {
  return (
    <div className="compile-panel">
      <LocalFolderSection />
      <ImagesToPdfSection />
      <EmbeddedImagesSection
        token={token}
        folder={folder}
        activeNoteName={activeNoteName}
        activeNoteContent={activeNoteContent}
        uploadBinary={uploadBinary}
      />
      <MusicSection tree={tree} folder={folder} />
    </div>
  );
}

export { ToolsPanel };
