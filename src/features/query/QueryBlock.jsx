import React, { useEffect, useMemo } from 'react';

import { resolveLinkTarget } from '../../lib/linkGraph.js';
import { getFieldValue, runVaultQuery } from '../../lib/queryEngine.js';


// Renders one resolved field value — links become clickable (and reuse the
// same "missing → dashed, click to create" affordance as inline [[links]]
// elsewhere), arrays join with commas, dates show their original text.
function QueryValue({ value, linkIndex, onOpenById, onCreateOrOpenByName }) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((v, i) => (
          <React.Fragment key={i}>
            {i > 0 && ', '}
            <QueryValue value={v} linkIndex={linkIndex} onOpenById={onOpenById} onCreateOrOpenByName={onCreateOrOpenByName} />
          </React.Fragment>
        ))}
      </>
    );
  }
  if (typeof value === 'object' && value.type === 'link') {
    const res = resolveLinkTarget(value.target, linkIndex);
    if (res.status === 'resolved') {
      return (
        <span className="wikilink" onClick={() => onOpenById?.(res.file.id)} title={`Open ${res.file.baseName}`}>
          {value.display}
        </span>
      );
    }
    return (
      <span
        className="wikilink wikilink-new"
        onClick={() => onCreateOrOpenByName?.(value.target)}
        title={`Create "${value.target}"`}
      >
        {value.display}
      </span>
    );
  }
  if (typeof value === 'object' && value.type === 'date') return <>{value.raw}</>;
  if (typeof value === 'boolean') return <>{value ? 'true' : 'false'}</>;
  return <>{String(value)}</>;
}


// A rendered ```query / ```dataview block. `handlers.pagesIndex` is built
// once at the app root (see the `pagesIndex` useMemo near the top-level
// `handlers` object) and only needs a background full-vault index — the
// same one Search/Tags already trigger — so a query works even the very
// first time it's added to a note, not just after every note happens to
// have already been opened once.
function QueryBlock({ raw, handlers, linkIndex }) {
  const ensureVaultIndexed = handlers?.ensureVaultIndexed;
  useEffect(() => {
    ensureVaultIndexed?.();
  }, [ensureVaultIndexed]);

  const pagesIndex = handlers?.pagesIndex;
  const result = useMemo(() => (pagesIndex ? runVaultQuery(raw, pagesIndex) : null), [raw, pagesIndex]);

  if (!pagesIndex || !handlers?.vaultIndexReady) {
    const progress = handlers?.vaultIndexProgress;
    return (
      <div className="query-block query-block-loading muted">
        Indexing store for queries{progress?.total ? ` — ${progress.loaded}/${progress.total}` : '…'}
      </div>
    );
  }
  if (result.error) {
    return <div className="query-block query-block-error">Query error: {result.error}</div>;
  }
  const { query, rows } = result;
  if (!rows.length) {
    return <div className="query-block query-block-empty muted">No results.</div>;
  }

  if (query.type === 'TABLE') {
    const cols = query.columns.length ? query.columns : [{ field: 'file.name', label: 'File' }];
    return (
      <table className="md-table query-table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((page) => (
            <tr key={page.file.id}>
              {cols.map((c, i) => (
                <td key={i}>
                  <QueryValue
                    value={getFieldValue(page, c.field)}
                    linkIndex={linkIndex}
                    onOpenById={handlers?.onOpenById}
                    onCreateOrOpenByName={handlers?.onCreateOrOpenByName}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (query.type === 'TASK') {
    const taskLineRe = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
    const groups = rows
      .map((page) => {
        const body = handlers?.getBody ? handlers.getBody(page.file.id) : '';
        const tasks = (body || '')
          .split('\n')
          .map((l) => l.match(taskLineRe))
          .filter(Boolean)
          .map((m) => ({ checked: /[xX]/.test(m[1]), text: m[2] }));
        return { page, tasks };
      })
      .filter((g) => g.tasks.length);
    if (!groups.length) return <div className="query-block query-block-empty muted">No results.</div>;
    return (
      <div className="query-tasklist">
        {groups.map(({ page, tasks }) => (
          <div key={page.file.id} className="query-task-group">
            <div className="query-task-source">
              <QueryValue value={page.file.link} linkIndex={linkIndex} onOpenById={handlers?.onOpenById} />
            </div>
            {tasks.map((t, i) => (
              <div className="task-line" key={i}>
                <input type="checkbox" checked={t.checked} readOnly />
                <span className={t.checked ? 'task-done' : ''}>{t.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <ul className="query-list">
      {rows.map((page) => (
        <li key={page.file.id}>
          <QueryValue value={page.file.link} linkIndex={linkIndex} onOpenById={handlers?.onOpenById} />
        </li>
      ))}
    </ul>
  );
}

export { QueryValue, QueryBlock };
