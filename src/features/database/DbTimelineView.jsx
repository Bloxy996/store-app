import { useMemo } from 'react';

import { daysBetween, isoDate, DbDateColumnPicker } from './dbDateUtils.jsx';

// --- Timeline view -------------------------------------------------------
// Notion's Gantt-lane timeline: one horizontal bar per row, spanning from a
// Start date column to an End date column (the two-date-column requirement
// section 18 flagged as this view's one genuinely new layout primitive —
// nothing in DbCalendarView/DbChartView's single-date-per-row model is
// close to it). A row missing either date, or with end before start,
// doesn't get a bar — same "just doesn't appear" rule Calendar already
// uses for rows with no date, rather than inventing an "unscheduled" lane.
//
// Deliberately not done in this first pass: dragging a bar to move/resize
// it (a real interaction-design + drag-math project on the order of the
// canvas's own drag system, not a quick addition), a separate frozen title
// column (row titles render inside their own bar instead, which is fine
// until a title is wider than a short bar), and a zoom control (day width
// is a fixed constant). See CLAUDE.md's changelog entry for this pass.

const DAY_WIDTH = 32;
const PAD_DAYS = 2;

function DbTimelineView({ state, view, onOpenRow, rowTitle, onChangeStartColumn, onChangeEndColumn }) {
  const startCol = state.columns.find((c) => c.id === view.startColumnId && c.type === 'date');
  const endCol = state.columns.find((c) => c.id === view.endColumnId && c.type === 'date');

  const { rangeStart, days, bars } = useMemo(() => {
    if (!startCol || !endCol) return { rangeStart: null, days: [], bars: [] };
    const valid = state.rows
      .map((row) => ({ row, start: row.values[startCol.id], end: row.values[endCol.id] }))
      .filter((r) => r.start && r.end && daysBetween(r.start, r.end) >= 0);
    if (!valid.length) return { rangeStart: null, days: [], bars: [] };

    const toDate = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    };
    let minD = toDate(valid[0].start);
    let maxD = toDate(valid[0].end);
    valid.forEach((r) => {
      const s = toDate(r.start);
      const e = toDate(r.end);
      if (s < minD) minD = s;
      if (e > maxD) maxD = e;
    });
    minD = new Date(minD.getFullYear(), minD.getMonth(), minD.getDate() - PAD_DAYS);
    maxD = new Date(maxD.getFullYear(), maxD.getMonth(), maxD.getDate() + PAD_DAYS);
    const rangeStartIso = isoDate(minD.getFullYear(), minD.getMonth(), minD.getDate());
    const totalDays = daysBetween(rangeStartIso, isoDate(maxD.getFullYear(), maxD.getMonth(), maxD.getDate())) + 1;

    const dayCells = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minD.getFullYear(), minD.getMonth(), minD.getDate() + i);
      dayCells.push({
        iso: isoDate(d.getFullYear(), d.getMonth(), d.getDate()),
        label: d.getDate(),
        isFirstOfMonth: d.getDate() === 1,
        monthLabel: d.toLocaleDateString(undefined, { month: 'short' }),
        isWeekend: d.getDay() === 0 || d.getDay() === 6
      });
    }

    const barList = valid.map(({ row, start, end }) => ({
      row,
      left: daysBetween(rangeStartIso, start) * DAY_WIDTH,
      width: (daysBetween(start, end) + 1) * DAY_WIDTH - 4
    }));

    return { rangeStart: rangeStartIso, days: dayCells, bars: barList };
  }, [state.rows, startCol, endCol]);

  if (!startCol || !endCol) {
    return (
      <div className="db-board-empty">
        <p className="muted small">Pick a Start and an End date property to place rows on this timeline.</p>
        <span className="db-popover-section-label">Start date</span>
        <DbDateColumnPicker columns={state.columns} excludeId={view.endColumnId} onPick={onChangeStartColumn} />
        <span className="db-popover-section-label">End date</span>
        <DbDateColumnPicker columns={state.columns} excludeId={view.startColumnId} onPick={onChangeEndColumn} />
      </div>
    );
  }

  if (!rangeStart) {
    return (
      <p className="muted small db-timeline-empty">
        No rows have both {startCol.name} and {endCol.name} set yet.
      </p>
    );
  }

  const todayIso = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const todayOffset = daysBetween(rangeStart, todayIso) * DAY_WIDTH;
  const totalWidth = days.length * DAY_WIDTH;
  const showTodayLine = todayOffset >= 0 && todayOffset <= totalWidth;

  return (
    <div className="db-timeline-scroll">
      <div className="db-timeline-inner" style={{ width: totalWidth }}>
        <div className="db-timeline-ruler">
          {days.map((d) => (
            <div key={d.iso} className={`db-timeline-day ${d.isWeekend ? 'weekend' : ''}`} style={{ width: DAY_WIDTH }}>
              {d.isFirstOfMonth && <span className="db-timeline-month">{d.monthLabel}</span>}
              <span className="db-timeline-daynum">{d.label}</span>
            </div>
          ))}
        </div>
        <div className="db-timeline-lanes">
          {showTodayLine && <div className="db-timeline-today" style={{ left: todayOffset + DAY_WIDTH / 2 }} />}
          {bars.map(({ row, left, width }) => (
            <div key={row.id} className="db-timeline-lane">
              <button className="db-timeline-bar" style={{ left, width: Math.max(width, 20) }} onClick={() => onOpenRow(row.id)} title={rowTitle(row)}>
                <span className="db-timeline-bar-label">{rowTitle(row)}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { DbTimelineView };
