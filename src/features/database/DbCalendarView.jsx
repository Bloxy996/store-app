import { useMemo, useState } from 'react';

import { IconArrowLeft, IconArrowRight, IconPlus } from '../../components/icons.jsx';
import { DbCardPropPreview } from './DbViews.jsx';
import { DbDateColumnPicker, isoDate } from './dbDateUtils.jsx';

// --- Calendar view -----------------------------------------------------------
// Notion-style month grid: requires one Date property (view.dateColumnId,
// same "pick a required column" pattern DbBoardView already uses for its
// Select group-by column — see DbGroupByPicker there). Each row is placed
// on the day its date column falls on; rows with no value in that column,
// or an unparsable one, just don't appear (no "unscheduled" bucket — unlike
// Board's grouping, a day a row doesn't belong to isn't a meaningful state
// to render). Date columns store plain 'YYYY-MM-DD' strings (DbDateCell's
// <input type="date">), so this compares strings directly — no timezone
// math needed. pad2/isoDate/DbDateColumnPicker live in dbDateUtils.jsx,
// shared with DbTimelineView.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 42 cells (6 full weeks) starting from the Sunday on/before the 1st, so
// the grid never reflows height between months.
function buildMonthCells(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay();
  const start = new Date(year, month, 1 - startOffset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: isoDate(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === month });
  }
  return cells;
}

function DbCalendarView({ state, view, onOpenRow, rowTitle, addRow, onChangeDateColumn }) {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));
  const dateCol = state.columns.find((c) => c.id === view.dateColumnId && c.type === 'date');

  if (!dateCol) {
    return (
      <div className="db-board-empty">
        <p className="muted small">Pick a Date property to place rows on this calendar.</p>
        <DbDateColumnPicker columns={state.columns} onPick={onChangeDateColumn} />
      </div>
    );
  }

  const cells = buildMonthCells(cursor.year, cursor.month);
  const rowsByDate = new Map();
  state.rows.forEach((row) => {
    const v = row.values[dateCol.id];
    if (!v) return;
    if (!rowsByDate.has(v)) rowsByDate.set(v, []);
    rowsByDate.get(v).push(row);
  });
  const previewCols = state.columns.filter((c) => c.id !== dateCol.id && (c.type === 'select' || c.type === 'multi_select')).slice(0, 1);
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const todayIso = isoDate(today.getFullYear(), today.getMonth(), today.getDate());

  const shiftMonth = (dir) =>
    setCursor((c) => {
      const d = new Date(c.year, c.month + dir, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div className="db-calendar">
      <div className="db-cal-header">
        <button className="db-cal-nav" onClick={() => shiftMonth(-1)} title="Previous month">
          <IconArrowLeft size={14} />
        </button>
        <span className="db-cal-month-label">{monthLabel}</span>
        <button className="db-cal-nav" onClick={() => shiftMonth(1)} title="Next month">
          <IconArrowRight size={14} />
        </button>
        <button className="db-cal-today" onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}>
          Today
        </button>
      </div>
      <div className="db-cal-grid db-cal-weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="db-cal-weekday">
            {w}
          </div>
        ))}
      </div>
      <div className="db-cal-grid db-cal-days">
        {cells.map((cell) => {
          const rows = rowsByDate.get(cell.date) || [];
          return (
            <div key={cell.date} className={`db-cal-cell ${cell.inMonth ? '' : 'outside'} ${cell.date === todayIso ? 'today' : ''}`}>
              <div className="db-cal-cell-head">
                <span className="db-cal-daynum">{cell.day}</span>
                <button
                  className="db-cal-cell-add"
                  title="New row on this day"
                  onClick={() => onOpenRow(addRow({ [dateCol.id]: cell.date }))}
                >
                  <IconPlus size={11} />
                </button>
              </div>
              <div className="db-cal-cell-rows">
                {rows.map((row) => (
                  <button key={row.id} className="db-cal-row-chip" onClick={() => onOpenRow(row.id)} title={rowTitle(row)}>
                    <span className="db-cal-row-title">{rowTitle(row)}</span>
                    {previewCols.map((c) => (
                      <DbCardPropPreview key={c.id} column={c} value={row.values[c.id]} />
                    ))}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { DbCalendarView };
