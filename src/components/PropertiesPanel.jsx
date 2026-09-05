import { splitListValue } from '../lib/markdownParse.js';
import { resolveLinkTarget } from '../lib/linkGraph.js';


// A frontmatter value can itself contain one or more `[[Wikilinks]]` (e.g.
// `related: [[Other Note]]` or `related: [[A]], [[B]]`) — same linking
// convention as the note body, so a property value is split on the
// existing list convention and each piece that looks like a wikilink is
// resolved and rendered clickable instead of as inert text. This is what
// makes note-to-note links actually work from frontmatter, not just the
// note body.
function PropertyValuePiece({ raw, handlers, linkIndex }) {
  const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(\|([^\]]+))?\]\]$/.exec(raw.trim());
  if (!m) return <span>{raw}</span>;
  const target = m[1].trim();
  const label = (m[3] || target).trim();
  const resolution = resolveLinkTarget(target, linkIndex);
  if (resolution.status === 'resolved') {
    return (
      <span className="wikilink" onClick={() => handlers.onOpenById(resolution.file.id)} title={`Open ${resolution.file.baseName}`}>
        {label}
      </span>
    );
  }
  return (
    <span className="wikilink wikilink-new" onClick={() => handlers.onCreateOrOpenByName?.(target)} title={`Create "${target}"`}>
      {label}
    </span>
  );
}


// The frontmatter block, rendered as a small key/value "Properties" panel —
// a lighter-weight stand-in for Obsidian's Properties editor UI.
function PropertiesPanel({ properties, handlers, linkIndex }) {
  if (!properties.length) return null;
  return (
    <div className="properties-panel">
      {properties.map((p) => {
        const isTagProp = /^tags?$/i.test(p.key);
        const items = splitListValue(p.value);
        const hasLinks = !isTagProp && linkIndex && items.some((v) => /^\[\[.+\]\]$/.test(v.trim()));
        return (
          <div className="properties-row" key={p.key}>
            <span className="properties-key">{p.key}</span>
            <span className="properties-value">
              {isTagProp ? (
                items.map((t) => (
                  <span key={t} className="tag-chip" onClick={() => handlers.onOpenTag && handlers.onOpenTag(t.replace(/^#/, ''))}>
                    #{t.replace(/^#/, '')}
                  </span>
                ))
              ) : hasLinks ? (
                items.map((v, i) => (
                  <span key={i} className="properties-value-piece">
                    {i > 0 && ', '}
                    <PropertyValuePiece raw={v} handlers={handlers} linkIndex={linkIndex} />
                  </span>
                ))
              ) : (
                <span>{p.value}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export { PropertiesPanel };
