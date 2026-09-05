import { useState } from 'react';

import { IconCalendar, IconChevronDown, IconDatabase, IconExpand, IconPlus, IconTrash, IconX } from '../../components/icons.jsx';
import { DbAttachmentThumb, DbCell } from './DbCells.jsx';
import { DB_COLUMN_TYPES, DB_ROW_DND_MIME, DB_SORTABLE_TYPES, compareDbValues } from './dbState.js';


// --- Card property previews (Board / Gallery) -------------------------------

function DbCardPropPreview({ column, value }) {
  if (column.type === 'select') {
    const opt = (column.options || []).find((o) => o.id === value);
    if (!opt) return null;
    return (
      <span className="db-option-chip small" style={{ '--chip-color': opt.color }}>
        {opt.label}
      </span>
    );
  }
  if (column.type === 'multi_select') {
    const opts = (column.options || []).filter((o) => (value || []).includes(o.id));
    if (!opts.length) return null;
    return (
      <span className="db-card-prop-tags">
        {opts.map((o) => (
          <span key={o.id} className="db-option-chip small" style={{ '--chip-color': o.color }}>
            {o.label}
          </span>
        ))}
      </span>
    );
  }
  if (column.type === 'date') {
    if (!value) return null;
    return (
      <span className="db-card-prop-date">
        <IconCalendar size={10} /> {value}
      </span>
    );
  }
  return null;
}


// --- Table view --------------------------------------------------------------

// Column-header sort cycles unsorted -> ascending -> descending -> unsorted.
// `view.sortColumnId`/`view.sortDir` persist to the .base file like any
// other view setting, so the sort sticks around after reopening the vault.
function DbTableView({ state, view, onSort, updateRowValue, addRow, deleteRow, onOpenRow, onCreateOption, dbFile, handlers, onManageColumns }) {
  const sortCol = view.sortColumnId ? state.columns.find((c) => c.id === view.sortColumnId) : null;
  const rows = sortCol
    ? state.rows.slice().sort((a, b) => {
        const cmp = compareDbValues(sortCol, a.values[sortCol.id], b.values[sortCol.id]);
        return view.sortDir === 'desc' ? -cmp : cmp;
      })
    : state.rows;

  const cycleSort = (col) => {
    if (!DB_SORTABLE_TYPES.has(col.type)) return;
    if (view.sortColumnId !== col.id) onSort(col.id, 'asc');
    else if (view.sortDir === 'asc') onSort(col.id, 'desc');
    else onSort(null, null);
  };

  return (
    <div className="db-table-scroll">
      <table className="db-table">
        <thead>
          <tr>
            <th className="db-th-expand" />
            {state.columns.map((col) => {
              const Icon = DB_COLUMN_TYPES[col.type]?.icon;
              const sortable = DB_SORTABLE_TYPES.has(col.type);
              const active = view.sortColumnId === col.id;
              return (
                <th
                  key={col.id}
                  className={`db-th ${sortable ? 'db-th-sortable' : ''}`}
                  onClick={sortable ? () => cycleSort(col) : undefined}
                  title={sortable ? `Sort by ${col.name}` : undefined}
                >
                  {Icon && <Icon size={12} className="db-th-icon" />}
                  <span>{col.name}</span>
                  {active && (
                    <IconChevronDown size={12} className={`db-th-sort-arrow ${view.sortDir === 'asc' ? 'asc' : ''}`} />
                  )}
                </th>
              );
            })}
            <th className="db-th-add">
              <button className="db-add-col-btn" onClick={onManageColumns} title="Add property">
                <IconPlus size={14} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="db-tr">
              <td className="db-td-expand">
                <button className="db-expand-btn" onClick={() => onOpenRow(row.id)} title="Open">
                  <IconExpand size={11} />
                </button>
              </td>
              {state.columns.map((col) => (
                <td key={col.id} className="db-td">
                  <DbCell
                    column={col}
                    value={row.values[col.id]}
                    onChange={(v) => updateRowValue(row.id, col.id, v)}
                    dbFile={dbFile}
                    handlers={handlers}
                    dense
                    onCreateOption={(label) => onCreateOption(col.id, row.id, label, col.type === 'multi_select')}
                  />
                </td>
              ))}
              <td className="db-td-actions">
                <button className="db-row-delete" onClick={() => deleteRow(row.id)} title="Delete row">
                  <IconTrash size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="db-add-row-btn" onClick={addRow}>
        <IconPlus size={13} /> New
      </button>
      {state.rows.length === 0 && <p className="muted small db-empty-hint">No rows yet.</p>}
    </div>
  );
}


// --- Board view ----------------------------------------------------------------

