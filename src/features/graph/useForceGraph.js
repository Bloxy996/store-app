import { useCallback, useEffect, useRef, useState } from 'react';


// Lightweight force-directed layout for Graph View — no external physics or
// graph library is pulled in; nodes repel each other, linked pairs attract
// along a spring, and everything is nudged gently toward the center so the
// graph doesn't drift off-canvas. It's a damped simulation (alpha decays
// every tick, same idea as d3-force) so it settles and stops burning CPU on
// its own a couple of seconds after opening, rather than running forever.
// Positions/velocities/pinned-state live in a ref (not React state) since
// they update every animation frame; `bump` below is the only piece of
// this that touches React state, purely to trigger a re-render per tick.
function useForceGraph(nodeIds, edgeList, width, height) {
  const stateRef = useRef({ pos: new Map(), vel: new Map(), pinned: new Set() });
  const alphaRef = useRef(1);
  const rafRef = useRef(null);
  const stepRef = useRef(null);
  const [, bump] = useState(0);

  // Seed any node that doesn't have a position yet in a ring around the
  // center (so new nodes don't all stack at the origin and fling apart on
  // the first tick), and drop stale entries for nodes that no longer exist.
  useEffect(() => {
    const { pos, vel, pinned } = stateRef.current;
    const idSet = new Set(nodeIds);
    nodeIds.forEach((id, i) => {
      if (!pos.has(id)) {
        const angle = (i / Math.max(1, nodeIds.length)) * Math.PI * 2;
        const r = Math.min(width, height) * 0.32;
        pos.set(id, { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r });
        vel.set(id, { x: 0, y: 0 });
      }
    });
    Array.from(pos.keys()).forEach((id) => {
      if (!idSet.has(id)) {
        pos.delete(id);
        vel.delete(id);
        pinned.delete(id);
      }
    });
    alphaRef.current = 1;
  }, [nodeIds, width, height]);

  useEffect(() => {
    let cancelled = false;
    const { pos, vel, pinned } = stateRef.current;
    const REPULSION = 2400;
    const SPRING = 0.02;
    const SPRING_LEN = 95;
    const CENTER_PULL = 0.012;
    const DAMPING = 0.8;

    function step() {
      if (cancelled) return;
      if (alphaRef.current > 0.008) {
        const alpha = alphaRef.current;
        // Pairwise repulsion — O(n²), fine at the node counts a single
        // vault's graph realistically reaches; spatial partitioning would
        // be the next lever if that stops being true for very large vaults.
        for (let i = 0; i < nodeIds.length; i++) {
          const a = pos.get(nodeIds[i]);
          if (!a) continue;
          for (let j = i + 1; j < nodeIds.length; j++) {
            const b = pos.get(nodeIds[j]);
            if (!b) continue;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            const distSq = Math.max(dx * dx + dy * dy, 25);
            const dist = Math.sqrt(distSq);
            const force = (REPULSION * alpha) / distSq;
            dx /= dist;
            dy /= dist;
            const va = vel.get(nodeIds[i]);
            const vb = vel.get(nodeIds[j]);
            va.x += dx * force;
            va.y += dy * force;
            vb.x -= dx * force;
            vb.y -= dy * force;
          }
        }
        edgeList.forEach(([s, t]) => {
          const a = pos.get(s);
          const b = pos.get(t);
          if (!a || !b) return;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const force = (dist - SPRING_LEN) * SPRING * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          const va = vel.get(s);
          const vb = vel.get(t);
          va.x += fx;
          va.y += fy;
          vb.x -= fx;
          vb.y -= fy;
        });
        nodeIds.forEach((id) => {
          const p = pos.get(id);
          const v = vel.get(id);
          if (!p || !v) return;
          v.x += (width / 2 - p.x) * CENTER_PULL * alpha;
          v.y += (height / 2 - p.y) * CENTER_PULL * alpha;
        });
        nodeIds.forEach((id) => {
          const p = pos.get(id);
          const v = vel.get(id);
          if (!p || !v) return;
          if (pinned.has(id)) {
            v.x = 0;
            v.y = 0;
          } else {
            v.x *= DAMPING;
            v.y *= DAMPING;
            p.x += v.x;
            p.y += v.y;
          }
        });
        alphaRef.current *= 0.985;
        bump((n) => n + 1);
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    }
    stepRef.current = step;
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      stepRef.current = null;
    };
  }, [nodeIds, edgeList, width, height]);

  // Raises the simulation's temperature and (re)starts the animation loop
  // if it had already settled — called on drag, filter changes, and the
  // manual "re-run layout" button.
  const wake = useCallback((amount = 0.3) => {
    alphaRef.current = Math.max(alphaRef.current, amount);
    if (!rafRef.current && stepRef.current) rafRef.current = requestAnimationFrame(stepRef.current);
  }, []);

  return { pos: stateRef.current.pos, pinned: stateRef.current.pinned, wake };
}

export { useForceGraph };
