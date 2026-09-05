import { useCallback, useEffect, useState } from 'react';

import { IconCheck, IconChevronDown, IconDatabase, IconEdit, IconKanban, IconLayoutGrid, IconLoader, IconPlus, IconSliders, IconTable, IconTrash } from '../../components/icons.jsx';
import { DbPopover } from './DbCells.jsx';
import { DbManageColumnsModal, DbRowDetailModal } from './DbModals.jsx';
import { DbBoardView, DbGalleryView, DbTableView } from './DbViews.jsx';
import { DB_OPTION_COLORS, dbId, dbMakeRow, parseDatabaseContent, serializeDatabaseState } from './dbState.js';


// --- View tabs / title -------------------------------------------------------

function DbTitleField({ title, onRename }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  return (
    <input
      className="db-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const t = draft.trim() || 'Untitled database';
        setDraft(t);
        if (t !== title) onRename(t);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder="Untitled database"
    />
  );
}


const DB_VIEW_TYPE_ICONS = { table: IconTable, board: IconKanban, gallery: IconLayoutGrid };


function DbViewTab({ view, active, onSelect, onRename, onDelete, columns, onChangeGroupBy, onChangeCover }) {
  const ViewIcon = DB_VIEW_TYPE_ICONS[view.type] || IconTable;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  return (
    <div className={`db-view-tab ${active ? 'active' : ''}`}>
      <button className="db-view-tab-btn" onClick={onSelect}>
        <ViewIcon size={13} />
        {renaming ? (
          <input
            className="db-view-rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              setRenaming(false);
              const t = draft.trim();
              if (t && t !== view.name) onRename(t);
              else setDraft(view.name);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        ) : (
          <span>{view.name}</span>
        )}
      </button>
      <DbPopover
        trigger={(toggle) => (
          <button
            className="db-view-tab-menu"
            onClick={(e) => {
              e.stopPropagation();
              toggle(e);
            }}
          >
            <IconChevronDown size={11} />
          </button>
        )}
        width={200}
      >
        {(close) => (
          <div className="db-view-settings-popover">
            <button
              className="db-popover-item"
              onClick={() => {
                setRenaming(true);
                close();
              }}
            >
              <IconEdit size={13} /> Rename
            </button>
            {view.type === 'board' && (
              <>
                <div className="db-popover-section-label">Group by</div>
                {columns
                  .filter((c) => c.type === 'select')
                  .map((c) => (
                    <button
                      key={c.id}
                      className="db-popover-item"
                      onClick={() => {
                        onChangeGroupBy(c.id);
                        close();
                      }}
                    >
                      {c.name} {c.id === view.groupByColumnId && <IconCheck size={12} />}
                    </button>
                  ))}
                {columns.filter((c) => c.type === 'select').length === 0 && (
                  <div className="muted small db-popover-empty">No Select properties yet.</div>
                )}
              </>
            )}
            {view.type === 'gallery' && (
              <>
                <div className="db-popover-section-label">Cover image</div>
                <button
                  className="db-popover-item"
                  onClick={() => {
                    onChangeCover(null);
                    close();
                  }}
                >
                  None {!view.coverColumnId && <IconCheck size={12} />}
                </button>
                {columns
                  .filter((c) => c.type === 'image')
                  .map((c) => (
                    <button
                      key={c.id}
                      className="db-popover-item"
                      onClick={() => {
                        onChangeCover(c.id);
                        close();
                      }}
                    >
                      {c.name} {c.id === view.coverColumnId && <IconCheck size={12} />}
                    </button>
                  ))}
              </>
            )}
            {onDelete && (
              <button
                className="db-popover-item danger"
                onClick={() => {
                  onDelete();
                  close();
                }}
              >
                <IconTrash size={13} /> Delete view
              </button>
            )}
          </div>
        )}
      </DbPopover>
    </div>
  );
}


function DbAddViewButton({ onAdd }) {
  const [name, setName] = useState('');
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-add-view-btn" onClick={toggle} title="Add view">
          <IconPlus size={13} />
        </button>
      )}
      width={200}
    >
      {(close) => (
        <div className="db-add-view-popover">
          <input className="db-popover-filter" placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {[
            { type: 'table', label: 'Table', icon: IconTable },
            { type: 'board', label: 'Board', icon: IconKanban },
            { type: 'gallery', label: 'Gallery', icon: IconLayoutGrid }
          ].map((opt) => (
            <button
              key={opt.type}
              className="db-popover-item"
              onClick={() => {
                onAdd(opt.type, name.trim() || opt.label);
                setName('');
                close();
              }}
            >
              <opt.icon size={13} /> {opt.label}
            </button>
          ))}
        </div>
      )}
    </DbPopover>
  );
}


