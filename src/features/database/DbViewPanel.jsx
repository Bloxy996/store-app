import { useEffect, useState } from 'react';

import { IconCalendar, IconCheck, IconChartBar, IconKanban, IconLayoutGrid, IconTable, IconTimeline, IconTrash } from '../../components/icons.jsx';
import { DbAggregatePicker } from './DbChartView.jsx';
import { DbDateColumnPicker } from './dbDateUtils.jsx';

// The inline panel itself — settings for one view, or the add-view form.
// Rendered once by DatabaseView, below `.db-view-tabs`, never portaled.
// Split out of DatabaseView.jsx once that file passed the ~500-line soft
// ceiling (section 3.7) — same "sub-piece only the parent renders" split
// DbCalendarView/DbChartView already got, just later since this one grew
// past the line rather than being new.
function DbViewPanel({
  mode,
  view,
  columns,
  onRename,
  onChangeGroupBy,
  onChangeCover,
  onChangeDateColumn,
  onChangeChartConfig,
  onChangeStartColumn,
  onChangeEndColumn,
  onDelete,
  onAdd,
  onClose,
  canDelete
}) {
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
            { type: 'calendar', label: 'Calendar', icon: IconCalendar },
            { type: 'chart', label: 'Chart', icon: IconChartBar },
            { type: 'timeline', label: 'Timeline', icon: IconTimeline }
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
          {view.type === 'chart' && (
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
              <DbAggregatePicker columns={columns} view={view} onChange={onChangeChartConfig} />
            </>
          )}
          {view.type === 'timeline' && (
            <>
              <span className="db-popover-section-label">Start date</span>
              <DbDateColumnPicker columns={columns} excludeId={view.endColumnId} selectedId={view.startColumnId} onPick={onChangeStartColumn} />
              <span className="db-popover-section-label">End date</span>
              <DbDateColumnPicker columns={columns} excludeId={view.startColumnId} selectedId={view.endColumnId} onPick={onChangeEndColumn} />
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

export { DbViewPanel };
