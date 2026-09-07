import { IconAlignLeft, IconAudio, IconCalendar, IconCheckSquare, IconChevronsUpDown, IconHash, IconImage, IconLink2, IconPaperclip, IconTags, IconType, IconVideo } from '../../components/icons.jsx';


// ============================================================================
// Databases — Notion-style tables, stored as JSON inside a ".base" file.
// State shape is plain data (columns / rows / views); persistence is just
// "call onChange with a new JSON string", which flows through the exact
// same debounced Drive-save pipeline a note's textarea already uses (see
// ensureFileLoaded / saveNow in App). Nothing here ever touches IndexedDB
// directly — a database's body is just another buffer.
// ============================================================================
const DB_ROW_DND_MIME = 'application/x-vault-db-row';


function dbId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}


// Column type registry. `number_int`/`number_float` are kept as two
// distinct types (rather than one "Number" type with a format toggle) per
// SQL convention; `image`/`video`/`audio`/`file` are dedicated attachment
// types (each stores an array of {id, name} Drive file references) rather
// than one generic "file" type, so a Gallery view can tell an image column
// apart from a PDF column when picking a cover.
const DB_COLUMN_TYPES = {
  text: { label: 'Text', icon: IconType },
  text_multiline: { label: 'Multi-line text', icon: IconAlignLeft },
  number_int: { label: 'Number (integer)', icon: IconHash },
  number_float: { label: 'Number (decimal)', icon: IconHash },
  select: { label: 'Select', icon: IconChevronsUpDown },
  multi_select: { label: 'Multi-select / tags', icon: IconTags },
  date: { label: 'Date', icon: IconCalendar },
  checkbox: { label: 'Checkbox', icon: IconCheckSquare },
  url: { label: 'URL', icon: IconLink2 },
  image: { label: 'Image', icon: IconImage },
  video: { label: 'Video', icon: IconVideo },
  audio: { label: 'Audio', icon: IconAudio },
  file: { label: 'File', icon: IconPaperclip }
};

const DB_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file']);

// Sorting only makes sense for types with an unambiguous, sensible
// ordering — plain scalars, dates, checkboxes, single-select, and URLs
// (sorted as plain strings). Multi-select and the attachment types
// (image/video/audio/file, which each hold an array of file references)
// are deliberately excluded from the sortable set: "ascending" isn't a
// well-defined idea for a set of tags or a list of attachments.
const DB_SORTABLE_TYPES = new Set(['text', 'text_multiline', 'number_int', 'number_float', 'select', 'date', 'checkbox', 'url']);