function DbGroupByPicker({ columns, onPick }) {
  const selectCols = columns.filter((c) => c.type === 'select');
  if (!selectCols.length) return <p className="muted small">Add a Select property first, from Properties.</p>;
  return (
    <div className="db-groupby-pick-list">
      {selectCols.map((c) => (
        <button key={c.id} className="db-popover-item" onClick={() => onPick(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}


function DbCardCover({ fileId, token }) {
  return (
    <div className="db-card-cover">
      <DbAttachmentThumb fileId={fileId} token={token} />
    </div>
  );
}


function DbBoardColumn({ bucket, rows, groupColId, columns, rowTitle, onOpenRow, onDropRow, onAddRow, onDeleteRow, coverColumn, token }) {
  const [dragOver, setDragOver] = useState(false);
  const previewCols = columns.filter((c) => c.id !== groupColId && (c.type === 'multi_select' || c.type === 'select' || c.type === 'date')).slice(0, 3);
  return (
    <div
      className={`db-board-col ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const rowId = e.dataTransfer.getData(DB_ROW_DND_MIME);
        if (rowId) onDropRow(rowId);
      }}
    >
      <div className="db-board-col-header">
        <span className="db-option-chip" style={{ '--chip-color': bucket.color }}>
          {bucket.label}
        </span>
        <span className="db-board-col-count">{rows.length}</span>
      </div>
      <div className="db-board-col-body">
        {rows.map((row) => (
          <div
            key={row.id}
            className="db-board-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DB_ROW_DND_MIME, row.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onOpenRow(row.id)}
          >
            {coverColumn && (row.values[coverColumn.id] || [])[0] && (
              <DbCardCover fileId={row.values[coverColumn.id][0].id} token={token} />
            )}
            <div className="db-board-card-title">{rowTitle(row)}</div>
            <div className="db-board-card-props">
              {previewCols.map((c) => (
                <DbCardPropPreview key={c.id} column={c} value={row.values[c.id]} />
              ))}
            </div>
            <button
              className="db-board-card-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRow(row.id);
              }}
            >
              <IconX size={11} />
            </button>
          </div>
        ))}
        <button className="db-board-add-card" onClick={onAddRow}>
          <IconPlus size={12} /> New
        </button>
      </div>
    </div>
  );
}


function DbBoardView({ state, view, updateRowValue, addRow, onOpenRow, rowTitle, deleteRow, onChangeGroupBy, token }) {
  const groupCol = state.columns.find((c) => c.id === view.groupByColumnId && c.type === 'select');
  if (!groupCol) {
    return (
      <div className="db-board-empty">
        <p className="muted small">Pick a Select property to group this board by.</p>
        <DbGroupByPicker columns={state.columns} onPick={onChangeGroupBy} />
      </div>
    );
  }
  const buckets = [{ id: null, label: 'No status', color: '#767676' }, ...groupCol.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))];
  const rowsByBucket = new Map(buckets.map((b) => [b.id, []]));
  state.rows.forEach((row) => {
    const v = row.values[groupCol.id] || null;
    if (!rowsByBucket.has(v)) rowsByBucket.set(v, []);
    rowsByBucket.get(v).push(row);
  });
  const coverColumn = state.columns.find((c) => c.id === view.coverColumnId && c.type === 'image');

  return (
    <div className="db-board">
      {buckets.map((bucket) => (
        <DbBoardColumn
          key={String(bucket.id)}
          bucket={bucket}
          rows={rowsByBucket.get(bucket.id) || []}
          groupColId={groupCol.id}
          columns={state.columns}
          rowTitle={rowTitle}
          onOpenRow={onOpenRow}
          onDropRow={(rowId) => updateRowValue(rowId, groupCol.id, bucket.id)}
          onAddRow={() => onOpenRow(addRow({ [groupCol.id]: bucket.id }))}
          onDeleteRow={deleteRow}
          coverColumn={coverColumn}
          token={token}
        />
      ))}
    </div>
  );
}


// --- Gallery view --------------------------------------------------------------

function DbGalleryView({ state, view, onOpenRow, rowTitle, addRow, handlers }) {
  const coverColumn = state.columns.find((c) => c.id === view.coverColumnId && c.type === 'image');
  const previewCols = state.columns.filter((c) => c.type === 'select' || c.type === 'multi_select').slice(0, 2);
  return (
    <div className="db-gallery">
      <div className="db-gallery-grid">
        {state.rows.map((row) => {
          const cover = coverColumn ? (row.values[coverColumn.id] || [])[0] : null;
          return (
            <div key={row.id} className="db-gallery-card" onClick={() => onOpenRow(row.id)}>
              <div className="db-gallery-cover">
                {cover ? (
                  <DbAttachmentThumb fileId={cover.id} token={handlers.token} />
                ) : (
                  <div className="db-gallery-cover-placeholder">
                    <IconDatabase size={22} />
                  </div>
                )}
              </div>
              <div className="db-gallery-title">{rowTitle(row)}</div>
              <div className="db-gallery-props">
                {previewCols.map((c) => (
                  <DbCardPropPreview key={c.id} column={c} value={row.values[c.id]} />
                ))}
              </div>
            </div>
          );
        })}
        <button className="db-gallery-add" onClick={addRow}>
          <IconPlus size={16} /> New
        </button>
      </div>
      {!coverColumn && state.columns.some((c) => c.type === 'image') && (
        <p className="muted small db-empty-hint">Pick an Image property as the cover from this view's menu.</p>
      )}
    </div>
  );
}

export { DbCardPropPreview, DbTableView, DbGroupByPicker, DbCardCover, DbBoardColumn, DbBoardView, DbGalleryView };
