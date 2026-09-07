import { useMemo, useRef, useState } from 'react';

import { IconBraces, IconCheck, IconDownload, IconFile, IconFolder, IconRefresh, IconX } from '../../components/icons.jsx';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { APPLY_FORMAT_PROMPT, buildCompiledXml, flattenVaultTree, resolveIncludedFiles } from './compileVault.js';


// A chip-list text input with a path autocomplete dropdown — shared by the
// Includes and Excludes lists below. `options` is every folder/file path in
// the vault (from flattenVaultTree); picking one (click or Enter) adds it
// as a chip and clears the input. Not a popup: the suggestion list is a
// plain sibling block below the input, in normal flow, closed by
// useClickOutside like every other inline panel in this app.
function PathChipInput({ label, placeholder, values, onChange, options }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useClickOutside([wrapRef], () => setOpen(false));

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return options.filter((o) => o.path.toLowerCase().includes(q) && !values.includes(o.path)).slice(0, 30);
  }, [text, options, values]);

  const add = (path) => {
    if (path && !values.includes(path)) onChange([...values, path]);
    setText('');
    setOpen(false);
  };

  return (
    <div className="compile-chip-field" ref={wrapRef}>
      <span className="compile-chip-label">{label}</span>
      <div className="compile-chip-list">
        {values.map((v) => (
          <span key={v} className="compile-chip">
            {v}
            <button className="compile-chip-remove" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`}>
              <IconX size={11} />
            </button>
          </span>
        ))}
        <input
          className="compile-chip-input"
          placeholder={values.length ? '' : placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) add(matches[0].path);
            else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
        />
      </div>
      {open && matches.length > 0 && (
        <div className="compile-suggest-list">
          {matches.map((m) => (
            <button key={m.path} className="compile-suggest-item" onClick={() => add(m.path)}>
              {m.kind === 'folder' ? <IconFolder size={13} /> : <IconFile size={13} />}
              <span>{m.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Sidebar panel — select a slice of the vault's .md notes via include/
// exclude folder or note paths, compile them into one XML document for an
// LLM conversation, and apply an LLM's XML reply (search/replace per file)
// back to the store. See CLAUDE.md's changelog entry for the exact format
// and the safety rule around dirty open buffers.
function CompilePanel({ tree, getBody, ensureIndexed, indexReady, onApplyChanges }) {
  const [includes, setIncludes] = useState([]);
  const [excludes, setExcludes] = useState([]);
  const [compiled, setCompiled] = useState(null); // { xml, count }
  const [compiling, setCompiling] = useState(false);
  const [copyStatus, setCopyStatus] = useState('idle'); // idle | copied
  const [applyXmlText, setApplyXmlText] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState(null);
  const fileInputRef = useRef(null);

  const pathOptions = useMemo(() => {
    const { folderPaths, files } = flattenVaultTree(tree);
    return [...folderPaths.map((path) => ({ path, kind: 'folder' })), ...files.map((f) => ({ path: f.path, kind: 'file' }))].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  }, [tree]);

  const handleCompile = async () => {
    setCompiling(true);
    setCopyStatus('idle');
    if (!indexReady) await ensureIndexed();
    const files = resolveIncludedFiles(tree, includes, excludes).map((f) => ({ path: f.path, content: getBody(f.id) }));
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
      // Clipboard permission denied or unavailable — download still works.
    }
  };

  const handleDownload = () => {
    const blob = new Blob([fullOutput], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vault-compile.xml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFilePick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setApplyXmlText);
    e.target.value = '';
  };

  const handleApply = async () => {
    setApplying(true);
    const results = await onApplyChanges(applyXmlText);
    setApplyResults(results);
    setApplying(false);
  };

  return (
    <div className="compile-panel">
      <div className="compile-panel-section">
        <div className="compile-panel-title">
          <IconBraces size={14} /> Compile to XML
        </div>
        <p className="muted compile-panel-hint">
          Bundle a slice of your notes into one XML document to paste into an LLM conversation for mass editing. Leave Includes empty to
          use the whole vault.
        </p>
        <PathChipInput label="Includes" placeholder="Add a folder or note…" values={includes} onChange={setIncludes} options={pathOptions} />
        <PathChipInput label="Excludes" placeholder="Add a folder or note…" values={excludes} onChange={setExcludes} options={pathOptions} />
        <button className="btn-secondary compile-run-btn" onClick={handleCompile} disabled={compiling}>
          {compiling ? <IconRefresh size={13} className="spin" /> : <IconBraces size={13} />}
          {compiling ? 'Compiling…' : 'Compile'}
        </button>
        {compiled && (
          <div className="compile-result">
            <div className="compile-result-count">{compiled.count} file{compiled.count === 1 ? '' : 's'} compiled</div>
            <textarea className="compile-output" readOnly value={fullOutput} onFocus={(e) => e.target.select()} />
            <div className="compile-result-actions">
              <button className="btn-secondary" onClick={handleCopy}>
                {copyStatus === 'copied' ? <IconCheck size={13} /> : null} {copyStatus === 'copied' ? 'Copied' : 'Copy to clipboard'}
              </button>
              <button className="btn-secondary" onClick={handleDownload}>
                <IconDownload size={13} /> Download .xml
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="compile-panel-section">
        <div className="compile-panel-title">Apply changes</div>
        <p className="muted compile-panel-hint">Paste or upload an LLM's &lt;update&gt;/&lt;change&gt; XML reply to apply it to the store.</p>
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
            {applying ? 'Applying…' : 'Apply'}
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
      </div>
    </div>
  );
}

export { CompilePanel };
