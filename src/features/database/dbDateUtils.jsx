// Date-column helpers shared by DbCalendarView and DbTimelineView — pulled
// out once Timeline needed the exact same "pick a Date property" pattern
// Calendar already had, twice over (start + end), rather than duplicating
// pad2/isoDate/the picker component in a second file (section 3.4).
//
// Date columns store plain 'YYYY-MM-DD' strings (DbDateCell's
// <input type="date">); `isoDate` is the only place that format gets
// built from a JS Date, so both views stay consistent with each other and
// with the cell editor without timezone math creeping in anywhere else.

import { IconCheck } from '../../components/icons.jsx';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

// Whole-day difference between two 'YYYY-MM-DD' strings. Parsed as local
// midnight (not UTC) so this matches how <input type="date"> and isoDate
// above already treat these strings elsewhere in the app.
function daysBetween(isoA, isoB) {
  const [ay, am, ad] = isoA.split('-').map(Number);
  const [by, bm, bd] = isoB.split('-').map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

// `excludeId` lets Timeline's End-date picker hide whichever column is
// already picked as Start (and vice versa) — picking the same property for
// both would make every bar a single-day sliver, so there's no reason to
// even offer it. `selectedId`, if passed, shows a checkmark next to the
// current pick (Calendar's own settings-panel usage doesn't pass it, since
// that one inlines its own checkmarked list instead of this component —
// see DbViewPanel.jsx — but Timeline needs two of these side by side, so
// it's worth the shared component supporting it).
function DbDateColumnPicker({ columns, onPick, excludeId, selectedId }) {
  const dateCols = columns.filter((c) => c.type === 'date' && c.id !== excludeId);
  if (!dateCols.length) return <p className="muted small">Add a Date property first, from Properties.</p>;
  return (
    <div className="db-groupby-pick-list">
      {dateCols.map((c) => (
        <button key={c.id} className="db-popover-item" onClick={() => onPick(c.id)}>
          {c.name} {c.id === selectedId && <IconCheck size={12} />}
        </button>
      ))}
    </div>
  );
}

export { pad2, isoDate, daysBetween, DbDateColumnPicker };
