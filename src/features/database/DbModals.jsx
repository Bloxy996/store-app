import { useEffect, useState } from 'react';

import { IconChevronDown, IconEye, IconPlus, IconTrash, IconX } from '../../components/icons.jsx';
import { DbCell } from './DbCells.jsx';
import { DB_COLUMN_TYPES, DB_OPTION_COLORS, dbId } from './dbState.js';
import { renderInline } from '../../lib/markdownRender.jsx';


// --- Row detail panel (Notion-style "open page") --------------------------

function DbRowDetailModal({ row, columns, onClose, onChangeValue, onDelete, handlers, linkIndex, dbFile, onCreateOption }) {
  const previewCol = columns.find((c) => c.type === 'text_multiline');
  return (
    <div className="modal-overlay db-row-modal-overlay" onClick={onClose}>
      <div className="db-row-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-row-modal-header">
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
          <button className="db-row-delete-btn" onClick={onDelete}>
            <IconTrash size={13} /> Delete
          </button>
        </div>
        <div className="db-row-modal-body">
          {columns.map((col) => {
            const Icon = DB_COLUMN_TYPES[col.type]?.icon;
            return (
              <div key={col.id} className="db-row-prop">
                <div className="db-row-prop-label">
                  {Icon && <Icon size={12} />}
                  <span>{col.name}</span>
                </div>
                <div className="db-row-prop-value">
                  <DbCell
                    column={col}
                    value={row.values[col.id]}
                    onChange={(v) => onChangeValue(col.id, v)}
                    dbFile={dbFile}
                    handlers={handlers}
                    onCreateOption={(label) => onCreateOption(col.id, row.id, label, col.type === 'multi_select')}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {previewCol && (
          <div className="db-row-modal-preview">
            <div className="db-row-prop-label">
              <IconEye size={12} />
              <span>Preview</span>
            </div>
            <div className="db-row-preview-body">{renderInline(row.values[previewCol.id] || '', 'dbprev', handlers, linkIndex)}</div>
          </div>
        )}
      </div>
    </div>
  );
}


// --- Property (column) management modal -------------------------------------

function DbOptionsEditor({ options, onChange }) {
  const [draft, setDraft] = useState('');
  const addOption = () => {
    const label = draft.trim();
    if (!label) return;
    onChange([...options, { id: dbId('opt'), label, color: DB_OPTION_COLORS[options.length % DB_OPTION_COLORS.length] }]);
    setDraft('');
  };
  return (
    <div className="db-options-editor">
      {options.map((o) => (
        <div key={o.id} className="db-option-editor-row">
          <span className="db-option-chip" style={{ '--chip-color': o.color }}>
            {o.label}
          </span>
          <span className="db-option-color-swatches">
            {DB_OPTION_COLORS.map((c) => (
              <button
                key={c}
                className={`db-color-swatch ${o.color === c ? 'active' : ''}`}
                style={{ '--swatch-color': c }}
                onClick={() => onChange(options.map((opt) => (opt.id === o.id ? { ...opt, color: c } : opt)))}
              />
            ))}
          </span>
          <button className="db-option-remove" onClick={() => onChange(options.filter((opt) => opt.id !== o.id))}>
            <IconX size={11} />
          </button>
        </div>
      ))}
      <div className="db-option-add-row">
        <input
          className="db-popover-filter"
          placeholder="Add option"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addOption();
            }
          }}
        />
        <button className="db-option-add-btn" onClick={addOption}>
          <IconPlus size={12} />
        </button>
      </div>
    </div>
  );
}


function DbColumnEditorRow({ column, onUpdate, onDelete, onMoveUp, onMoveDown }) {
  const [name, setName] = useState(column.name);
  useEffect(() => setName(column.name), [column.name]);
  const Icon = DB_COLUMN_TYPES[column.type]?.icon;
  const hasOptions = column.type === 'select' || column.type === 'multi_select';
  return (
    <div className="db-column-editor-row">
      <div className="db-column-editor-main">
        <span className="db-reorder-btns">
          <button disabled={!onMoveUp} onClick={onMoveUp} title="Move up">
            <IconChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button disabled={!onMoveDown} onClick={onMoveDown} title="Move down">
            <IconChevronDown size={11} />
          </button>
        </span>
        {Icon && <Icon size={13} className="db-column-editor-icon" />}
        <input
          className="db-column-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const t = name.trim();
            if (t && t !== column.name) onUpdate({ name: t });
            else setName(column.name);
          }}
        />
        <span className="db-column-type-label">{DB_COLUMN_TYPES[column.type]?.label}</span>
        <button className="db-column-delete-btn" onClick={onDelete} title="Delete property">
          <IconTrash size={13} />
        </button>
      </div>
      {hasOptions && <DbOptionsEditor options={column.options || []} onChange={(options) => onUpdate({ options })} />}
    </div>
  );
}


function DbManageColumnsModal({ columns, onClose, onAdd, onUpdate, onDelete, onReorder }) {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('text');
  return (
    <div className="modal-overlay db-manage-overlay" onClick={onClose}>
      <div className="db-manage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-manage-header">
          <span>Properties</span>
          <button className="icon-btn" onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <div className="db-manage-list">
          {columns.map((col, i) => (
            <DbColumnEditorRow
              key={col.id}
              column={col}
              onUpdate={(patch) => onUpdate(col.id, patch)}
              onDelete={() => {
                if (window.confirm(`Delete property "${col.name}"? This removes it from every row.`)) onDelete(col.id);
              }}
              onMoveUp={i > 0 ? () => onReorder(col.id, -1) : null}
              onMoveDown={i < columns.length - 1 ? () => onReorder(col.id, 1) : null}
            />
          ))}
        </div>
        <div className="db-manage-add">
          <input
            className="db-popover-filter"
            placeholder="New property name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                const col = { id: dbId('col'), name: newName.trim(), type: newType };
                if (newType === 'select' || newType === 'multi_select') col.options = [];
                onAdd(col);
                setNewName('');
              }
            }}
          />
          <select className="db-type-select" value={newType} onChange={(e) => setNewType(e.target.value)}>
            {Object.entries(DB_COLUMN_TYPES).map(([type, meta]) => (
              <option key={type} value={type}>
                {meta.label}
              </option>
            ))}
          </select>
          <button
            className="db-manage-add-btn"
            onClick={() => {
              if (!newName.trim()) return;
              const col = { id: dbId('col'), name: newName.trim(), type: newType };
              if (newType === 'select' || newType === 'multi_select') col.options = [];
              onAdd(col);
              setNewName('');
            }}
          >
            <IconPlus size={13} /> Add property
          </button>
        </div>
      </div>
    </div>
  );
}

export { DbRowDetailModal, DbOptionsEditor, DbColumnEditorRow, DbManageColumnsModal };
