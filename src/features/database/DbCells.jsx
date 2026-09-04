import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { IconCheck, IconEdit, IconImageMissing, IconLoader, IconPaperclip, IconPlus, IconUpload, IconX } from '../../components/icons.jsx';
import { DB_COLUMN_TYPES } from './dbState.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useDriveImageUrl } from '../../hooks/useDriveImageUrl.js';


// A dropdown-style popover, like DropdownMenu, but the panel does NOT close
// itself on every inner click — DropdownMenu's wrapper closes on any click
// bubble, which is right for a plain menu of buttons but wrong here, where
// panels contain text inputs (typing/clicking to focus would immediately
// dismiss them). Children get an explicit `close()` to call when a pick is
// actually made.
function DbPopover({ trigger, children, align = 'left', width }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  useClickOutside([anchorRef, menuRef], () => setOpen(false));

  const computePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onReflow = () => computePos();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, computePos]);

  const toggle = useCallback((e) => {
    e?.stopPropagation();
    setOpen((v) => !v);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span className="db-popover-wrap" ref={anchorRef}>
      {trigger(toggle, open)}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="db-popover portal"
            style={{
              top: pos.top,
              ...(align === 'right' ? { right: pos.right } : { left: pos.left }),
              ...(width ? { width } : {})
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {children(close)}
          </div>,
          document.body
        )}
    </span>
  );
}


// --- Per-type cell value editors --------------------------------------------

function DbTextCell({ value, onChange, multiline, dense }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onChange(draft || null);
  };
  if (editing) {
    return multiline ? (
      <textarea
        ref={ref}
        className="db-cell-input db-cell-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(value || '');
            setEditing(false);
          }
        }}
        rows={dense ? 2 : 6}
      />
    ) : (
      <input
        ref={ref}
        className="db-cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(value || '');
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div
      className={`db-cell-text ${!value ? 'empty' : ''} ${multiline ? 'multiline' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value || ''}
    </div>
  );
}


function DbNumberCell({ value, onChange, integer }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value === null || value === undefined ? '' : String(value));
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (value !== null) onChange(null);
      return;
    }
    const num = integer ? parseInt(trimmed, 10) : parseFloat(trimmed);
    if (Number.isNaN(num)) {
      setDraft(value === null || value === undefined ? '' : String(value));
      return;
    }
    if (num !== value) onChange(num);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        type="number"
        step={integer ? '1' : 'any'}
        className="db-cell-input db-cell-number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className={`db-cell-text db-cell-number-display ${value === null || value === undefined ? 'empty' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value === null || value === undefined ? '' : value}
    </div>
  );
}


