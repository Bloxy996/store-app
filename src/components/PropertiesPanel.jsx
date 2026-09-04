import { splitListValue } from '../lib/markdownParse.js';


// The frontmatter block, rendered as a small key/value "Properties" panel —
// a lighter-weight stand-in for Obsidian's Properties editor UI.
function PropertiesPanel({ properties, handlers }) {
  if (!properties.length) return null;
  return (
    <div className="properties-panel">
      {properties.map((p) => {
        const isTagProp = /^tags?$/i.test(p.key);
        return (
          <div className="properties-row" key={p.key}>
            <span className="properties-key">{p.key}</span>
            <span className="properties-value">
              {isTagProp ? (
                splitListValue(p.value).map((t) => (
                  <span
                    key={t}
                    className="tag-chip"
                    onClick={() => handlers.onOpenTag && handlers.onOpenTag(t.replace(/^#/, ''))}
                  >
                    #{t.replace(/^#/, '')}
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
