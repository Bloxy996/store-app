// ---------------------------------------------------------------------------
// The Graph view is a pane/tab like any note (see CLAUDE.md's graph-revamp
// changelog for why: consistent split/close/history behavior instead of a
// bolted-on modal), but it has no backing Drive file. Every place that
// looks a tab's `fileId` up — `filesById.get(...)`, `TabBar`, `Breadcrumb`,
// `EditorContent`'s `file.kind` switch — just needs *some* object with an
// `id`/`kind`/`name`, so App.jsx injects this one singleton entry into its
// `filesById` map. It's never in `sync.filesMeta`, so `ensureFileLoaded`'s
// existing `sync.filesMeta.find(...)` guard already no-ops for it — no
// Drive fetch, no save-buffer, no search-index entry, without needing to
// special-case any of those systems for a fake id.
// ---------------------------------------------------------------------------
const GRAPH_PANE_FILE_ID = '__graph__';
const GRAPH_PANE_FILE = { id: GRAPH_PANE_FILE_ID, kind: 'graph', name: 'Graph view', baseName: 'Graph view' };

export { GRAPH_PANE_FILE_ID, GRAPH_PANE_FILE };
