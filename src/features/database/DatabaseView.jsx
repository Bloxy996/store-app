import { useCallback, useEffect, useState } from 'react';

import { IconCalendar, IconCheck, IconChevronDown, IconDatabase, IconKanban, IconLayoutGrid, IconLoader, IconPlus, IconSliders, IconTable, IconTrash } from '../../components/icons.jsx';
import { DbCalendarView } from './DbCalendarView.jsx';
import { DbManageColumnsModal, DbRowDetailModal } from './DbModals.jsx';
import { DbBoardView, DbGalleryView, DbTableView } from './DbViews.jsx';
import { DB_OPTION_COLORS, dbId, dbMakeRow, parseDatabaseContent, serializeDatabaseState } from './dbState.js';


// Shared by the wikilink-target effect (runs before hooks are conditionally
// skipped, see DatabaseView) and the in-render `rowTitle` used by the view
// renderers — one calculation, per section 3.4 of CLAUDE.md.
function rowTitleFallback(columns, row) {
  const firstTextColumnId = (columns.find((c) => c.type === 'text') || columns[0])?.id;
  const v = firstTextColumnId ? row.values[firstTextColumnId] : null;
  return (v && String(v).trim()) || 'Untitled';
}


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


const DB_VIEW_TYPE_ICONS = { table: IconTable, board: IconKanban, gallery: IconLayoutGrid, calendar: IconCalendar };


