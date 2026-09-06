import { useState } from 'react';

import { IconTrash, IconX } from '../../components/icons.jsx';
import { DEFAULT_SCHEMA, parseChildrenByValue, serializeChildrenByValue } from '../../lib/frontmatterSchema.js';

// ---------------------------------------------------------------------------
// Settings -> Frontmatter properties. Lets a property's value options and
// value -> child-property map (the GUIDE.md-style "picking `type: game`
// adds `aliases`" behavior) be edited without touching JSON directly. Each
// property is one row; the child-property map is edited as compact text
// ("value: key=insert, key2=insert2" per line) rather than a nested form,
// which is the whole point of lib/frontmatterSchema.js's
// serialize/parseChildrenByValue helpers — see that file for the format.
// ---------------------------------------------------------------------------
function PropertyRow({ prop, onChange, onDelete }) {
  const [childrenText, setChildrenText] = useState(() => serializeChildrenByValue(prop.childrenByValue));
  return (
    <div className="fm-schema-row">
      <div className="fm-schema-row-head">
        <input
          className="fm-schema-key"
          value={prop.key}
          placeholder="property name"
          onChange={(e) => onChange({ ...prop, key: e.target.value.trim() })}
        />
        <button className="icon-btn" title="Delete property" onClick={onDelete}>
          <IconTrash size={14} />
        </button>
      </div>
      <label className="fm-schema-field">
        Autocomplete values (comma-separated)
        <input
          value={(prop.valueOptions || []).join(', ')}
          placeholder="e.g. info, entity, event"
          onChange={(e) =>
            onChange({
              ...prop,
              valueOptions: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean)
            })
          }
        />
      </label>
      <label className="fm-schema-field">
        Add properties when value is… (one per line: <code>value: key=default, key2=default2</code>)
        <textarea
          rows={Math.max(2, childrenText.split('\n').length)}
          value={childrenText}
          onChange={(e) => {
            setChildrenText(e.target.value);
            onChange({ ...prop, childrenByValue: parseChildrenByValue(e.target.value) });
          }}
        />
      </label>
    </div>
  );
}

function FrontmatterSchemaSettings({ schema, onChange, onClose }) {
  const properties = schema.properties || [];

  const updateAt = (i, next) => {
    const nextProps = properties.slice();
    nextProps[i] = next;
    onChange({ ...schema, properties: nextProps });
  };
  const removeAt = (i) => {
    onChange({ ...schema, properties: properties.filter((_, idx) => idx !== i) });
  };
  const addProperty = () => {
    onChange({ ...schema, properties: [...properties, { key: '', valueOptions: [] }] });
  };
  const resetToDefault = () => {
    onChange(JSON.parse(JSON.stringify(DEFAULT_SCHEMA)));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal fm-schema-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fm-schema-header">
          <h3>Frontmatter properties</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <p className="muted fm-schema-intro">
          These properties show as autocomplete suggestions when your cursor is inside a note's frontmatter. Give a
          property a list of values to autocomplete them too, and optionally have picking one of those values add
          more properties automatically.
        </p>
        <div className="fm-schema-list">
          {properties.map((p, i) => (
            <PropertyRow key={i} prop={p} onChange={(next) => updateAt(i, next)} onDelete={() => removeAt(i)} />
          ))}
        </div>
        <div className="fm-schema-footer">
          <button className="btn-secondary" onClick={addProperty}>
            + Add property
          </button>
          <button className="btn-secondary" onClick={resetToDefault}>
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}

export { FrontmatterSchemaSettings };
