import { useState } from 'react';

import { IconX } from '../../components/icons.jsx';
import { Callout } from '../../lib/markdownRender.jsx';


// Full-size image viewer modal — opened from the sidebar, search results,
// or clicking an embedded/linked image inside a note. Shows which notes
// link to this image, reusing the same backlink graph notes get.
// ---------------------------------------------------------------------------
// Command palette / quick switcher — one shared modal component. In
// 'switcher' mode it fuzzy-matches file names (⌘O); in 'commands' mode it
// fuzzy-matches a fixed command list (⌘K / ⌘P).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Help — replaces the old single window.alert() shortcut list with a proper
// modal: keyboard shortcuts, a markdown syntax reference, and a plain-
// language tour of the app's features. Content is static, so it lives right
// in this component rather than as separate data.
// ---------------------------------------------------------------------------
const HELP_SHORTCUTS = [
  { keys: '⌘/Ctrl K or P', desc: 'Open the command palette' },
  { keys: '⌘/Ctrl O', desc: 'Quick switcher — jump to any note by name' },
  { keys: '⌘/Ctrl S', desc: 'Save the note in the focused pane' },
  { keys: '⌘/Ctrl Z', desc: 'Undo (⇧ for redo)' },
  { keys: 'Tab / ⇧Tab', desc: 'Indent / outdent the current line while editing' },
  { keys: 'Middle-click a tab', desc: 'Close that tab' },
  { keys: 'Drag a file or folder', desc: 'Move it in the sidebar' },
  { keys: '⌘/Ctrl-click a note or file', desc: 'Open it in a new tab instead of the current one' }
];


const HELP_MARKDOWN = [
  { syntax: '# / ## / ###', desc: 'Headings (levels 1–6). Click the caret next to a heading in reading view to fold its section.' },
  { syntax: '**bold**, *italic*, `code`', desc: 'Standard inline formatting. __bold__ and _italic_ (underscore form) also work.' },
  { syntax: '~~strikethrough~~', desc: 'Strikethrough text.' },
  { syntax: '==highlight==', desc: 'Highlights text using the accent color, in both editing and reading view.' },
  { syntax: '++underline++', desc: 'Underlines text.' },
  { syntax: '[[Note Name]]', desc: 'Link to another note. Start typing after [[ for autocomplete; unmatched names become "phantom" links you can create by clicking. Works in a note\'s body and in frontmatter property values (e.g. related: [[Other Note]]).' },
  { syntax: '[[image.png]] / [[clip.mp4]] / [[song.mp3]]', desc: 'Embed an image, video, or audio file inline by filename.' },
  { syntax: '[[Database.base#Row Title]]', desc: "Deep-link to one row of a database — opens the file and that row's detail panel directly. Matched by the row's title (its first text column), same as any other wikilink." },
  { syntax: '#tag or #parent/child', desc: 'Tag a note. Autocomplete suggests existing tags as you type; nested tags (parent/child) group and roll up counts in the Tags panel. Works both in the note body and as a tags: frontmatter property.' },
  { syntax: '> [!tip] Title', desc: 'Callout block. Recognized types: note, info, abstract, summary, tip, hint, success, check, done, question, help, faq, warning, caution, attention, danger, error, failure, bug, quote, example.' },
  { syntax: '| a | b |\\n|---|---|\\n| 1 | 2 |', desc: 'Tables, standard markdown pipe syntax.' },
  { syntax: '+++ Toggle title\\n…content…\\n+++', desc: 'Collapsible toggle block — click the header to expand or collapse.' },
  { syntax: ':::columns-2\\n…\\n:::column\\n…\\n:::', desc: 'Side-by-side columns. Use columns-2, columns-3, or columns-4, and separate columns with a line containing only :::column.' },
  { syntax: ':::tabs\\n:::tab First\\n…\\n:::tab Second\\n…\\n:::', desc: 'A paginated tab block, like a Notion tab widget. Click a tab to switch pages, double-click a tab to rename it, use the × to delete it, and the + to add a new one — all directly from reading view.' },
  { syntax: '- [ ] / - [x]', desc: 'Task checkboxes. - / * / + are all valid bullets.' },
  { syntax: '- item / * item / + item', desc: 'Bulleted list. Wrapped lines of a long item automatically indent to line up under the item\'s text.' },
  { syntax: '1. item, 1) item, 01) item', desc: 'Numbered list. Both "." and ")" delimiters work, and a leading zero (01, 02, …) is kept exactly as typed rather than being renumbered.' },
  { syntax: 'a) item, A. item', desc: 'Lettered list, using either case and either "." or ")" as the delimiter.' },
  { syntax: 'Tab / Shift-Tab on a list line', desc: 'Nest or un-nest that item (and its own sub-items) one level.' },
  { syntax: '---\\nkey: value\\n---', desc: 'Frontmatter at the top of a note — shown as a Properties panel, and matched by [key] / [key:value] in search. List-style values and [[wikilink]] values are both supported.' },
  { syntax: '```query\\nTABLE ...\\n```', desc: 'A live query block. See "Query engine" under Features for the query language.' }
];


