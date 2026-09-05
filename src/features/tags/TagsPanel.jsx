import React, { useEffect, useMemo } from 'react';

import { IconLoader, IconTag } from '../../components/icons.jsx';
import { buildTagIndex, buildTagTree } from '../../hooks/useVaultIndex.js';


// ---------------------------------------------------------------------------
// Tags panel — every tag in the vault with a note count, clicking opens it
// as a search query.
// ---------------------------------------------------------------------------
const TagsPanel = React.memo(function TagsPanel({ filesMeta, getBody, onOpenTag, indexing, ensureIndexed, indexVersion }) {
  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tags = useMemo(() => buildTagIndex(filesMeta, getBody), [filesMeta, getBody, indexVersion]);
  const tagTree = useMemo(() => buildTagTree(tags), [tags]);

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Tags</span>
        <span className="side-panel-count">{tags.length}</span>
      </div>
      {indexing.building && (
        <div className="indexing-banner">
          <IconLoader size={13} />
          Indexing store… {indexing.progress.loaded}/{indexing.progress.total}
        </div>
      )}
      <div className="side-panel-body tag-list">
        {tagTree.length === 0 && (
          <p className="muted small empty-hint">No tags yet. Use #tag (or #parent/child for nested tags) anywhere in a note.</p>
        )}
        {tagTree.map(({ path, name, depth, count }) => (
          <button
            key={path}
            className="tag-row"
            style={{ paddingLeft: 10 + depth * 16 }}
            title={path}
            onClick={() => onOpenTag(path)}
          >
            <IconTag size={13} className="tag-row-icon" />
            <span className="tag-row-name">{name}</span>
            <span className="tag-row-count">{count}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

export { TagsPanel };
