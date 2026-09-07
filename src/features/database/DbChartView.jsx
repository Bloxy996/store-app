import { useMemo, useState } from 'react';

import { IconCheck, IconChartBar, IconChartLine, IconChartPie } from '../../components/icons.jsx';
import { aggregateDbRows } from './dbState.js';
import { DbGroupByPicker } from './DbViews.jsx';

// --- Chart view --------------------------------------------------------------
// Bar/line/pie over one Select property's option counts (or a sum/average
// of a Number property per option) — Notion's Chart view, same idea: one
// view type with a style switcher, not three separate view types, since
// all three read the exact same aggregated data (aggregateDbRows,
// dbState.js) and differ only in how that's drawn. Plain hand-rolled SVG,
// no chart library — same approach GraphView already takes, and this is
// simple enough (three geometries, no interaction beyond hover) not to
// need one.

const CHART_STYLES = [
  { type: 'bar', icon: IconChartBar, label: 'Bar' },
  { type: 'line', icon: IconChartLine, label: 'Line' },
  { type: 'pie', icon: IconChartPie, label: 'Pie' }
];

// Exported so DatabaseView's settings panel (same "requirements live in
// the view's settings dropdown" pattern Board/Gallery/Calendar already
// use) can offer it next to DbGroupByPicker.
function DbAggregatePicker({ columns, view, onChange }) {
  const numericCols = columns.filter((c) => c.type === 'number_int' || c.type === 'number_float');
  const isCount = (view.aggregateFn || 'count') === 'count';
  return (
    <>
      <span className="db-popover-section-label">Aggregate</span>
      <button className="db-popover-item" onClick={() => onChange({ aggregateFn: 'count', valueColumnId: null })}>
        Count of rows {isCount && <IconCheck size={12} />}
      </button>
      {numericCols.length === 0 && <span className="muted small">Add a Number property for sum/average.</span>}
      {numericCols.map((c) => (
        <div key={c.id} className="db-chart-agg-group">
          <button className="db-popover-item" onClick={() => onChange({ aggregateFn: 'sum', valueColumnId: c.id })}>
            Sum of {c.name} {view.aggregateFn === 'sum' && view.valueColumnId === c.id && <IconCheck size={12} />}
          </button>
          <button className="db-popover-item" onClick={() => onChange({ aggregateFn: 'average', valueColumnId: c.id })}>
            Average of {c.name} {view.aggregateFn === 'average' && view.valueColumnId === c.id && <IconCheck size={12} />}
          </button>
        </div>
      ))}
    </>
  );
}

const VB_W = 640;
const VB_H = 300;
const PAD = { top: 16, right: 16, bottom: 28, left: 16 };

function DbChartBars({ data, maxValue }) {
  const innerW = VB_W - PAD.left - PAD.right;
  const innerH = VB_H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const barW = Math.min(56, slot * 0.6);
  return (
    <>
      {data.map((d, i) => {
        const h = maxValue > 0 ? (d.value / maxValue) * innerH : 0;
        const x = PAD.left + i * slot + (slot - barW) / 2;
        const y = PAD.top + innerH - h;
        return <rect key={d.key} x={x} y={y} width={barW} height={Math.max(h, 1)} rx={3} fill={d.color || 'var(--accent)'} />;
      })}
    </>
  );
}

function DbChartLine({ data, maxValue }) {
  const innerW = VB_W - PAD.left - PAD.right;
  const innerH = VB_H - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const points = data.map((d, i) => {
    const x = PAD.left + i * slot + slot / 2;
    const y = PAD.top + innerH - (maxValue > 0 ? (d.value / maxValue) * innerH : 0);
    return { x, y, d };
  });
  return (
    <>
      <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {points.map((p) => (
        <circle key={p.d.key} cx={p.x} cy={p.y} r={4} fill={p.d.color || 'var(--accent)'} />
      ))}
    </>
  );
}

function DbChartPie({ data, total }) {
  const cx = VB_W / 2;
  const cy = VB_H / 2;
  const r = Math.min(VB_W, VB_H) / 2 - 20;
  let angle = -Math.PI / 2;
  if (total <= 0) return <circle cx={cx} cy={cy} r={r} fill="var(--bg-3, var(--bg-4))" />;
  return (
    <>
      {data
        .filter((d) => d.value > 0)
        .map((d) => {
          const frac = d.value / total;
          const start = angle;
          const end = angle + frac * Math.PI * 2;
          angle = end;
          const x1 = cx + r * Math.cos(start);
          const y1 = cy + r * Math.sin(start);
          const x2 = cx + r * Math.cos(end);
          const y2 = cy + r * Math.sin(end);
          const largeArc = end - start > Math.PI ? 1 : 0;
          // A slice covering the entire pie (single non-empty group) draws
          // as a full circle instead of a zero-length arc.
          if (frac >= 0.9999) return <circle key={d.key} cx={cx} cy={cy} r={r} fill={d.color || 'var(--accent)'} />;
          return <path key={d.key} d={`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`} fill={d.color || 'var(--accent)'} />;
        })}
    </>
  );
}

function DbChartView({ state, view, onChangeGroupBy, onChangeChartStyle }) {
  const groupCol = state.columns.find((c) => c.id === view.groupByColumnId && c.type === 'select');
  const valueCol = state.columns.find((c) => c.id === view.valueColumnId) || null;
  const chartStyle = view.chartStyle || 'bar';
  const [hoverKey, setHoverKey] = useState(null);

  const data = useMemo(
    () => (groupCol ? aggregateDbRows(state.rows, groupCol, valueCol, view.aggregateFn || 'count') : []),
    [state.rows, groupCol, valueCol, view.aggregateFn]
  );
  const maxValue = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((a, d) => a + d.value, 0);

  if (!groupCol) {
    return (
      <div className="db-board-empty">
        <p className="muted small">Pick a Select property to group this chart by.</p>
        <DbGroupByPicker columns={state.columns} onPick={onChangeGroupBy} />
      </div>
    );
  }

  return (
    <div className="db-chart">
      <div className="db-chart-style-switch">
        {CHART_STYLES.map((s) => (
          <button
            key={s.type}
            className={`db-chart-style-btn ${chartStyle === s.type ? 'active' : ''}`}
            title={s.label}
            onClick={() => onChangeChartStyle?.(s.type)}
          >
            <s.icon size={14} />
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="db-chart-svg" preserveAspectRatio="xMidYMid meet">
        {chartStyle === 'bar' && <DbChartBars data={data} maxValue={maxValue} />}
        {chartStyle === 'line' && <DbChartLine data={data} maxValue={maxValue} />}
        {chartStyle === 'pie' && <DbChartPie data={data} total={total} />}
      </svg>
      <div className="db-chart-legend">
        {data.map((d) => (
          <div
            key={d.key}
            className={`db-chart-legend-item ${hoverKey && hoverKey !== d.key ? 'dim' : ''}`}
            onMouseEnter={() => setHoverKey(d.key)}
            onMouseLeave={() => setHoverKey(null)}
          >
            <span className="db-chart-legend-swatch" style={{ background: d.color || 'var(--accent)' }} />
            <span className="db-chart-legend-label">{d.label}</span>
            <span className="db-chart-legend-value">{Number.isInteger(d.value) ? d.value : d.value.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { DbChartView, DbAggregatePicker, CHART_STYLES };
