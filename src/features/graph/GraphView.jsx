import { useEffect, useMemo, useRef, useState } from 'react';

import { IconMaximize, IconPlus, IconRefresh, IconSliders, IconTrash } from '../../components/icons.jsx';
import { DB_OPTION_COLORS } from '../database/dbState.js';
import { loadGraphSettings, saveGraphSettings } from './graphSettings.js';
import { useForceGraph } from './useForceGraph.js';
import { resolveLinkTarget } from '../../lib/linkGraph.js';
import { clamp } from '../../lib/mathUtils.js';


// Graph view — a force-directed map of every wikilink in the vault, in the
// spirit of Obsidian's Graph view. A real pane/tab now (see
// graphPaneFile.js and EditorContent.jsx's `file.kind === 'graph'` branch),
// not a modal — it gets split/close/tab-history for free that way, the
// same as any note. See CLAUDE.md's graph-revamp changelog entries for the
// two passes this was built across: slice 1 added Local graph mode,
// Groups, and Forces; this one is the pane conversion plus Tags-as-nodes
// and mobile-specific work (pinch-zoom, a simulation perf cut on touch
// devices — see useForceGraph.js).
function GraphView({ linkIndex, linksByFileId, tagsByFileId, onOpenFile, onOpenTag, activeFileId }) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [settings, setSettingsState] = useState(loadGraphSettings);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef({ mode: null });
  // Active touch points, keyed by pointerId — only used to detect and
  // track a two-finger pinch on top of the existing mouse-oriented
  // pan/drag handlers below (pointer events cover both, but pinch needs
  // its own bookkeeping since it's inherently a two-pointer gesture).
  const pointersRef = useRef(new Map());

  const patchSettings = (patch) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveGraphSettings(next);
      return next;
    });
  };
  const { showAttachments, showTags, hideOrphans, localMode, localDepth, forces, groups } = settings;

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

  const fileNodes = useMemo(
    () => linkIndex.records.filter((r) => showAttachments || !r.isAsset),
    [linkIndex, showAttachments]
  );
  const fileEdges = useMemo(() => {
    const nodeIdSet = new Set(fileNodes.map((n) => n.id));
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
  }, [fileNodes, linksByFileId, linkIndex]);

  // Tags-as-nodes — each tag used by a visible note becomes its own node
  // (id-prefixed `tag:` so it can never collide with a real file id), with
  // an edge to every note that carries it. Obsidian's own "Tags" toggle,
  // same idea.
  const { tagNodes, tagEdges } = useMemo(() => {
    if (!showTags || !tagsByFileId) return { tagNodes: [], tagEdges: [] };
    const fileIdSet = new Set(fileNodes.map((n) => n.id));
    const seen = new Map();
    const edges = [];
    fileNodes.forEach((n) => {
      (tagsByFileId.get(n.id) || []).forEach((tag) => {
        const tagId = `tag:${tag}`;
        if (!seen.has(tagId)) seen.set(tagId, { id: tagId, baseName: `#${tag}`, isTag: true, isAsset: false });
        edges.push([n.id, tagId]);
      });
    });
    return { tagNodes: Array.from(seen.values()), tagEdges: edges.filter(([a]) => fileIdSet.has(a)) };
  }, [showTags, tagsByFileId, fileNodes]);

  const allNodes = useMemo(() => [...fileNodes, ...tagNodes], [fileNodes, tagNodes]);
  const allEdges = useMemo(() => [...fileEdges, ...tagEdges], [fileEdges, tagEdges]);

  // Local graph — BFS out from the active note by `localDepth` hops, same
  // shape as Obsidian's "Open local graph" + depth slider. Falls back to
  // showing everything if there's no active file to center on (e.g. no
  // note has ever been opened yet this session).
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
  // wins" rule Obsidian's own Groups panel uses. Tag nodes aren't matched
  // against groups (groups are for organizing notes by name).
  const groupColorFor = (n) => {
    if (n.isTag) return null;
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

  const onNodePointerDown = (e, n) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const p = pos.get(n.id);
    pinned.add(n.id);
    wake(0.4);
    dragRef.current = {
      mode: 'node',
      id: n.id,
      isTag: !!n.isTag,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      offsetX: (p?.x ?? w.x) - w.x,
      offsetY: (p?.y ?? w.y) - w.y
    };
  };
  const onBackgroundPointerDown = (e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      dragRef.current = {
        mode: 'pinch',
        startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        startK: view.k,
        mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        startViewX: view.x,
        startViewY: view.y
      };
    } else {
      dragRef.current = { mode: 'pan', startClientX: e.clientX, startClientY: e.clientY, startViewX: view.x, startViewY: view.y };
    }
  };
  const onPointerMove = (e) => {
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    } else if (d.mode === 'pinch' && pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const newK = clamp(d.startK * (dist / d.startDist), 0.15, 4);
      const rect = svgRef.current.getBoundingClientRect();
      const mx = d.mid.x - rect.left;
      const my = d.mid.y - rect.top;
      const worldX = (mx - d.startViewX) / d.startK;
      const worldY = (my - d.startViewY) / d.startK;
      setView({ x: mx - worldX * newK, y: my - worldY * newK, k: newK });
    }
  };
  const onPointerUp = (e) => {
    if (e && pointersRef.current.has(e.pointerId)) pointersRef.current.delete(e.pointerId);
    const d = dragRef.current;
    if (d.mode === 'node') {
      pinned.delete(d.id);
      wake(0.4);
      if (!d.moved) {
        if (d.isTag) onOpenTag?.(d.id.slice(4));
        else onOpenFile?.(d.id);
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
    <div className="graph-pane">
      <div className="graph-pane-toolbar">
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
                  <input type="range" min={1} max={5} step={1} value={localDepth} onChange={(e) => patchSettings({ localDepth: Number(e.target.value) })} />
                </label>
              )}
              <label className="graph-toggle">
                <input type="checkbox" checked={showTags} onChange={(e) => patchSettings({ showTags: e.target.checked })} />
                Tags
              </label>
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
                <input type="range" min={0.002} max={0.08} step={0.002} value={forces.linkStrength} onChange={(e) => patchSettings({ forces: { ...forces, linkStrength: Number(e.target.value) } })} />
              </label>
              <label className="graph-slider-row">
                <span>Link distance</span>
                <input type="range" min={20} max={260} step={5} value={forces.linkDistance} onChange={(e) => patchSettings({ forces: { ...forces, linkDistance: Number(e.target.value) } })} />
              </label>
              <label className="graph-slider-row">
                <span>Center force</span>
                <input type="range" min={0} max={0.06} step={0.002} value={forces.center} onChange={(e) => patchSettings({ forces: { ...forces, center: Number(e.target.value) } })} />
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
                    className={`graph-node ${dim ? 'dim' : ''} ${n.id === activeFileId ? 'current' : ''} ${n.isAsset ? 'attachment' : ''} ${n.isTag ? 'tag' : ''}`}
                    style={groupColor ? { '--graph-node-color': groupColor } : undefined}
                    transform={`translate(${p.x},${p.y})`}
                    onPointerDown={(e) => onNodePointerDown(e, n)}
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
      <div className="graph-pane-footer">
        {visibleNodes.length} nodes · {visibleEdges.length} links{localMode ? ` · local, depth ${localDepth}` : ''}
      </div>
    </div>
  );
}

export { GraphView };
