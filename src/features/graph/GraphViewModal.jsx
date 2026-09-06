import { useEffect, useMemo, useRef, useState } from 'react';

import { IconMaximize, IconPlus, IconRefresh, IconSliders, IconTrash, IconX } from '../../components/icons.jsx';
import { DB_OPTION_COLORS } from '../database/dbState.js';
import { loadGraphSettings, saveGraphSettings } from './graphSettings.js';
import { useForceGraph } from './useForceGraph.js';
import { resolveLinkTarget } from '../../lib/linkGraph.js';
import { clamp } from '../../lib/mathUtils.js';


// Full-screen Graph View — a force-directed map of every wikilink in the
// vault, in the spirit of Obsidian's Graph View (see CLAUDE.md's graph-
// revamp entry for what this pass added: Local graph mode with a depth
// slider, adjustable Forces, and color Groups — Obsidian's own three most-
// used panels beyond the base Filters this already had). Deliberately built
// as a self-contained modal (like Help/Palette) rather than a pane-tree tab:
// the pane/tab system is wired tightly around real Drive files (rename,
// save, sync), and a synthetic non-file "tab" would need to fight that
// machinery for little benefit — a modal gets the same "see the whole
// vault, click through to a note" experience with far less risk.
function GraphViewModal({ onClose, linkIndex, linksByFileId, onOpenFile, activeFileId }) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [settings, setSettingsState] = useState(loadGraphSettings);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef({ mode: null });

  const patchSettings = (patch) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveGraphSettings(next);
      return next;
    });
  };
  const { showAttachments, hideOrphans, localMode, localDepth, forces, groups } = settings;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const allNodes = useMemo(
    () => linkIndex.records.filter((r) => showAttachments || !r.isAsset),
    [linkIndex, showAttachments]
  );
  const allEdges = useMemo(() => {
    const nodeIdSet = new Set(allNodes.map((n) => n.id));
    const seen = new Set();
    const out = [];
    for (const [sourceId, links] of linksByFileId.entries()) {
      if (!nodeIdSet.has(sourceId)) continue;
      for (const link of links) {
        const res = resolveLinkTarget(link.target, linkIndex);
        if (res.status !== 'resolved' || res.file.id === sourceId || !nodeIdSet.has(res.file.id)) continue;
        const key = sourceId < res.file.id ? `${sourceId}|${res.file.id}` : `${res.file.id}|${sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([sourceId, res.file.id]);
      }
    }
    return out;
  }, [allNodes, linksByFileId, linkIndex]);

  // Local graph — BFS out from the active note by `localDepth` hops, same
  // shape as Obsidian's "Open local graph" + depth slider. Falls back to
  // showing everything if there's no active file to center on.
  const localIdSet = useMemo(() => {
    if (!localMode || !activeFileId) return null;
    const adj = new Map();
    allEdges.forEach(([a, b]) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b);
      adj.get(b).push(a);
    });
    const visited = new Set([activeFileId]);
    let frontier = [activeFileId];
    for (let d = 0; d < localDepth; d++) {
      const next = [];
      frontier.forEach((id) => {
        (adj.get(id) || []).forEach((n) => {
          if (!visited.has(n)) {
            visited.add(n);
            next.push(n);
          }
        });
      });
      frontier = next;
    }
    return visited;
  }, [localMode, activeFileId, allEdges, localDepth]);

  const nodes = useMemo(
    () => (localIdSet ? allNodes.filter((n) => localIdSet.has(n.id)) : allNodes),
    [allNodes, localIdSet]
  );
  const edges = useMemo(
    () => (localIdSet ? allEdges.filter(([a, b]) => localIdSet.has(a) && localIdSet.has(b)) : allEdges),
    [allEdges, localIdSet]
  );

  const degree = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => map.set(n.id, 0));
    edges.forEach(([a, b]) => {
      map.set(a, (map.get(a) || 0) + 1);
      map.set(b, (map.get(b) || 0) + 1);
    });
    return map;
  }, [nodes, edges]);

  const visibleNodes = useMemo(
    () => (hideOrphans ? nodes.filter((n) => (degree.get(n.id) || 0) > 0) : nodes),
    [nodes, degree, hideOrphans]
  );
  const visibleIdSet = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter(([a, b]) => visibleIdSet.has(a) && visibleIdSet.has(b)),
    [edges, visibleIdSet]
  );
  const nodeIds = useMemo(() => visibleNodes.map((n) => n.id), [visibleNodes]);

  // First matching group (in list order) colors a node — same "first match
  // wins" rule Obsidian's own Groups panel uses.
  const groupColorFor = (n) => {
    const g = groups.find((grp) => grp.query && n.baseName.toLowerCase().includes(grp.query.trim().toLowerCase()));
    return g?.color || null;
  };

  const { pos, pinned, wake } = useForceGraph(nodeIds, visibleEdges, size.width || 800, size.height || 600, forces);

  const neighborSet = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set([hoveredId]);
    visibleEdges.forEach(([a, b]) => {
      if (a === hoveredId) set.add(b);
      if (b === hoveredId) set.add(a);
    });
    return set;
  }, [hoveredId, visibleEdges]);

  const matchSet = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(visibleNodes.filter((n) => n.baseName.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, visibleNodes]);

  const toWorld = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };

  const onNodePointerDown = (e, id) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const p = pos.get(id);
    pinned.add(id);
    wake(0.4);
    dragRef.current = {
      mode: 'node',
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      offsetX: (p?.x ?? w.x) - w.x,
      offsetY: (p?.y ?? w.y) - w.y
    };
  };
  const onBackgroundPointerDown = (e) => {
    dragRef.current = { mode: 'pan', startClientX: e.clientX, startClientY: e.clientY, startViewX: view.x, startViewY: view.y };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.mode) return;
    if (d.mode === 'node') {
      const dx = e.clientX - d.startClientX;
      const dy = e.clientY - d.startClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      const p = pos.get(d.id);
      if (p) {
        p.x = w.x + d.offsetX;
        p.y = w.y + d.offsetY;
      }
      wake(0.3);
    } else if (d.mode === 'pan') {
      setView((v) => ({ ...v, x: d.startViewX + (e.clientX - d.startClientX), y: d.startViewY + (e.clientY - d.startClientY) }));
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (d.mode === 'node') {
      pinned.delete(d.id);
      wake(0.4);
      if (!d.moved) {
        onOpenFile(d.id);
        onClose();
      }
    }
    dragRef.current = { mode: null };
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scaleBy = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const newK = clamp(v.k * scaleBy, 0.15, 4);
      const worldX = (mx - v.x) / v.k;
      const worldY = (my - v.y) / v.k;
      return { x: mx - worldX * newK, y: my - worldY * newK, k: newK };
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="graph-modal-header">
          <h3>Graph view</h3>
          <div className="graph-modal-tools">
            <input className="graph-search" placeholder="Find a note…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className={`icon-btn ${sidebarOpen ? 'active' : ''}`} title="Filters, groups & forces" onClick={() => setSidebarOpen((v) => !v)}>
              <IconSliders size={15} />
            </button>
            <button className="icon-btn" title="Re-run layout" onClick={() => wake(1)}>
              <IconRefresh size={15} />
            </button>
            <button className="icon-btn" title="Reset view" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
              <IconMaximize size={15} />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close graph view">
              <IconX size={16} />
            </button>
          </div>
        </div>
        <div className="graph-modal-body">
          {sidebarOpen && (
            <div className="graph-sidebar">
              <div className="graph-sidebar-section">
                <div className="graph-sidebar-title">Filters</div>
                <label className="graph-toggle">
                  <input type="checkbox" checked={localMode} onChange={(e) => patchSettings({ localMode: e.target.checked })} />
                  Local graph (active note)
                </label>
                {localMode && (
                  <label className="graph-slider-row">
                    <span>Depth: {localDepth}</span>
                    <input
                      type="range"
                      min={1}
                      max={5}
                      step={1}
                      value={localDepth}
                      onChange={(e) => patchSettings({ localDepth: Number(e.target.value) })}
                    />
                  </label>
                )}
                <label className="graph-toggle">
                  <input type="checkbox" checked={showAttachments} onChange={(e) => patchSettings({ showAttachments: e.target.checked })} />
                  Attachments
                </label>
                <label className="graph-toggle">
                  <input type="checkbox" checked={hideOrphans} onChange={(e) => patchSettings({ hideOrphans: e.target.checked })} />
                  Hide orphans
                </label>
              </div>
              <div className="graph-sidebar-section">
                <div className="graph-sidebar-title">Groups</div>
                {groups.map((g) => (
                  <div key={g.id} className="graph-group-row">
                    <span className="graph-group-swatch" style={{ background: g.color }} />
                    <input
                      className="graph-group-input"
                      value={g.query}
                      placeholder="text in note name…"
                      onChange={(e) => patchSettings({ groups: groups.map((x) => (x.id === g.id ? { ...x, query: e.target.value } : x)) })}
                    />
                    <button className="icon-btn" title="Remove group" onClick={() => patchSettings({ groups: groups.filter((x) => x.id !== g.id) })}>
                      <IconTrash size={12} />
                    </button>
                  </div>
                ))}
                <button
                  className="graph-add-group-btn"
                  onClick={() =>
                    patchSettings({
                      groups: [...groups, { id: `grp_${Date.now()}`, query: '', color: DB_OPTION_COLORS[groups.length % DB_OPTION_COLORS.length] }]
                    })
                  }
                >
                  <IconPlus size={12} /> New group
                </button>
              </div>
              <div className="graph-sidebar-section">
                <div className="graph-sidebar-title">Forces</div>
                <label className="graph-slider-row">
                  <span>Repel force</span>
                  <input type="range" min={400} max={6000} step={100} value={forces.repel} onChange={(e) => patchSettings({ forces: { ...forces, repel: Number(e.target.value) } })} />
                </label>
                <label className="graph-slider-row">
                  <span>Link force</span>
                  <input
                    type="range"
                    min={0.002}
                    max={0.08}
                    step={0.002}
                    value={forces.linkStrength}
                    onChange={(e) => patchSettings({ forces: { ...forces, linkStrength: Number(e.target.value) } })}
                  />
                </label>
                <label className="graph-slider-row">
                  <span>Link distance</span>
                  <input
                    type="range"
                    min={20}
                    max={260}
                    step={5}
                    value={forces.linkDistance}
                    onChange={(e) => patchSettings({ forces: { ...forces, linkDistance: Number(e.target.value) } })}
                  />
                </label>
                <label className="graph-slider-row">
                  <span>Center force</span>
                  <input
                    type="range"
                    min={0}
                    max={0.06}
                    step={0.002}
                    value={forces.center}
                    onChange={(e) => patchSettings({ forces: { ...forces, center: Number(e.target.value) } })}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="graph-canvas-wrap" ref={containerRef}>
            <svg
              ref={svgRef}
              className="graph-svg"
              onPointerDown={onBackgroundPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onWheel={onWheel}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {visibleEdges.map(([a, b], i) => {
                  const pa = pos.get(a);
                  const pb = pos.get(b);
                  if (!pa || !pb) return null;
                  const dim = neighborSet && !(neighborSet.has(a) && neighborSet.has(b));
                  return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className={`graph-edge ${dim ? 'dim' : ''}`} />;
                })}
                {visibleNodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const deg = degree.get(n.id) || 0;
                  const r = clamp(4 + Math.sqrt(deg) * 2.4, 4, 15);
                  const dim = (neighborSet && !neighborSet.has(n.id)) || (matchSet && !matchSet.has(n.id));
                  const showLabel =
                    visibleNodes.length <= 60 ||
                    hoveredId === n.id ||
                    (neighborSet && neighborSet.has(n.id)) ||
                    (matchSet && matchSet.has(n.id));
                  const groupColor = groupColorFor(n);
                  return (
                    <g
                      key={n.id}
                      className={`graph-node ${dim ? 'dim' : ''} ${n.id === activeFileId ? 'current' : ''} ${n.isAsset ? 'attachment' : ''}`}
                      style={groupColor ? { '--graph-node-color': groupColor } : undefined}
                      transform={`translate(${p.x},${p.y})`}
                      onPointerDown={(e) => onNodePointerDown(e, n.id)}
                      onPointerEnter={() => setHoveredId(n.id)}
                      onPointerLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                    >
                      <circle r={r} />
                      {showLabel && (
                        <text x={r + 4} y={4} className="graph-node-label">
                          {n.baseName}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        </div>
        <div className="graph-modal-footer">
          {visibleNodes.length} notes · {visibleEdges.length} links{localMode ? ` · local, depth ${localDepth}` : ''}
        </div>
      </div>
    </div>
  );
}

export { GraphViewModal };