function DbCheckboxCell({ value, onChange }) {
  return (
    <button
      className={`db-checkbox ${value ? 'checked' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
    >
      {value && <IconCheck size={12} />}
    </button>
  );
}


function DbUrlCell({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onChange(draft || null);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className="db-cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder="https://"
      />
    );
  }
  return (
    <div className="db-cell-url">
      {value ? (
        <>
          <a href={value} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="db-url-link">
            {value}
          </a>
          <button
            className="db-cell-edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <IconEdit size={11} />
          </button>
        </>
      ) : (
        <div
          className="db-cell-text empty"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        />
      )}
    </div>
  );
}


function DbDateCell({ value, onChange }) {
  return (
    <input
      type="date"
      className="db-cell-date"
      value={value || ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}


function DbSelectCell({ value, onChange, column }) {
  const options = column.options || [];
  const current = options.find((o) => o.id === value) || null;
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-select-trigger" onClick={toggle}>
          {current ? (
            <span className="db-option-chip" style={{ '--chip-color': current.color }}>
              {current.label}
            </span>
          ) : (
            <span className="db-cell-text empty" />
          )}
        </button>
      )}
      width={200}
    >
      {(close) => (
        <div className="db-select-popover">
          {current && (
            <button
              className="db-popover-item db-clear-item"
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              Clear
            </button>
          )}
          {options.map((o) => (
            <button
              key={o.id}
              className="db-popover-item"
              onClick={() => {
                onChange(o.id);
                close();
              }}
            >
              <span className="db-option-chip" style={{ '--chip-color': o.color }}>
                {o.label}
              </span>
              {o.id === value && <IconCheck size={12} />}
            </button>
          ))}
          {options.length === 0 && <div className="muted small db-popover-empty">No options yet — add some from Properties.</div>}
        </div>
      )}
    </DbPopover>
  );
}


function DbMultiSelectCell({ value, onChange, column, onCreateOption }) {
  const [filter, setFilter] = useState('');
  const options = column.options || [];
  const selected = new Set(value);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  const exactExists = options.some((o) => o.label.toLowerCase() === filter.trim().toLowerCase());
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-multiselect-trigger" onClick={toggle}>
          {value.length === 0 && <span className="db-cell-text empty" />}
          {options
            .filter((o) => selected.has(o.id))
            .map((o) => (
              <span key={o.id} className="db-option-chip" style={{ '--chip-color': o.color }}>
                {o.label}
              </span>
            ))}
        </button>
      )}
      width={220}
    >
      {() => (
        <div className="db-select-popover">
          <input
            className="db-popover-filter"
            placeholder="Search or create tag…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filter.trim() && !exactExists) {
                e.preventDefault();
                onCreateOption(filter.trim());
                setFilter('');
              }
            }}
          />
          <div className="db-popover-list">
            {filtered.map((o) => {
              const isSel = selected.has(o.id);
              return (
                <button
                  key={o.id}
                  className="db-popover-item"
                  onClick={() => onChange(isSel ? value.filter((id) => id !== o.id) : [...value, o.id])}
                >
                  <span className="db-option-chip" style={{ '--chip-color': o.color }}>
                    {o.label}
                  </span>
                  {isSel && <IconCheck size={12} />}
                </button>
              );
            })}
            {filter.trim() && !exactExists && (
              <button
                className="db-popover-item db-create-item"
                onClick={() => {
                  onCreateOption(filter.trim());
                  setFilter('');
                }}
              >
                <IconPlus size={12} /> Create "{filter.trim()}"
              </button>
            )}
            {options.length === 0 && !filter.trim() && (
              <div className="muted small db-popover-empty">Type to create the vault's first tag here.</div>
            )}
          </div>
        </div>
      )}
    </DbPopover>
  );
}


function DbAttachmentThumb({ fileId, token }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) {
    return (
      <span className="db-attachment-thumb-error">
        <IconImageMissing size={12} />
      </span>
    );
  }
  return url ? <img src={url} className="db-attachment-thumb" alt="" /> : <span className="db-attachment-thumb loading" />;
}


function DbAttachmentCell({ value, onChange, type, dbFile, handlers }) {
  const inputRef = useRef(null);
  const accept = type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : undefined;
  const parentId = dbFile?.parents?.[0];
  const [busy, setBusy] = useState(false);
  const typeLabel = DB_COLUMN_TYPES[type]?.label.toLowerCase() || 'file';

  const handleFiles = async (files) => {
    if (!files.length || !parentId) return;
    setBusy(true);
    try {
      const uploaded = [];
      for (const f of files) {
        const rec = await handlers.uploadAttachment(parentId, f);
        uploaded.push({ id: rec.id, name: rec.name });
      }
      onChange([...value, ...uploaded]);
    } catch (err) {
      window.alert(`Couldn't upload: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-attachment-trigger" onClick={toggle}>
          {value.length === 0 ? (
            <span className="db-cell-text empty" />
          ) : type === 'image' ? (
            <span className="db-attachment-thumbs">
              {value.slice(0, 3).map((att) => (
                <DbAttachmentThumb key={att.id} fileId={att.id} token={handlers.token} />
              ))}
              {value.length > 3 && <span className="db-attachment-more">+{value.length - 3}</span>}
            </span>
          ) : (
            <span className="db-attachment-chips">
              {value.slice(0, 2).map((att) => (
                <span key={att.id} className="db-file-chip-mini">
                  <IconPaperclip size={10} /> {att.name}
                </span>
              ))}
              {value.length > 2 && <span className="db-attachment-more">+{value.length - 2}</span>}
            </span>
          )}
        </button>
      )}
      width={240}
    >
      {() => (
        <div className="db-attachment-popover">
          {value.map((att) => (
            <div key={att.id} className="db-attachment-row">
              {type === 'image' && <DbAttachmentThumb fileId={att.id} token={handlers.token} />}
              <span className="db-attachment-name" onClick={() => handlers.onOpenAsset({ id: att.id, name: att.name })}>
                {att.name}
              </span>
              <button className="db-attachment-remove" onClick={() => onChange(value.filter((a) => a.id !== att.id))}>
                <IconX size={12} />
              </button>
            </div>
          ))}
          {value.length === 0 && <div className="muted small db-popover-empty">No {typeLabel} attached yet.</div>}
          <button className="db-attachment-add" disabled={busy || !parentId} onClick={() => inputRef.current?.click()}>
            {busy ? <IconLoader size={13} /> : <IconUpload size={13} />} Upload {typeLabel}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={accept}
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              handleFiles(files);
            }}
          />
        </div>
      )}
    </DbPopover>
  );
}


// Single dispatcher used by both the dense table cell and the full-width
// row-detail panel — same editing UI, just different container CSS (see
// `dense`).
function DbCell({ column, value, onChange, dbFile, handlers, dense, onCreateOption }) {
  switch (column.type) {
    case 'text':
      return <DbTextCell value={value} onChange={onChange} multiline={false} dense={dense} />;
    case 'text_multiline':
      return <DbTextCell value={value} onChange={onChange} multiline dense={dense} />;
    case 'number_int':
      return <DbNumberCell value={value} onChange={onChange} integer />;
    case 'number_float':
      return <DbNumberCell value={value} onChange={onChange} />;
    case 'select':
      return <DbSelectCell value={value} onChange={onChange} column={column} />;
    case 'multi_select':
      return <DbMultiSelectCell value={value || []} onChange={onChange} column={column} onCreateOption={onCreateOption} />;
    case 'date':
      return <DbDateCell value={value} onChange={onChange} />;
    case 'checkbox':
      return <DbCheckboxCell value={!!value} onChange={onChange} />;
    case 'url':
      return <DbUrlCell value={value} onChange={onChange} />;
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return <DbAttachmentCell value={value || []} onChange={onChange} type={column.type} dbFile={dbFile} handlers={handlers} />;
    default:
      return <span className="db-cell-empty">—</span>;
  }
}

export { DbPopover, DbTextCell, DbNumberCell, DbCheckboxCell, DbUrlCell, DbDateCell, DbSelectCell, DbMultiSelectCell, DbAttachmentThumb, DbAttachmentCell, DbCell };