// A view's settings and "add view" used to each be their own `DbPopover`
// (floating, portaled to the viewport). Both are triggered from inside
// `.db-view-tabs`, which scrolls horizontally (`overflow-x: auto` — same
// clipping problem TabBar's tab strip has, see DropdownMenu.jsx's header
// comment), so a panel anchored *under one tab* would get clipped as soon
// as that tab scrolls near the row's edge. Instead of keeping the portal
// escape hatch, both now open one inline panel *below the whole tab row*
// (`DbViewPanel`, rendered once by `DatabaseView`), outside the scrolling
// container — genuinely part of the layout (pushes the view content down
// while open, never clipped), with only one open at a time. `DatabaseView`
// owns which one via `viewPanel` state.
function DbViewTab({ view, active, onSelect, panelOpen, onToggleSettings }) {
  const ViewIcon = DB_VIEW_TYPE_ICONS[view.type] || IconTable;
  return (
    <div className={`db-view-tab ${active ? 'active' : ''}`}>
      <button className="db-view-tab-btn" onClick={onSelect}>
        <ViewIcon size={13} />
        <span>{view.name}</span>
      </button>
      <button
        className={`db-view-tab-menu ${panelOpen ? 'active' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSettings();
        }}
      >
        <IconChevronDown size={11} />
      </button>
    </div>
  );
}


function DbAddViewButton({ panelOpen, onToggle }) {
  return (
    <button className={`db-add-view-btn ${panelOpen ? 'active' : ''}`} onClick={onToggle} title="Add view">
      <IconPlus size={13} />
    </button>
  );
}


// The inline panel itself — settings for one view, or the add-view form.
// Rendered once by DatabaseView, below `.db-view-tabs`, never portaled.
function DbViewPanel({ mode, view, columns, onRename, onChangeGroupBy, onChangeCover, onChangeDateColumn, onDelete, onAdd, onClose, canDelete }) {
  const [addName, setAddName] = useState('');
  const [renameDraft, setRenameDraft] = useState(view?.name || '');
  useEffect(() => setRenameDraft(view?.name || ''), [view]);

  if (mode === 'add') {
    return (
      <div className="db-view-panel-inline">
        <div className="db-view-panel-row">
          <input
            className="db-popover-filter"
            placeholder="View name"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
          {[
            { type: 'table', label: 'Table', icon: IconTable },
            { type: 'board', label: 'Board', icon: IconKanban },
            { type: 'gallery', label: 'Gallery', icon: IconLayoutGrid },
            { type: 'calendar', label: 'Calendar', icon: IconCalendar }
          ].map((opt) => (
            <button
              key={opt.type}
              className="db-popover-item"
              onClick={() => {
                onAdd(opt.type, addName.trim() || opt.label);
                setAddName('');
                onClose();
              }}
            >
              <opt.icon size={13} /> {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (mode === 'settings' && view) {
    return (
      <div className="db-view-panel-inline">
        <div className="db-view-panel-row">
          <input
            className="db-popover-filter"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => {
              const t = renameDraft.trim();
              if (t && t !== view.name) onRename(t);
              else setRenameDraft(view.name);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') onClose();
            }}
          />
          {view.type === 'board' && (
            <>
              <span className="db-popover-section-label">Group by</span>
              {columns.filter((c) => c.type === 'select').length === 0 && <span className="muted small">No Select properties yet.</span>}
              {columns
                .filter((c) => c.type === 'select')
                .map((c) => (
                  <button key={c.id} className="db-popover-item" onClick={() => onChangeGroupBy(c.id)}>
                    {c.name} {c.id === view.groupByColumnId && <IconCheck size={12} />}
                  </button>
                ))}
            </>
          )}
          {view.type === 'gallery' && (
            <>
              <span className="db-popover-section-label">Cover</span>
              <button className="db-popover-item" onClick={() => onChangeCover(null)}>
                None {!view.coverColumnId && <IconCheck size={12} />}
              </button>
              {columns
                .filter((c) => c.type === 'image')
                .map((c) => (
                  <button key={c.id} className="db-popover-item" onClick={() => onChangeCover(c.id)}>
                    {c.name} {c.id === view.coverColumnId && <IconCheck size={12} />}
                  </button>
                ))}
            </>
          )}
          {view.type === 'calendar' && (
            <>
              <span className="db-popover-section-label">Date property</span>
              {columns.filter((c) => c.type === 'date').length === 0 && <span className="muted small">No Date properties yet.</span>}
              {columns
                .filter((c) => c.type === 'date')
                .map((c) => (
                  <button key={c.id} className="db-popover-item" onClick={() => onChangeDateColumn(c.id)}>
                    {c.name} {c.id === view.dateColumnId && <IconCheck size={12} />}
                  </button>
                ))}
            </>
          )}
          {canDelete && (
            <button
              className="db-popover-item danger"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              <IconTrash size={13} /> Delete view
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}


// --- Top-level database pane -------------------------------------------------

function DatabaseView({ file, content, onChange, handlers, linkIndex, loading, initialRowTarget, onConsumeRowTarget }) {
  // Parsed/edited locally (like a form), not re-derived from `content` on
  // every render — LeafPane remounts this component (key={file.id}) on file
  // switch, so `content` is only ever read here at mount. Every mutation
  // pushes a fresh JSON string up through `onChange`, which flows into the
  // same buffer + debounced-save pipeline a note's textarea uses.
  const [state, setState] = useState(() => parseDatabaseContent(content));
  const [openRowId, setOpenRowId] = useState(null);
  const [managePropsOpen, setManagePropsOpen] = useState(false);
  // Which inline view panel (see DbViewPanel above) is open, if any:
  // { mode: 'settings', viewId } | { mode: 'add' } | null.
  const [viewPanel, setViewPanel] = useState(null);

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

  // Arrived here via a `[[Database.base#Row Title]]` link click — open that
  // row's detail modal, same as clicking the row directly. Matched by title
  // (case-insensitive, first match) rather than a stored id: consistent
  // with how every other wikilink in this app resolves by name, and needs
  // no new persisted identifier on rows. Deliberately not keyed on
  // `state.rows` — re-matching on every keystroke elsewhere in this
  // database would re-open the row mid-edit.
  //
  // MUST run before the `loading` early return below: this hook has to be
  // called on every render regardless of `loading`, or the hook count
  // differs between the loading-skeleton render and the first real render
  // and React throws "Rendered more hooks than during the previous render"
  // (minified error #310) the moment a database file finishes loading.
  useEffect(() => {
    if (loading || !initialRowTarget) return;
    const target = initialRowTarget.trim().toLowerCase();
    const match = state.rows.find((r) => rowTitleFallback(state.columns, r).toLowerCase() === target);
    if (match) setOpenRowId(match.id);
    onConsumeRowTarget?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRowTarget, loading]);

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
            : v.dateColumnId === colId
              ? { ...v, dateColumnId: null }
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
      if (type === 'calendar') view.dateColumnId = s.columns.find((c) => c.type === 'date')?.id || null;
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

  const rowTitle = (row) => rowTitleFallback(state.columns, row);

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
            panelOpen={viewPanel?.mode === 'settings' && viewPanel.viewId === v.id}
            onToggleSettings={() =>
              setViewPanel((p) => (p?.mode === 'settings' && p.viewId === v.id ? null : { mode: 'settings', viewId: v.id }))
            }
          />
        ))}
        <DbAddViewButton panelOpen={viewPanel?.mode === 'add'} onToggle={() => setViewPanel((p) => (p?.mode === 'add' ? null : { mode: 'add' }))} />
        <div className="db-toolbar-spacer" />
        <button className="db-manage-btn" onClick={() => setManagePropsOpen(true)}>
          <IconSliders size={13} /> Properties
        </button>
        <button className="db-new-row-btn" onClick={() => setOpenRowId(addRow())}>
          <IconPlus size={14} /> New
        </button>
      </div>

      {viewPanel && (
        <DbViewPanel
          mode={viewPanel.mode}
          view={viewPanel.mode === 'settings' ? state.views.find((v) => v.id === viewPanel.viewId) : null}
          columns={state.columns}
          canDelete={state.views.length > 1}
          onRename={(name) => updateView(viewPanel.viewId, { name })}
          onChangeGroupBy={(colId) => updateView(viewPanel.viewId, { groupByColumnId: colId })}
          onChangeCover={(colId) => updateView(viewPanel.viewId, { coverColumnId: colId })}
          onChangeDateColumn={(colId) => updateView(viewPanel.viewId, { dateColumnId: colId })}
          onDelete={() => deleteView(viewPanel.viewId)}
          onAdd={addView}
          onClose={() => setViewPanel(null)}
        />
      )}

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
          linkIndex={linkIndex}
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
      {activeView.type === 'calendar' && (
        <DbCalendarView
          state={state}
          view={activeView}
          onOpenRow={setOpenRowId}
          rowTitle={rowTitle}
          addRow={addRow}
          onChangeDateColumn={(colId) => updateView(activeView.id, { dateColumnId: colId })}
        />
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