// Comparator for a single column's values, used by the table view's
// column-header sort. `select` sorts by option label (not id/insertion
// order) since that's what the user actually sees; everything else
// compares its own natural type. Nullish/empty values always sort last
// regardless of direction, matching Notion/Airtable convention rather
// than flip-flopping to the top on descending sort.
function compareDbValues(column, a, b) {
  const isEmpty = (v) => v === null || v === undefined || v === '';
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (column.type === 'number_int' || column.type === 'number_float') {
    return Number(a) - Number(b);
  }
  if (column.type === 'checkbox') {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  if (column.type === 'date') {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  if (column.type === 'select') {
    const label = (v) => (column.options || []).find((o) => o.id === v)?.label || '';
    return label(a).localeCompare(label(b));
  }
  return String(a).localeCompare(String(b));
}

const DB_OPTION_COLORS = ['#8875e0', '#e0685f', '#e0a63d', '#6fcf97', '#4fa3e0', '#e07fc0', '#b0b0b0', '#5fc9c9'];


function dbEmptyValue(type) {
  if (type === 'checkbox') return false;
  if (type === 'multi_select' || DB_ATTACHMENT_TYPES.has(type)) return [];
  return null;
}


function dbMakeRow(columns) {
  const values = {};
  columns.forEach((c) => {
    values[c.id] = dbEmptyValue(c.type);
  });
  return { id: dbId('row'), values, createdAt: Date.now() };
}


function makeDefaultDatabaseState(title) {
  const nameCol = dbId('col');
  const statusCol = dbId('col');
  const tagsCol = dbId('col');
  const dueCol = dbId('col');
  const tableView = dbId('view');
  const boardView = dbId('view');
  const galleryView = dbId('view');
  const columns = [
    { id: nameCol, name: 'Name', type: 'text' },
    {
      id: statusCol,
      name: 'Status',
      type: 'select',
      options: [
        { id: dbId('opt'), label: 'Not started', color: '#b0b0b0' },
        { id: dbId('opt'), label: 'In progress', color: '#e0a63d' },
        { id: dbId('opt'), label: 'Done', color: '#6fcf97' }
      ]
    },
    { id: tagsCol, name: 'Tags', type: 'multi_select', options: [] },
    { id: dueCol, name: 'Due', type: 'date' }
  ];
  return {
    version: 1,
    title: title || 'Untitled database',
    columns,
    rows: [],
    views: [
      { id: tableView, name: 'Table', type: 'table' },
      { id: boardView, name: 'Board', type: 'board', groupByColumnId: statusCol },
      { id: galleryView, name: 'Gallery', type: 'gallery', coverColumnId: null }
    ],
    activeViewId: tableView
  };
}


// Tolerant parse: any malformed/foreign JSON just yields a fresh default
// database rather than crashing the pane — a `.base` file is never load-
// bearing enough to be worth a hard error screen.
function parseDatabaseContent(content) {
  if (!content || !content.trim()) return makeDefaultDatabaseState();
  try {
    const p = JSON.parse(content);
    if (!p || typeof p !== 'object' || !Array.isArray(p.columns)) return makeDefaultDatabaseState();
    const views = Array.isArray(p.views) && p.views.length ? p.views : [{ id: dbId('view'), name: 'Table', type: 'table' }];
    return {
      version: 1,
      title: p.title || 'Untitled database',
      columns: p.columns,
      rows: Array.isArray(p.rows) ? p.rows : [],
      views,
      activeViewId: p.activeViewId && views.some((v) => v.id === p.activeViewId) ? p.activeViewId : views[0].id
    };
  } catch {
    return makeDefaultDatabaseState();
  }
}


function serializeDatabaseState(state) {
  return JSON.stringify(state, null, 2);
}

// Group-by/aggregate helper for Chart view — a pure function (no chart-
// library or rendering concerns) so a future "chart block embedded in a
// note" feature could reuse it directly (section 3.4: one source of
// truth for this math, not recomputed inline inside a chart component).
// Groups rows by a Select column's option — same "must be a Select"
// constraint Board's own group-by already has, so the same
// `DbGroupByPicker` prompt/UI is reusable as-is for Chart too — then
// reduces each group to one number: a plain row count, or a sum/average
// of a numeric column. Every option gets a bucket even with zero matching
// rows (same "every option is a column" rule Board's board view already
// follows), so a bar/slice doesn't disappear out from under you the
// moment its last row is removed or re-tagged.
function aggregateDbRows(rows, groupByColumn, valueColumn, aggregateFn) {
  const buckets = new Map();
  (groupByColumn?.options || []).forEach((o) => buckets.set(o.id, { key: o.id, label: o.label, color: o.color, values: [] }));
  let noneValues = [];
  rows.forEach((r) => {
    const key = groupByColumn ? r.values[groupByColumn.id] : null;
    const bucket = key && buckets.has(key) ? buckets.get(key) : null;
    const raw = valueColumn ? Number(r.values[valueColumn.id]) : NaN;
    const num = Number.isFinite(raw) ? raw : 0;
    if (bucket) bucket.values.push(num);
    else noneValues.push(num);
  });
  if (noneValues.length) buckets.set('__none__', { key: '__none__', label: 'No value', color: '#808080', values: noneValues });
  return Array.from(buckets.values()).map((b) => ({
    key: b.key,
    label: b.label,
    color: b.color,
    value:
      aggregateFn === 'sum'
        ? b.values.reduce((a, v) => a + v, 0)
        : aggregateFn === 'average'
          ? b.values.length
            ? b.values.reduce((a, v) => a + v, 0) / b.values.length
            : 0
          : b.values.length // 'count', the default
  }));
}

export { DB_ROW_DND_MIME, dbId, DB_COLUMN_TYPES, DB_ATTACHMENT_TYPES, DB_SORTABLE_TYPES, compareDbValues, DB_OPTION_COLORS, dbEmptyValue, dbMakeRow, makeDefaultDatabaseState, parseDatabaseContent, serializeDatabaseState, aggregateDbRows };
