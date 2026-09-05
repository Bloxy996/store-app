import React, { useMemo } from 'react';

import { ImageEmbed } from '../../components/LinkEmbeds.jsx';
import { IconFile, IconLink2 } from '../../components/icons.jsx';
import { MiniMarkdownEditor } from '../../components/MiniMarkdownEditor.jsx';
import { AudioEmbed, VideoEmbed } from '../assets/AssetPane.jsx';
import { canvasEdgePath, canvasOppositeSide, canvasSideAnchor } from './canvasState.js';
import { parseFrontmatter } from '../../lib/markdownParse.js';
import { renderMarkdownBlocks } from '../../lib/markdownRender.jsx';


// Live content for a `file`-type node — dispatches on the embedded file's
// kind, reusing the exact same on-demand-fetch components notes already use
// for inline embeds (ImageEmbed / VideoEmbed / AudioEmbed), so a canvas
// never duplicates that fetch/caching logic.
function CanvasFileNodeContent({ node, allFilesById, handlers, linkIndex }) {
  const meta = allFilesById.get(node.file);
  if (!meta) return <div className="canvas-embed-missing muted small">Missing or deleted file</div>;
  if (meta.kind === 'image') {
    return (
      <div className="canvas-embed canvas-embed-image">
        <ImageEmbed token={handlers.token} fileId={meta.id} name={meta.name} onOpen={() => handlers.onOpenById(meta.id)} />
      </div>
    );
  }
  if (meta.kind === 'video') {
    return (
      <div className="canvas-embed canvas-embed-media">
        <VideoEmbed token={handlers.token} fileId={meta.id} name={meta.name} />
      </div>
    );
  }
  if (meta.kind === 'audio') {
    return (
      <div className="canvas-embed canvas-embed-media">
        <AudioEmbed token={handlers.token} fileId={meta.id} name={meta.name} />
      </div>
    );
  }
  if (meta.kind === 'note') {
    const body = handlers.getBody ? handlers.getBody(meta.id) : '';
    const parsed = parseFrontmatter(body || '');
    return (
      <div className="canvas-embed canvas-embed-note">
        <div className="canvas-embed-title">{meta.name.replace(/\.[^.]+$/i, '')}</div>
        <div className="canvas-embed-note-body">
          {parsed.body ? renderMarkdownBlocks(parsed.body, handlers, linkIndex, node.id) : <span className="muted small">Empty note</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="canvas-embed canvas-embed-file" onDoubleClick={() => handlers.onOpenAsset?.(meta)}>
      <IconFile size={26} />
      <span className="muted small">{meta.name}</span>
    </div>
  );
}


function CanvasEdgesLayer({ nodes, edges, selectedEdgeId, connecting, onSelectEdge, onDoubleClickEdge }) {
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  return (
    <svg className="canvas-edges-svg">
      <defs>
        <marker id="canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="canvas-arrowhead" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = nodesById.get(e.fromNode);
        const to = nodesById.get(e.toNode);
        if (!from || !to) return null;
        const fromSide = e.fromSide || 'right';
        const toSide = e.toSide || 'left';
        const fromPt = canvasSideAnchor(from, fromSide);
        const toPt = canvasSideAnchor(to, toSide);
        const d = canvasEdgePath(fromPt, fromSide, toPt, toSide);
        return (
          <g key={e.id} className="canvas-edge-group">
            <path
              d={d}
              className="canvas-edge-hit"
              onClick={(ev) => {
                ev.stopPropagation();
                onSelectEdge(e.id);
              }}
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                onDoubleClickEdge(e.id);
              }}
            />
            <path
              d={d}
              className={`canvas-edge ${selectedEdgeId === e.id ? 'selected' : ''}`}
              style={e.color ? { stroke: e.color } : undefined}
              markerEnd="url(#canvas-arrow)"
            />
            {e.label && (
              <text x={(fromPt.x + toPt.x) / 2} y={(fromPt.y + toPt.y) / 2 - 6} textAnchor="middle" className="canvas-edge-label">
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {connecting && (
        <path
          d={canvasEdgePath(connecting.fromPt, connecting.fromSide, connecting.toPt, canvasOppositeSide(connecting.fromSide))}
          className="canvas-edge canvas-edge-preview"
        />
      )}
    </svg>
  );
}


// Memoized: CanvasView re-renders on every pan/zoom/hover-state change, but
// individual card props are usually unchanged, so most nodes should bail
// out of re-rendering rather than re-diff their (sometimes note-preview-
// rendering) contents on every frame of an unrelated node's drag.
const CanvasNode = React.memo(function CanvasNode({
  node,
  selected,
  hovered,
  editing,
  connectTarget,
  connectHighlight,
  allFilesById,
  handlers,
  linkIndex,
  onPointerDownBody,
  onPointerDownResize,
  onPointerDownDot,
  onDoubleClick,
  onHoverChange,
  onCommitEdit
}) {
  const isGroup = node.type === 'group';
  // Outer wrapper is position/size ONLY (overflow: visible) — the border,
  // background, shadow and rounded-corner clipping live one level down on
  // `.canvas-node-inner`. Dots and the resize handle are siblings of that
  // inner box, not children of it, specifically so the inner box's
  // `overflow: hidden` (needed to clip note/image content to the rounded
  // corners) never also clips the half-outside-the-edge dots/handle.
  const style = { left: node.x, top: node.y, width: node.width, height: node.height };
  const innerStyle = node.color ? { borderColor: node.color } : undefined;
  const showDots = !isGroup && (selected || hovered || connectHighlight) && !editing;
  return (
    <div
      className={`canvas-node canvas-node-${node.type} ${isGroup ? 'canvas-group' : ''} ${selected ? 'selected' : ''} ${connectTarget ? 'connect-target' : ''}`}
      style={style}
      onPointerEnter={() => onHoverChange(node.id)}
      onPointerLeave={() => onHoverChange(null)}
      onDoubleClick={(e) => onDoubleClick(e, node)}
    >
      {isGroup ? (
        <>
          <div className="canvas-node-inner" style={innerStyle} />
          <div className="canvas-group-label" style={node.color ? { color: node.color } : undefined} onPointerDown={(e) => onPointerDownBody(e, node)}>
            {node.label || 'Group'}
          </div>
        </>
      ) : (
        <div className="canvas-node-inner" style={innerStyle}>
          <div className="canvas-node-body" onPointerDown={(e) => onPointerDownBody(e, node)}>
            {node.type === 'text' &&
              (editing ? (
                <MiniMarkdownEditor
                  className="canvas-text-editor"
                  value={node.text || ''}
                  placeholderText="Type markdown…"
                  linkIndex={linkIndex}
                  allTags={handlers.allTags}
                  onCommit={(text) => onCommitEdit(node.id, text)}
                />
              ) : (
                <div className="canvas-text-render">
                  {node.text ? renderMarkdownBlocks(node.text, handlers, linkIndex, node.id) : <span className="muted small">Double-click to edit</span>}
                </div>
              ))}
            {node.type === 'file' && <CanvasFileNodeContent node={node} allFilesById={allFilesById} handlers={handlers} linkIndex={linkIndex} />}
            {node.type === 'link' && (
              <a className="canvas-link-card" href={node.url} target="_blank" rel="noreferrer" draggable={false}>
                <IconLink2 size={14} />
                <span>{node.url}</span>
              </a>
            )}
          </div>
        </div>
      )}
      {showDots && (
        <>
          <span className="canvas-dot canvas-dot-top" onPointerDown={(e) => onPointerDownDot(e, node, 'top')} />
          <span className="canvas-dot canvas-dot-right" onPointerDown={(e) => onPointerDownDot(e, node, 'right')} />
          <span className="canvas-dot canvas-dot-bottom" onPointerDown={(e) => onPointerDownDot(e, node, 'bottom')} />
          <span className="canvas-dot canvas-dot-left" onPointerDown={(e) => onPointerDownDot(e, node, 'left')} />
        </>
      )}
      {selected && <span className="canvas-resize-handle" onPointerDown={(e) => onPointerDownResize(e, node)} />}
    </div>
  );
});

export { CanvasFileNodeContent, CanvasEdgesLayer, CanvasNode };
