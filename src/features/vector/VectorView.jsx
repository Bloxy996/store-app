import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from '../../lib/mathUtils.js';
import { uid } from '../../lib/paneTree.js';
import { addEdge, createGroup, parseVectorContent, serializeVectorState, subdivideEdge, buildAdjacency } from './vectorState.js';
import { alignmentCandidates, axisSnap, hitTestEdge, nearestEdgePoint, nearestNode } from './vectorGeometry.js';
import { resolveFill } from './vectorFill.js';
import { VectorToolbar } from './VectorToolbar.jsx';
import { VectorMesh } from './VectorMesh.jsx';
import './vector.css';
const snapRadius=12;
function VectorView({ file, content, onChange, handlers, loading }) {
 const [state,setState]=useState(()=>parseVectorContent(content)); const [viewport,setViewport]=useState({x:0,y:0,zoom:1}); const [tool,setTool]=useState('select'); const [style,setStyle]=useState({thickness:3,color:'#5b8cff'}); const [selected,setSelected]=useState(()=>new Set()); const [live,setLive]=useState(null); const [marquee,setMarquee]=useState(null); const ref=useRef(null),drag=useRef(null),loadedOnceRef=useRef(!loading),rafRef=useRef(null),pending=useRef(null);
 // The buffer starts empty while Drive is fetching content. Re-sync exactly
 // once when it arrives, then local state remains authoritative like CanvasView.
 useEffect(()=>{if(!loading&&!loadedOnceRef.current){loadedOnceRef.current=true;setState(parseVectorContent(content));}},[loading]);
 useEffect(()=>()=>rafRef.current&&cancelAnimationFrame(rafRef.current),[]);
 const commit=useCallback((updater)=>setState(prev=>{const next=typeof updater==='function'?updater(prev):updater;onChange(serializeVectorState(next));return next;}),[onChange]);
 const nodes=useMemo(()=>live?state.nodes.map(n=>live[n.id]?{...n,...live[n.id]}:n):state.nodes,[state.nodes,live]);
 const world=useCallback((e)=>{const r=ref.current.getBoundingClientRect();return{x:(e.clientX-r.left-viewport.x)/viewport.zoom,y:(e.clientY-r.top-viewport.y)/viewport.zoom};},[viewport]);
 const schedule=useCallback((v)=>{pending.current=v;if(!rafRef.current)rafRef.current=requestAnimationFrame(()=>{rafRef.current=null;setLive(pending.current);});},[]);
 const snap=useCallback((p, except)=>{const n=nearestNode(nodes,p,snapRadius/viewport.zoom);if(n)return{point:n.node,id:n.node.id};const e=nearestEdgePoint(state.edges,nodes,p,snapRadius/viewport.zoom,except);return e?{point:e.point,boundTo:{edgeId:e.edge.id,t:e.t}}:{point:p};},[nodes,state.edges,viewport.zoom]);
 const addPoint=(s,p)=>{const node={id:uid('vector-node'),x:p.x,y:p.y,boundTo:s.boundTo||null};return { ...s,nodes:[...s.nodes,node]};};
 const down=(e)=>{ref.current.setPointerCapture(e.pointerId);const p=world(e);if(tool==='segment'){drag.current={type:'segment',start:snap(p)};return;}if(tool==='subdivide'){const edge=hitTestEdge(state.edges,nodes,buildAdjacency(nodes,state.edges),p);if(edge)commit(s=>subdivideEdge(s,edge.id,p));return;}if(tool==='fill'){if(resolveFill({seedX:p.x,seedY:p.y},nodes,state.edges))commit(s=>({...s,fills:[...s.fills,{id:uid('vector-fill'),seedX:p.x,seedY:p.y,color:style.color}]}));return;}if(tool==='eyedropper'){const edge=hitTestEdge(state.edges,nodes,buildAdjacency(nodes,state.edges),p);if(edge)setStyle({thickness:edge.thickness,color:edge.color});return;}const n=nearestNode(nodes,p,snapRadius/viewport.zoom);if(n){drag.current={type:'node',id:n.node.id,start:p};setSelected(new Set([n.node.id]));}else {drag.current={type:'marquee',start:p};setMarquee({x:p.x,y:p.y,width:0,height:0});}};
 const move=(e)=>{if(!drag.current)return;const p=world(e);if(drag.current.type==='node'){schedule({[drag.current.id]:axisSnap(drag.current.start,p,e.shiftKey)});}else if(drag.current.type==='marquee'){const a=drag.current.start;setMarquee({x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),width:Math.abs(p.x-a.x),height:Math.abs(p.y-a.y)});}};
 const up=(e)=>{const d=drag.current;if(!d)return;const p=world(e);drag.current=null;if(d.type==='segment'){const end=snap(axisSnap(d.start.point,p,e.shiftKey));if(Math.hypot(end.point.x-d.start.point.x,end.point.y-d.start.point.y)>1)commit(s=>{let next=s,a=d.start.id,b=end.id;if(!a){next=addPoint(next,d.start);a=next.nodes.at(-1).id;}if(!b){next=addPoint(next,end);b=next.nodes.at(-1).id;}return addEdge(next,a,b,style).state;});}if(d.type==='node'&&live){commit(s=>({...s,nodes:s.nodes.map(n=>live[n.id]?{...n,...live[n.id]}:n)}));setLive(null);}if(d.type==='marquee'){const m=marquee;setSelected(new Set(nodes.filter(n=>n.x>=m.x&&n.x<=m.x+m.width&&n.y>=m.y&&n.y<=m.y+m.height).map(n=>n.id)));setMarquee(null);}};
 useEffect(()=>{const el=ref.current;if(!el)return;const wheel=e=>{e.preventDefault();if(e.ctrlKey||e.metaKey)setViewport(v=>({...v,zoom:clamp(v.zoom*Math.exp(-e.deltaY*.012),.1,3)}));else setViewport(v=>({...v,x:v.x-e.deltaX,y:v.y-e.deltaY}));};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[]);
 const groups=()=>{const edgeIds=state.edges.filter(e=>selected.has(e.a)||selected.has(e.b)).map(e=>e.id);if(edgeIds.length)commit(s=>createGroup(s,edgeIds));};
 return <div className="vector-view"><div className="vector-meta"><input value={state.title} onChange={e=>commit(s=>({...s,title:e.target.value}))} placeholder={file.name.replace(/\.vec$/i,'')}/><input value={state.description} onChange={e=>commit(s=>({...s,description:e.target.value}))} placeholder="Description"/></div><VectorToolbar tool={tool} onTool={setTool} style={style} onStyle={setStyle} onGroup={groups} onUngroup={()=>{}} onDelete={()=>{}}/><div ref={ref} className="vector-surface" tabIndex="0" onPointerDown={down} onPointerMove={move} onPointerUp={up}><svg><g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}><VectorMesh state={state} nodes={nodes} selectedEdges={selected} marquee={marquee} guides={null}/></g></svg></div></div>;
}
export { VectorView };