const HELP_FEATURES = [
  {
    title: 'Query engine',
    desc:
      'A ```query (or ```dataview) fenced code block runs a small Dataview-style query over the store and renders live, in both reading view and the editor. ' +
      'Every note is a "page": its frontmatter properties, any inline `key:: value` fields in its body, plus a reserved file.* namespace (file.name, file.path, file.folder, file.link, file.tags, file.ctime, file.mtime). ' +
      'Start the block with TABLE [field, field2, …], LIST, or TASK, then add optional FROM/WHERE/SORT/LIMIT lines. ' +
      'FROM filters which notes to consider by #tag or "folder", combined with AND / OR / - (negation). ' +
      'WHERE filters by field comparisons: =, !=, <, <=, >, >=, contains(), exists(). ' +
      'SORT takes one or more "field ASC|DESC" comparisons, and LIMIT caps the number of rows. ' +
      'Example:\n```query\nTABLE status, due\nFROM #project\nWHERE status != "done"\nSORT due ASC\nLIMIT 10\n```'
  },
  { title: 'Tabs & panes', desc: 'Every note, database, or file opens in a tab. Split a pane right or down from the pane header to view two things side by side; drag the divider to resize.' },
  { title: 'Reading vs. editing view', desc: 'Toggle with the eye icon in a note\'s pane header. Editing view keeps the raw markdown fully editable while still styling it — same fonts and sizes as reading view, just with the syntax characters dimmed instead of hidden.' },
  { title: 'Backlinks', desc: 'Every note tracks what links to it. Linked/unlinked mentions show at the bottom of reading view.' },
  { title: 'Search', desc: 'path:, file:, and tag: filter by location, filename, or tag (tag: also matches nested descendants). line:(a b) and section:(a b) require terms on the same line or under the same heading. [key] or [key:value] matches frontmatter. "exact phrase" for literal text; anything else is a plain term.' },
  { title: 'Tags panel', desc: 'Every tag in the store, nested tags shown as an indented tree with counts that roll up to their parent. Click any tag to search it.' },
  { title: 'Databases', desc: 'Notion-style structured tables stored as a .base file — table, board, and gallery views, with typed columns (text, select, multi-select, date, image, etc). Click a table column header to sort by it (ascending, then descending, then back to unsorted) for any sortable type.' },
  { title: 'Canvas', desc: 'An infinite, freeform board (.canvas file) for arranging notes, text cards, and images spatially and connecting them with arrows — pan by dragging the background, scroll/pinch to zoom, drag a card\'s edge to draw a connection to another card.' },
  { title: 'Bookmarks', desc: 'Star any note or file to pin it in the Bookmarks panel for quick access.' },
  { title: 'Command palette & quick switcher', desc: '⌘/Ctrl K for commands (new note, split pane, toggle sidebar, etc), ⌘/Ctrl O to jump straight to a note by name.' },
  { title: 'Images & files', desc: 'Open in their own tab just like notes — video/audio get inline players, other files get a download link — rather than a new browser tab.' },
  { title: 'Graph view', desc: 'The network icon in the activity bar (or ⌘/Ctrl K → "Open graph view") opens a full map of every wikilink in the store. Drag nodes, scroll to zoom, hover to see a note\'s connections, and click a node to jump straight to it. Toggle attachments and orphans on or off from the toolbar.' }
];


function HelpModal({ onClose }) {
  const [tab, setTab] = useState('shortcuts');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-modal-header">
          <h3>Help</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close help">
            <IconX size={16} />
          </button>
        </div>
        <div className="help-modal-tabs">
          <button className={`help-tab ${tab === 'shortcuts' ? 'active' : ''}`} onClick={() => setTab('shortcuts')}>
            Shortcuts
          </button>
          <button className={`help-tab ${tab === 'markdown' ? 'active' : ''}`} onClick={() => setTab('markdown')}>
            Markdown syntax
          </button>
          <button className={`help-tab ${tab === 'features' ? 'active' : ''}`} onClick={() => setTab('features')}>
            Features
          </button>
        </div>
        <div className="help-modal-body">
          {tab === 'shortcuts' && (
            <div className="help-rows">
              {HELP_SHORTCUTS.map((s) => (
                <div className="help-row" key={s.keys}>
                  <code className="help-row-key">{s.keys}</code>
                  <span className="help-row-desc">{s.desc}</span>
                </div>
              ))}
            </div>
          )}
          {tab === 'markdown' && (
            <div className="help-rows">
              {HELP_MARKDOWN.map((s) => (
                <div className="help-row" key={s.syntax}>
                  <code className="help-row-key help-row-syntax">{s.syntax}</code>
                  <span className="help-row-desc">{s.desc}</span>
                </div>
              ))}
            </div>
          )}
          {tab === 'features' && (
            <div className="help-rows">
              {HELP_FEATURES.map((f) => (
                <div className="help-row help-row-feature" key={f.title}>
                  <span className="help-row-title">{f.title}</span>
                  <span className="help-row-desc">{f.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { HELP_SHORTCUTS, HELP_MARKDOWN, HELP_FEATURES, HelpModal };