// --- Top-level database pane -------------------------------------------------

function DatabaseView({ file, content, onChange, handlers, linkIndex, loading }) {
  // Parsed/edited locally (like a form), not re-derived from `content` on
  // every render — LeafPane remounts this component (key={file.id}) on file
  // switch, so `content` is only ever read here at mount. Every mutation
  // pushes a fresh JSON string up through `onChange`, which flows into the
  // same buffer + debounced-save pipeline a note's textarea uses.
  const [state, setState] = useState(() => parseDatabaseContent(content));
  const [openRowId, setOpenRowId] = useState(null);
  const [managePropsOpen, setManagePropsOpen] = useState(false);

  const commit = useCallback(
    (updater) => {
      setState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onChange(serializeDatabaseState(next));
        return next;
      });
    },
    [onChange]
  );

  if (loading) {
    return (
      <div className="db-loading">
        <IconLoader size={18} /> Loading database…
      </div>
    );
  }

  const activeView = state.views.find((v) => v.id === state.activeViewId) || state.views[0];

  const addColumn = (col) => commit((s) => ({ ...s, columns: [...s.columns, col] }));
  const updateColumn = (colId, patch) => commit((s) => ({ ...s, columns: s.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)) }));
  const deleteColumn = (colId) =>
    commit((s) => ({
      ...s,
      columns: s.columns.filter((c) => c.id !== colId),
      rows: s.rows.map((r) => {
        const v = { ...r.values };
        delete v[colId];
        return { ...r, values: v };
      }),
      views: s.views.map((v) =>
        v.groupByColumnId === colId
          ? { ...v, groupByColumnId: null }
          : v.coverColumnId === colId
            ? { ...v, coverColumnId: null }
            : v.sortColumnId === colId
              ? { ...v, sortColumnId: null, sortDir: null }
              : v
      )
    }));
  const reorderColumn = (colId, dir) =>
    commit((s) => {
      const idx = s.columns.findIndex((c) => c.id === colId);
      const swapWith = idx + dir;
      if (idx === -1 || swapWith < 0 || swapWith >= s.columns.length) return s;
      const cols = s.columns.slice();
      const tmp = cols[idx];
      cols[idx] = cols[swapWith];
      cols[swapWith] = tmp;
      return { ...s, columns: cols };
    });

  const addRow = (presetValues) => {
    const row = dbMakeRow(state.columns);
    if (presetValues) Object.assign(row.values, presetValues);
    commit((s) => ({ ...s, rows: [...s.rows, row] }));
    return row.id;
  };
  const updateRowValue = (rowId, colId, value) =>
    commit((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.id === rowId ? { ...r, values: { ...r.values, [colId]: value }, updatedAt: Date.now() } : r))
    }));
  const deleteRow = (rowId) => commit((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== rowId) }));
  const addOptionAndSetValue = (colId, rowId, label, multi) =>
    commit((s) => {
      const col = s.columns.find((c) => c.id === colId);
      if (!col) return s;
      const newOpt = { id: dbId('opt'), label, color: DB_OPTION_COLORS[(col.options || []).length % DB_OPTION_COLORS.length] };
      const columns = s.columns.map((c) => (c.id === colId ? { ...c, options: [...(c.options || []), newOpt] } : c));
      const rows = s.rows.map((r) => {
        if (r.id !== rowId) return r;
        const prevVal = r.values[colId];
        const nextVal = multi ? [...(prevVal || []), newOpt.id] : newOpt.id;
        return { ...r, values: { ...r.values, [colId]: nextVal } };
      });
      return { ...s, columns, rows };
    });

  const addView = (type, name) =>
    commit((s) => {
      const view = { id: dbId('view'), name, type };
      if (type === 'board') view.groupByColumnId = s.columns.find((c) => c.type === 'select')?.id || null;
      if (type === 'gallery') view.coverColumnId = s.columns.find((c) => c.type === 'image')?.id || null;
      return { ...s, views: [...s.views, view], activeViewId: view.id };
    });
  const updateView = (viewId, patch) => commit((s) => ({ ...s, views: s.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) }));
  const deleteView = (viewId) =>
    commit((s) => {
      if (s.views.length <= 1) return s;
      const views = s.views.filter((v) => v.id !== viewId);
      return { ...s, views, activeViewId: s.activeViewId === viewId ? views[0].id : s.activeViewId };
    });
  const setActiveView = (viewId) => commit((s) => ({ ...s, activeViewId: viewId }));
  const renameTitle = (title) => commit((s) => ({ ...s, title }));

  const firstTextColumnId = (state.columns.find((c) => c.type === 'text') || state.columns[0])?.id;
  const rowTitle = (row) => {
    const v = firstTextColumnId ? row.values[firstTextColumnId] : null;
    return (v && String(v).trim()) || 'Untitled';
  };

  const openRow = state.rows.find((r) => r.id === openRowId) || null;

  return (
    <div className="db-view">
      <div className="db-header">
        <IconDatabase size={20} className="db-header-icon" />
        <DbTitleField title={state.title} onRename={renameTitle} />
      </div>
      <div className="db-view-tabs">
        {state.views.map((v) => (
          <DbViewTab
            key={v.id}
            view={v}
            active={v.id === activeView.id}
            onSelect={() => setActiveView(v.id)}
            onRename={(name) => updateView(v.id, { name })}
            onDelete={state.views.length > 1 ? () => deleteView(v.id) : null}
            columns={state.columns}
            onChangeGroupBy={(colId) => updateView(v.id, { groupByColumnId: colId })}
            onChangeCover={(colId) => updateView(v.id, { coverColumnId: colId })}
          />
        ))}
        <DbAddViewButton onAdd={addView} />
        <div className="db-toolbar-spacer" />
        <button className="db-manage-btn" onClick={() => setManagePropsOpen(true)}>
          <IconSliders size={13} /> Properties
        </button>
        <button className="db-new-row-btn" onClick={() => setOpenRowId(addRow())}>
          <IconPlus size={14} /> New
        </button>
      </div>

      {activeView.type === 'table' && (
        <DbTableView
          state={state}
          view={activeView}
          onSort={(colId, dir) => updateView(activeView.id, { sortColumnId: colId, sortDir: dir })}
          updateRowValue={updateRowValue}
          addRow={() => addRow()}
          deleteRow={deleteRow}
          onOpenRow={setOpenRowId}
          onCreateOption={addOptionAndSetValue}
          dbFile={file}
          handlers={handlers}
          onManageColumns={() => setManagePropsOpen(true)}
        />
      )}
      {activeView.type === 'board' && (
        <DbBoardView
          state={state}
          view={activeView}
          updateRowValue={updateRowValue}
          addRow={addRow}
          onOpenRow={setOpenRowId}
          rowTitle={rowTitle}
          deleteRow={deleteRow}
          onChangeGroupBy={(colId) => updateView(activeView.id, { groupByColumnId: colId })}
          token={handlers.token}
        />
      )}
      {activeView.type === 'gallery' && (
        <DbGalleryView state={state} view={activeView} onOpenRow={setOpenRowId} rowTitle={rowTitle} addRow={() => addRow()} handlers={handlers} />
      )}

      {managePropsOpen && (
        <DbManageColumnsModal
          columns={state.columns}
          onClose={() => setManagePropsOpen(false)}
          onAdd={addColumn}
          onUpdate={updateColumn}
          onDelete={deleteColumn}
          onReorder={reorderColumn}
        />
      )}

      {openRow && (
        <DbRowDetailModal
          row={openRow}
          columns={state.columns}
          onClose={() => setOpenRowId(null)}
          onChangeValue={(colId, value) => updateRowValue(openRow.id, colId, value)}
          onDelete={() => {
            deleteRow(openRow.id);
            setOpenRowId(null);
          }}
          handlers={handlers}
          linkIndex={linkIndex}
          dbFile={file}
          onCreateOption={addOptionAndSetValue}
        />
      )}
    </div>
  );
}

export { DbTitleField, DB_VIEW_TYPE_ICONS, DbViewTab, DbAddViewButton, DatabaseView };
