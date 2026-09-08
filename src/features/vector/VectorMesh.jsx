import React from 'react';
import { sortEdgesForRender, buildAdjacency } from './vectorState.js';
import { tessellateStroke } from './vectorGeometry.js';
import { resolveFill } from './vectorFill.js';
const pts=(p=[])=>p.filter((x) => Number.isFinite(x?.x) && Number.isFinite(x?.y)).map(x=>`${x.x},${x.y}`).join(' ');
function VectorMesh({ state, nodes, selectedEdges, marquee, guides }) { const edges=sortEdgesForRender(state.edges), polygons=tessellateStroke(nodes,edges,buildAdjacency(nodes,edges)); return <><g className="vector-fills">{state.fills.map(f=>{const poly=resolveFill(f,nodes,edges);return poly&&<polygon key={f.id} points={pts(poly)} fill={f.color}/>;})}</g><g>{edges.map(e=>polygons.has(e.id) && <polygon key={e.id} points={pts(polygons.get(e.id))} fill={e.color} className={selectedEdges.has(e.id)?'selected':''}/>)}</g><g>{nodes.map(n=><circle key={n.id} cx={n.x} cy={n.y} r="5" className="vector-node"/>)}</g>{marquee&&<rect className="vector-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height}/>}<g className="vector-guides">{guides?.x.map(x=><line key={`x${x}`} x1={x} y1="-10000" x2={x} y2="10000"/>)}{guides?.y.map(y=><line key={`y${y}`} x1="-10000" y1={y} x2="10000" y2={y}/>)}</g></>; }
export { VectorMesh };
