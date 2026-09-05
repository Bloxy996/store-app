import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { history } from '@codemirror/commands';

import { ActivityBar } from './components/ActivityBar.jsx';
import { ResizeHandle } from './components/ResizeHandle.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { useAppUpdate } from './hooks/useAppUpdate.js';
import { IconCanvasKind, IconDatabase, IconEye, IconFilePlus, IconFolder, IconFolderPlus, IconGraph, IconHelp, IconLogOut, IconPalette, IconPanelLeft, IconRefresh, IconSearch, IconSettings, IconSplitHorizontal, IconSplitVertical, IconStar, IconTag } from './components/icons.jsx';
import { AccentColorPicker } from './features/accent/AccentColorPicker.jsx';
import { useAccentColor } from './features/accent/accentColor.js';
import { BookmarksPanel } from './features/bookmarks/BookmarksPanel.jsx';
import { makeDefaultCanvasState, serializeCanvasState } from './features/canvas/canvasState.js';
import { makeDefaultDatabaseState, serializeDatabaseState } from './features/database/dbState.js';
import { OnboardingFlow, loadingStepProps } from './features/onboarding/OnboardingFlow.jsx';
import { ProxyFolderBrowser } from './features/onboarding/ProxyFolderBrowser.jsx';
import { PaneNode, collapseEmptyLeaves, findSplitNode, purgeFileFromTree } from './features/panes/PaneNode.jsx';
import { SearchPanel } from './features/search/SearchPanel.jsx';
import { ExplorerPanel } from './features/sidebar/ExplorerPanel.jsx';
import { TagsPanel } from './features/tags/TagsPanel.jsx';
import { TocPanel } from './features/toc/TocPanel.jsx';
import { useGoogleAuth, useProxyAuth } from './hooks/useAuth.js';
import { releaseImageUrlCache } from './hooks/useDriveImageUrl.js';
import { useVaultIndex } from './hooks/useVaultIndex.js';

// Code-split: each of these is a full-screen modal/overlay that most
// sessions never open (graph view, in-app help, the Cmd+K palette). Loading
// them lazily keeps them out of the initial bundle a phone has to parse
// before it can show a single note — see CLAUDE.md "Mobile performance &
// bundle size" for the rest of the code-splitting rules this follows.
const GraphViewModal = lazy(() => import('./features/graph/GraphViewModal.jsx').then((m) => ({ default: m.GraphViewModal })));
const HelpModal = lazy(() => import('./features/help/HelpModal.jsx').then((m) => ({ default: m.HelpModal })));
const PaletteModal = lazy(() => import('./features/palette/PaletteModal.jsx').then((m) => ({ default: m.PaletteModal })));
import { buildVaultTree, useVaultSync } from './hooks/useVaultSync.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { driveCreateFile, driveCreateFolder, driveGetFileContent, driveMoveItem, driveRenameItem, driveTrashItem, driveUpdateFileContent, driveUploadBinary, isProxy, openFolderPicker } from './lib/driveApi.js';
import { idbGet, idbPut } from './lib/indexedDb.js';
import { resolveLinkTarget } from './lib/linkGraph.js';
import { extractTags } from './lib/markdownParse.js';
import { collectLeaves, findLeaf, getFirstLeaf, makeLeaf, makeTab, removeLeafFromTree, splitLeafInTree, updateLeaf, updateSplitSizes } from './lib/paneTree.js';
import { buildPagesIndex } from './lib/queryEngine.js';
import { STORE_META, classifyKind, extensionForKind, fileExtension, opensInEditorPane } from './lib/vaultConfig.js';


export default function App() {
  const { token: googleToken, gisReady, signIn, signOut: signOutGoogle } = useGoogleAuth();
  const { proxyToken, signInProxy, signOutProxy } = useProxyAuth();
  const token = googleToken || proxyToken;
  const signOut = useCallback(() => {
    signOutGoogle();
    signOutProxy();
  }, [signOutGoogle, signOutProxy]);

  const [showProxyFolderPicker, setShowProxyFolderPicker] = useState(false);
  const [accentColor, setAccentColor] = useAccentColor();
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const accentPickerAnchorRef = useRef(null);
  // The picker itself now renders through a portal into <body> (see
  // AccentColorPicker), so it's no longer a DOM descendant of the anchor —
  // the outside-click check below needs its own ref too, or clicking a
  // swatch would register as "outside" and close the picker instantly.
  const accentPickerPortalRef = useRef(null);
  useEffect(() => {
    if (!accentPickerOpen) return undefined;
    const onDocMouseDown = (e) => {
      const inAnchor = accentPickerAnchorRef.current && accentPickerAnchorRef.current.contains(e.target);
      const inPortal = accentPickerPortalRef.current && accentPickerPortalRef.current.contains(e.target);
      if (!inAnchor && !inPortal) {
        setAccentPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [accentPickerOpen]);
  const [folder, setFolder] = useState(null);
  const [folderRestoring, setFolderRestoring] = useState(true);
  const sync = useVaultSync(token, folder);
  const appUpdate = useAppUpdate();
  const vaultIndex = useVaultIndex(token, sync.filesMeta);

  // buffers: fileId -> { content, dirty, saving, loading, loadError }
  const [buffers, setBuffers] = useState({});
  const loadingFileIds = useRef(new Set());
  const saveTimers = useRef({});

  const [paneTree, setPaneTree] = useState(() => makeLeaf(null));
  const [activePaneId, setActivePaneId] = useState(() => paneTree.id);

  const [activeSideView, setActiveSideView] = useState('explorer'); // explorer | search | tags | bookmarks
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [sideDockWidth, setSideDockWidth] = useState(280);
  const [searchQuery, setSearchQuery] = useState('');
  const [bookmarks, setBookmarks] = useState(new Set());
  const [paletteMode, setPaletteMode] = useState(null); // null | 'commands' | 'switcher'
  const [helpOpen, setHelpOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  // When the switcher is opened via the tab bar's "+" button, the next pick
  // should always open in a new tab — unlike ⌘O, which navigates the current
  // tab unless the user holds Cmd/Ctrl. Tracked as a ref (not state) since it
  // only needs to be read once, synchronously, when a pick is made.
  const paletteForceNewTabRef = useRef(false);

  // Restore the last-selected vault folder (an ID string, not note content).
  useEffect(() => {
    idbGet(STORE_META, 'vaultFolder').then((rec) => {
      if (rec) setFolder(rec.value);
      setFolderRestoring(false);
    });
  }, []);

  // Kick off a diff-sync whenever we have both a token and a folder.
  useEffect(() => {
    if (token && folder) sync.syncNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, folder?.id]);

  // Load this vault's bookmark list (just fileIds — metadata, not content).
  useEffect(() => {
    if (!folder?.id) {
      setBookmarks(new Set());
      return;
    }
    idbGet(STORE_META, `bookmarks:${folder.id}`).then((rec) => setBookmarks(new Set(rec?.value || [])));
  }, [folder?.id]);

  const toggleBookmark = useCallback(
    (fileId) => {
      setBookmarks((prev) => {
        const next = new Set(prev);
        next.has(fileId) ? next.delete(fileId) : next.add(fileId);
        if (folder?.id) idbPut(STORE_META, { key: `bookmarks:${folder.id}`, value: Array.from(next) });
        return next;
      });
    },
    [folder?.id]
  );

  // Used both for the first-time folder prompt and for switching vaults
  // later from the ribbon. Resets editor + sync state so nothing from the
  // previous vault lingers on screen.
  const applyPickedFolder = useCallback(
    (picked) => {
      sync.resetVault();
      releaseImageUrlCache();
      setFolder(picked);
      idbPut(STORE_META, { key: 'vaultFolder', value: picked });
      setBuffers({});
      saveTimers.current = {};
      setPaneTree(makeLeaf(null));
      setActivePaneId((prev) => prev);
      setSearchQuery('');
      setMobileDockOpen(false);
      setActiveSideView('explorer');
    },
    [sync]
  );

  const handlePickFolder = useCallback(async () => {
    if (!token) return;
    if (isProxy(token)) {
      setShowProxyFolderPicker(true);
      return;
    }
    const picked = await openFolderPicker(token);
    if (picked) applyPickedFolder(picked);
  }, [token, applyPickedFolder]);

  const handleProxyFolderPicked = useCallback(
    (picked) => {
      setShowProxyFolderPicker(false);
      applyPickedFolder(picked);
    },
    [applyPickedFolder]
  );

  // Keep activePaneId valid whenever the pane tree changes shape (closing
  // the active pane, vault switch, etc.).
  useEffect(() => {
    if (!findLeaf(paneTree, activePaneId)) {
      const first = getFirstLeaf(paneTree);
      if (first) setActivePaneId(first.id);
    }
  }, [paneTree, activePaneId]);

  const filesById = useMemo(() => new Map(sync.filesMeta.map((f) => [f.id, f])), [sync.filesMeta]);

  // Wikilink targets that don't resolve to any real file yet ("phantom"
  // notes, in Obsidian's terminology) — collected from every link in the
  // vault so they still show up in [[ autocomplete even though nothing has
  // been created for them. Picking one from the list just inserts the link;
  // the note itself is created the normal way, on first click-through.
  const phantomRecords = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const links of sync.linksByFileId.values()) {
      for (const link of links) {
        const res = resolveLinkTarget(link.target, sync.linkIndex);
        if (res.status !== 'missing') continue;
        const raw = String(link.target || '').trim();
        if (!raw) continue;
        const isImage = res.isImage;
        const cleaned = isImage ? raw : raw.replace(/\.md$/i, '');
        const key = `${isImage ? 'img' : 'note'}:${cleaned.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const slash = cleaned.lastIndexOf('/');
        const baseName = slash === -1 ? cleaned : cleaned.slice(slash + 1);
        out.push({
          id: `phantom:${key}`,
          name: isImage ? baseName : `${baseName}.md`,
          baseName,
          relativePath: cleaned,
          dir: slash === -1 ? '' : cleaned.slice(0, slash),
          isImage,
          isPhantom: true
        });
      }
    }
    return out;
  }, [sync.linksByFileId, sync.linkIndex]);
  const tree = useMemo(() => buildVaultTree(folder?.id, sync.foldersMeta, sync.filesMeta), [folder?.id, sync.foldersMeta, sync.filesMeta]);
  const tagsByFileId = useMemo(() => {
    const map = new Map();
    sync.filesMeta.forEach((f) => {
      if (f.kind === 'note') map.set(f.id, extractTags(vaultIndex.getBody(f.id)));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.filesMeta, vaultIndex.getBody, vaultIndex.version]);

  // Flat, deduped, sorted list of every tag used anywhere in the vault —
  // powers the #tag autocomplete dropdown in the editor.
  const allTags = useMemo(() => {
    const set = new Set();
    tagsByFileId.forEach((tags) => tags.forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tagsByFileId]);

  // Every note's frontmatter + inline `key:: value` fields, indexed once
  // for ```query blocks (see QueryBlock/buildPagesIndex above). Same
  // dependency shape as tagsByFileId/allTags: rebuilds only when the set of
  // notes or their indexed bodies actually changes.
  const pagesIndex = useMemo(
    () => buildPagesIndex(sync.filesMeta, sync.linkIndex, vaultIndex.getBody),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync.filesMeta, sync.linkIndex, vaultIndex.getBody, vaultIndex.version]
  );

  // --- Content loading (per open tab) --------------------------------------
  const ensureFileLoaded = useCallback(
    (fileId) => {
      if (!fileId || !token) return;
      if (buffers[fileId] || loadingFileIds.current.has(fileId)) return;
      const meta = sync.filesMeta.find((f) => f.id === fileId);
      if (!meta || !opensInEditorPane(meta.kind)) return;
      loadingFileIds.current.add(fileId);
      setBuffers((prev) => ({ ...prev, [fileId]: { content: '', dirty: false, saving: false, loading: true } }));
      driveGetFileContent(token, fileId)
        .then((text) => {
          // Databases aren't part of the note search/tag index — only
          // notes' bodies get indexed for full-text search.
          if (meta.kind === 'note') vaultIndex.updateBody(fileId, text);
          setBuffers((prev) => ({ ...prev, [fileId]: { content: text, dirty: false, saving: false, loading: false } }));
        })
        .catch((err) => {
          setBuffers((prev) => ({
            ...prev,
            [fileId]: { content: '', dirty: false, saving: false, loading: false, loadError: err.message }
          }));
        })
        .finally(() => loadingFileIds.current.delete(fileId));
    },
    [token, buffers, sync.filesMeta, vaultIndex]
  );

  const saveNow = useCallback(
    async (fileId, value) => {
      if (!token) return;
      setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], saving: true } } : prev));
      try {
        const updated = await driveUpdateFileContent(token, fileId, value);
        sync.applyLocalEdit(fileId, value, updated.modifiedTime || new Date().toISOString());
        vaultIndex.updateBody(fileId, value);
        setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], dirty: false, saving: false } } : prev));
      } catch (err) {
        console.error(err);
        setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], saving: false } } : prev));
      }
    },
    [token, sync, vaultIndex]
  );

  const handleContentChange = useCallback(
    (fileId, value) => {
      setBuffers((prev) => ({ ...prev, [fileId]: { ...prev[fileId], content: value, dirty: true } }));
      if (saveTimers.current[fileId]) clearTimeout(saveTimers.current[fileId]);
      saveTimers.current[fileId] = setTimeout(() => saveNow(fileId, value), 1200);
    },
    [saveNow]
  );

  // Manual save shortcut — saves whichever file the focused pane has open.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const leaf = findLeaf(paneTree, activePaneId);
        const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
        if (tab) {
          if (saveTimers.current[tab.fileId]) clearTimeout(saveTimers.current[tab.fileId]);
          const buf = buffers[tab.fileId];
          if (buf) saveNow(tab.fileId, buf.content);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [paneTree, activePaneId, buffers, saveNow]);

  // Command palette (⌘K / ⌘P) + quick switcher (⌘O).
  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        setPaletteMode('commands');
      } else if (mod && e.key === 'o') {
        e.preventDefault();
        paletteForceNewTabRef.current = false;
        setPaletteMode('switcher');
      } else if (e.key === 'Escape') {
        setPaletteMode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // --- Pane-tree actions -----------------------------------------------------
  const openFileInPane = useCallback(
    (paneId, fileId, { newTab = false } = {}) => {
      if (!paneId || !fileId) return;
      ensureFileLoaded(fileId);
      const next = updateLeaf(paneTree, paneId, (leaf) => {
        const existingTab = leaf.tabs.find((t) => t.fileId === fileId);
        if (existingTab && !newTab) {
          return { ...leaf, activeTabId: existingTab.id };
        }
        if (!newTab && leaf.activeTabId) {
          const tabs = leaf.tabs.map((t) => {
            if (t.id !== leaf.activeTabId) return t;
            const history = t.history.slice(0, t.historyIndex + 1);
            history.push(fileId);
            return { ...t, fileId, history, historyIndex: history.length - 1 };
          });
          return { ...leaf, tabs };
        }
        const tab = makeTab(fileId, 'edit');
        return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tab.id };
      });
      setPaneTree(next);
      setActivePaneId(paneId);
      setMobileDockOpen(false);
    },
    [paneTree, ensureFileLoaded]
  );

  // Stable wrappers around openFileInPane for the always-mounted sidebar
  // panels (Explorer/Bookmarks) and the Graph modal. Perf note: without
  // these, the inline `(id) => openFileInPane(...)` arrows written directly
  // in JSX get a new identity every time App re-renders — which happens on
  // every keystroke, since note content lives in App-level `buffers` state.
  // A new function identity defeats React.memo on ExplorerPanel/TreeNode/
  // BookmarksPanel, so the entire sidebar tree was re-rendering per
  // keystroke even though nothing in it actually changed. These two
  // references only change when the active pane does.
  const handleSidebarOpenFile = useCallback(
    (id, e) => openFileInPane(activePaneId, id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) }),
    [activePaneId, openFileInPane]
  );
  const handleSidebarOpenImage = useCallback(
    (file, e) => openFileInPane(activePaneId, file.id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) }),
    [activePaneId, openFileInPane]
  );

  const selectTab = useCallback(
    (paneId, tabId) => {
      setPaneTree(updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, activeTabId: tabId })));
      setActivePaneId(paneId);
    },
    [paneTree]
  );

  const closeTab = useCallback(
    (paneId, tabId) => {
      let next = updateLeaf(paneTree, paneId, (leaf) => {
        const idx = leaf.tabs.findIndex((t) => t.id === tabId);
        const tabs = leaf.tabs.filter((t) => t.id !== tabId);
        let activeTabId = leaf.activeTabId;
        if (activeTabId === tabId) {
          const fallback = tabs[idx] || tabs[idx - 1] || tabs[tabs.length - 1] || null;
          activeTabId = fallback ? fallback.id : null;
        }
        return { ...leaf, tabs, activeTabId };
      });
      const leaf = findLeaf(next, paneId);
      if (leaf && leaf.tabs.length === 0 && collectLeaves(next).length > 1) {
        next = removeLeafFromTree(next, paneId);
      }
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const closeOthers = useCallback(
    (paneId, tabId) => {
      setPaneTree(updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, tabs: leaf.tabs.filter((t) => t.id === tabId), activeTabId: tabId })));
    },
    [paneTree]
  );

  const closeAllTabs = useCallback(
    (paneId) => {
      let next = updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, tabs: [], activeTabId: null }));
      if (collectLeaves(next).length > 1) next = removeLeafFromTree(next, paneId);
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const closePane = useCallback(
    (paneId) => {
      const next = removeLeafFromTree(paneTree, paneId);
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const splitPane = useCallback(
    (paneId, direction) => {
      const leaf = findLeaf(paneTree, paneId);
      const activeTab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
      const newLeaf = makeLeaf(activeTab?.fileId || null, activeTab?.mode || 'edit');
      setPaneTree(splitLeafInTree(paneTree, paneId, direction, newLeaf));
      setActivePaneId(newLeaf.id);
      if (activeTab?.fileId) ensureFileLoaded(activeTab.fileId);
    },
    [paneTree, ensureFileLoaded]
  );

  const splitTabDirect = useCallback(
    (paneId, tabId, direction) => {
      const leaf = findLeaf(paneTree, paneId);
      const tab = leaf?.tabs.find((t) => t.id === tabId);
      const newLeaf = makeLeaf(tab?.fileId || null, tab?.mode || 'edit');
      setPaneTree(splitLeafInTree(paneTree, paneId, direction, newLeaf));
      setActivePaneId(newLeaf.id);
    },
    [paneTree]
  );

  const toggleTabMode = useCallback(
    (paneId, tabId) => {
      setPaneTree(
        updateLeaf(paneTree, paneId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => (t.id === tabId ? { ...t, mode: t.mode === 'edit' ? 'preview' : 'edit' } : t))
        }))
      );
    },
    [paneTree]
  );

  const navigateHistory = useCallback(
    (paneId, delta) => {
      const leaf = findLeaf(paneTree, paneId);
      const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
      if (!tab) return;
      const idx = tab.historyIndex + delta;
      if (idx < 0 || idx >= tab.history.length) return;
      const fileId = tab.history[idx];
      ensureFileLoaded(fileId);
      setPaneTree(
        updateLeaf(paneTree, paneId, (l) => ({
          ...l,
          tabs: l.tabs.map((t) => (t.id === tab.id ? { ...t, fileId, historyIndex: idx } : t))
        }))
      );
    },
    [paneTree, ensureFileLoaded]
  );

  const resizeSplit = useCallback(
    (splitId, index, deltaPx, containerRef) => {
      const el = containerRef?.current;
      if (!el) return;
      const node = findSplitNode(paneTree, splitId);
      if (!node) return;
      const rect = el.getBoundingClientRect();
      const totalPx = node.direction === 'row' ? rect.width : rect.height;
      if (!totalPx) return;
      const deltaPct = (deltaPx / totalPx) * 100;
      const sizes = node.sizes.slice();
      const a = index;
      const b = index + 1;
      const minPct = 12;
      let newA = sizes[a] + deltaPct;
      let newB = sizes[b] - deltaPct;
      if (newA < minPct) {
        newB -= minPct - newA;
        newA = minPct;
      }
      if (newB < minPct) {
        newA -= minPct - newB;
        newB = minPct;
      }
      sizes[a] = newA;
      sizes[b] = newB;
      setPaneTree(updateSplitSizes(paneTree, splitId, sizes));
    },
    [paneTree]
  );

  const purgeFileEverywhere = useCallback((fileId) => {
    setPaneTree((prev) => collapseEmptyLeaves(purgeFileFromTree(prev, fileId)) || makeLeaf(null));
    setBuffers((prev) => {
      if (!prev[fileId]) return prev;
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
    if (saveTimers.current[fileId]) {
      clearTimeout(saveTimers.current[fileId]);
      delete saveTimers.current[fileId];
    }
  }, []);

  // --- Create / open-by-name / rename / delete / move / upload -------------
  const openNoteByName = useCallback(
    async (name) => {
      const resolution = resolveLinkTarget(name, sync.linkIndex);
      if (resolution.status === 'resolved' && !resolution.file.isImage) {
        openFileInPane(activePaneId, resolution.file.id);
        return;
      }
      if (!folder || !token) return;
      const skeleton = `# ${name}\n\n`;
      const created = await driveCreateFile(token, folder.id, name, skeleton);
      const fileRecord = {
        id: created.id,
        name: created.name,
        modifiedTime: created.modifiedTime || new Date().toISOString(),
        parents: [folder.id],
        kind: 'note'
      };
      sync.registerNewFile(fileRecord);
      setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
      vaultIndex.updateBody(created.id, skeleton);
      openFileInPane(activePaneId, created.id);
    },
    [sync, folder, token, activePaneId, openFileInPane, vaultIndex]
  );

  const handleCreateNoteIn = useCallback(
    (parentId) => {
      const name = window.prompt('New note name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          const skeleton = `# ${name.trim()}\n\n`;
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton);
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind: 'note'
          };
          sync.registerNewFile(fileRecord);
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          vaultIndex.updateBody(created.id, skeleton);
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create note: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane, vaultIndex]
  );

  const handleCreateDatabaseIn = useCallback(
    (parentId) => {
      const name = window.prompt('New database name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          const skeleton = serializeDatabaseState(makeDefaultDatabaseState(name.trim()));
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton, 'base', 'application/json');
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind: 'database'
          };
          sync.registerNewFile(fileRecord);
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create database: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane]
  );

  const handleCreateCanvasIn = useCallback(
    (parentId) => {
      const name = window.prompt('New canvas name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          const skeleton = serializeCanvasState(makeDefaultCanvasState());
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton, 'canvas', 'application/json');
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind: 'canvas'
          };
          sync.registerNewFile(fileRecord);
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create canvas: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane]
  );

  const handleCreateFolderIn = useCallback(
    async (parentId) => {
      const name = window.prompt('New folder name:');
      if (!name || !name.trim()) return;
      try {
        const created = await driveCreateFolder(token, parentId, name.trim());
        sync.registerNewFolder({ id: created.id, name: created.name, parents: [parentId] });
      } catch (err) {
        window.alert(`Couldn't create folder: ${err.message}`);
      }
    },
    [token, sync]
  );

  const handleUploadFiles = useCallback(
    async (parentId, files) => {
      if (!token) return;
      const results = await mapWithConcurrency(files, 4, (file) => driveUploadBinary(token, parentId, file));
      const failed = [];
      results.forEach((r, i) => {
        if (r.ok) {
          const created = r.value;
          const kind = classifyKind(created.name, created.mimeType);
          sync.registerNewFile({
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind
          });
        } else {
          failed.push(files[i].name);
        }
      });
      if (failed.length) window.alert(`Some files couldn't be uploaded: ${failed.join(', ')}`);
    },
    [token, sync]
  );

  // Uploads a single binary file for a database attachment cell (image/
  // video/audio/file column types), registering it in the vault the same
  // way a sidebar upload would — so it's a real Drive file, not something
  // hidden inside the database's JSON.
  const uploadAttachmentFile = useCallback(
    async (parentId, file) => {
      if (!token) throw new Error('Uploading requires Google sign-in.');
      const created = await driveUploadBinary(token, parentId, file);
      const kind = classifyKind(created.name, created.mimeType);
      sync.registerNewFile({
        id: created.id,
        name: created.name,
        modifiedTime: created.modifiedTime || new Date().toISOString(),
        parents: [parentId],
        kind
      });
      return { id: created.id, name: created.name, kind };
    },
    [token, sync]
  );

  // Shared rename primitive: renames on Drive, then updates local sync state.
  // `kind` is only meaningful for files ('image' vs a note); ignored for folders.
  const performRename = useCallback(
    async (id, type, kind, newName) => {
      try {
        await driveRenameItem(token, id, newName);
        if (type === 'file') {
          sync.renameFile(id, newName);
        } else {
          sync.renameFolder(id, newName);
        }
        return true;
      } catch (err) {
        window.alert(`Couldn't rename: ${err.message}`);
        return false;
      }
    },
    [token, sync]
  );

  const handleRenameNode = useCallback(
    async (node) => {
      const isPage = node.type === 'file' && opensInEditorPane(node.kind);
      const isAsset = node.type === 'file' && !isPage;
      const currentDisplayName = node.type === 'file' && isPage ? node.name.replace(/\.[^.]+$/i, '') : node.name;
      const input = window.prompt('Rename to:', currentDisplayName);
      if (!input || !input.trim() || input.trim() === currentDisplayName) return;

      let newName;
      if (node.type !== 'file') {
        newName = input.trim();
      } else if (isAsset) {
        const typed = input.trim();
        newName = fileExtension(typed) ? typed : `${typed}.${fileExtension(node.name) || 'bin'}`;
      } else {
        const suffix = `.${extensionForKind(node.kind)}`;
        newName = input.trim().toLowerCase().endsWith(suffix) ? input.trim() : `${input.trim()}${suffix}`;
      }

      performRename(node.id, node.type, node.kind, newName);
    },
    [performRename]
  );

  // Rename driven by the inline title field above the note content (edit or
  // reading view) rather than the tree's context menu. `newDisplayTitle` has
  // no extension — this adds one back based on the file's current kind.
  const handleInlineRenameFile = useCallback(
    (fileId, newDisplayTitle) => {
      const file = filesById.get(fileId);
      if (!file) return;
      const trimmed = (newDisplayTitle || '').trim();
      if (!trimmed) return;
      const isPage = opensInEditorPane(file.kind);
      const currentDisplayName = isPage ? file.name.replace(/\.[^.]+$/i, '') : file.name;
      if (trimmed === currentDisplayName) return;
      let newName;
      if (isPage) {
        const suffix = `.${extensionForKind(file.kind)}`;
        newName = trimmed.toLowerCase().endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
      } else {
        newName = fileExtension(trimmed) ? trimmed : `${trimmed}.${fileExtension(file.name) || 'bin'}`;
      }
      performRename(fileId, 'file', file.kind, newName);
    },
    [filesById, performRename]
  );

  const handleDeleteNode = useCallback(
    async (node) => {
      const isPage = node.type === 'file' && opensInEditorPane(node.kind);
      const label = node.type === 'file' && isPage ? node.name.replace(/\.[^.]+$/i, '') : node.name;
      const warning =
        node.type === 'folder'
          ? `Delete folder "${label}" and everything inside it? This moves it to Drive's trash.`
          : `Delete "${label}"? This moves it to Drive's trash.`;
      if (!window.confirm(warning)) return;
      try {
        await driveTrashItem(token, node.id);
        if (node.type === 'file') {
          sync.removeFile(node.id);
          purgeFileEverywhere(node.id);
          if (bookmarks.has(node.id)) toggleBookmark(node.id);
        } else {
          const removedFileIds = sync.removeFolder(node.id);
          removedFileIds.forEach(purgeFileEverywhere);
          removedFileIds.forEach((id) => {
            if (bookmarks.has(id)) toggleBookmark(id);
          });
        }
      } catch (err) {
        window.alert(`Couldn't delete: ${err.message}`);
      }
    },
    [token, sync, purgeFileEverywhere, bookmarks, toggleBookmark]
  );

  const handleMoveNode = useCallback(
    async (id, type, targetFolderId) => {
      if (id === targetFolderId) return;
      const record = type === 'folder' ? sync.foldersMeta.find((f) => f.id === id) : sync.filesMeta.find((f) => f.id === id);
      if (!record) return;
      const oldParentId = (record.parents && record.parents[0]) || folder.id;
      if (oldParentId === targetFolderId) return;
      if (type === 'folder') {
        const isDescendant = (candidateId) => {
          let cur = sync.foldersMeta.find((f) => f.id === candidateId);
          while (cur) {
            const parentId = (cur.parents && cur.parents[0]) || folder.id;
            if (parentId === id) return true;
            if (parentId === folder.id) return false;
            cur = sync.foldersMeta.find((f) => f.id === parentId);
          }
          return false;
        };
        if (targetFolderId === id || isDescendant(targetFolderId)) return;
      }
      try {
        await driveMoveItem(token, id, targetFolderId, oldParentId);
        if (type === 'folder') sync.moveFolder(id, targetFolderId);
        else sync.moveFile(id, targetFolderId);
      } catch (err) {
        window.alert(err.code === 'proxy-unsupported' ? err.message : `Couldn't move: ${err.message}`);
      }
    },
    [token, sync, folder]
  );

  // Selected text in the active editor, so the status bar can show
  // selection-scoped word/char counts instead of the whole note's — null
  // when nothing's selected.
  const [editorSelectionText, setEditorSelectionText] = useState(null);
  // Set by a `[[Database.base#Row Title]]` link click (see onOpenById below)
  // and consumed by the matching DatabaseView once it's mounted/updated —
  // kept outside `handlers` on purpose, so a row-link click doesn't churn
  // the memoized `handlers` identity (see EditorContent.jsx's selection
  // effects for why that churn is worth avoiding).
  const [pendingRowOpen, setPendingRowOpen] = useState(null);

  // Bridge for the Outline panel: the currently-active pane's EditorContent
  // registers its scroll-to-heading function here (see the comment in
  // EditorContent), and onNavigateToHeading below just forwards to whatever
  // is currently registered. A ref, not state — this changes on every pane
  // focus / mode toggle and doesn't need to trigger a re-render itself.
  const activeEditorNavRef = useRef(null);

  const handlers = useMemo(
    () => ({
      token,
      onOpenById: (id, opts) => {
        openFileInPane(activePaneId, id);
        if (opts?.rowTarget) setPendingRowOpen({ fileId: id, rowTarget: opts.rowTarget });
      },
      onCreateOrOpenByName: (name) => openNoteByName(name),
      onOpenImage: (file) => openFileInPane(activePaneId, file.id),
      onOpenAsset: (file) => openFileInPane(activePaneId, file.id),
      onRenameFile: (fileId, newDisplayName) => handleInlineRenameFile(fileId, newDisplayName),
      onOpenTag: (tag) => {
        setActiveSideView('search');
        setSearchQuery(`tag:${tag}`);
        setMobileDockOpen(true);
      },
      onEditorSelectionChange: setEditorSelectionText,
      registerActiveEditorNav: (fn) => {
        activeEditorNavRef.current = fn;
      },
      onNavigateToHeading: (lineIndex, headingId) => {
        activeEditorNavRef.current?.(lineIndex, headingId);
        setMobileDockOpen(false);
      },
      uploadAttachment: uploadAttachmentFile,
      allTags,
      pagesIndex,
      ensureVaultIndexed: vaultIndex.ensureIndexed,
      vaultIndexReady: vaultIndex.ready,
      vaultIndexProgress: vaultIndex.progress,
      getBody: vaultIndex.getBody
    }),
    [
      token,
      openFileInPane,
      activePaneId,
      openNoteByName,
      handleInlineRenameFile,
      uploadAttachmentFile,
      allTags,
      pagesIndex,
      vaultIndex.ensureIndexed,
      vaultIndex.ready,
      vaultIndex.progress,
      vaultIndex.getBody
    ]
  );

  const handlePaletteFilePick = useCallback(
    (file, opts) => {
      setPaletteMode(null);
      openFileInPane(activePaneId, file.id, { ...opts, newTab: opts?.newTab || paletteForceNewTabRef.current });
      paletteForceNewTabRef.current = false;
    },
    [activePaneId, openFileInPane]
  );

  const commands = useMemo(() => {
    if (!folder) return [];
    return [
      { id: 'new-note', label: 'Create new note', icon: <IconFilePlus size={15} />, run: () => handleCreateNoteIn(folder.id) },
      { id: 'new-canvas', label: 'Create new canvas', icon: <IconCanvasKind size={15} />, run: () => handleCreateCanvasIn(folder.id) },
      { id: 'new-database', label: 'Create new database', icon: <IconDatabase size={15} />, run: () => handleCreateDatabaseIn(folder.id) },
      { id: 'new-folder', label: 'Create new folder', icon: <IconFolderPlus size={15} />, run: () => handleCreateFolderIn(folder.id) },
      { id: 'toggle-sidebar', label: 'Toggle left sidebar', icon: <IconPanelLeft size={15} />, run: () => setMobileDockOpen((v) => !v) },
      { id: 'split-right', label: 'Split pane right', icon: <IconSplitVertical size={15} />, run: () => splitPane(activePaneId, 'row') },
      { id: 'split-down', label: 'Split pane down', icon: <IconSplitHorizontal size={15} />, run: () => splitPane(activePaneId, 'column') },
      {
        id: 'toggle-mode',
        label: 'Toggle edit / reading view',
        icon: <IconEye size={15} />,
        run: () => {
          const leaf = findLeaf(paneTree, activePaneId);
          const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
          if (tab) toggleTabMode(activePaneId, tab.id);
        }
      },
      { id: 'sync', label: 'Sync store now', icon: <IconRefresh size={15} />, run: () => sync.syncNow() },
      {
        id: 'open-search',
        label: 'Open search',
        icon: <IconSearch size={15} />,
        run: () => {
          setActiveSideView('search');
          setMobileDockOpen(true);
        }
      },
      {
        id: 'open-tags',
        label: 'Open tag pane',
        icon: <IconTag size={15} />,
        run: () => {
          setActiveSideView('tags');
          setMobileDockOpen(true);
        }
      },
      {
        id: 'open-bookmarks',
        label: 'Open bookmarks',
        icon: <IconStar size={15} />,
        run: () => {
          setActiveSideView('bookmarks');
          setMobileDockOpen(true);
        }
      },
      { id: 'open-graph', label: 'Open graph view', icon: <IconGraph size={15} />, run: () => setGraphOpen(true) },
      {
        id: 'quick-switcher',
        label: 'Quick switcher: jump to note',
        icon: <IconSearch size={15} />,
        hint: '⌘O',
        run: () => {
          paletteForceNewTabRef.current = false;
          setPaletteMode('switcher');
        }
      },
      { id: 'change-folder', label: 'Change store folder', icon: <IconFolder size={15} />, run: handlePickFolder },
      { id: 'sign-out', label: 'Sign out', icon: <IconLogOut size={15} />, run: signOut }
    ];
  }, [folder, handleCreateNoteIn, handleCreateDatabaseIn, handleCreateCanvasIn, handleCreateFolderIn, activePaneId, splitPane, paneTree, toggleTabMode, sync, handlePickFolder, signOut]);

  const handlePaletteCommand = useCallback((cmd) => {
    setPaletteMode(null);
    cmd.run();
  }, []);

  if (!token) {
    return <OnboardingFlow step="signin" onSignIn={signIn} ready={gisReady} onSignInProxy={signInProxy} />;
  }
  if (folderRestoring) {
    const { label, pct } = loadingStepProps({ phase: 'opening', loaded: 0, total: 0 });
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
  }
  if (!folder) {
    if (showProxyFolderPicker) {
      return <OnboardingFlow step="proxy-folder" proxyToken={token} onProxyFolderPick={handleProxyFolderPicked} />;
    }
    return <OnboardingFlow step="folder" onPickFolder={handlePickFolder} />;
  }
  if (!sync.cacheLoaded) {
    const { label, pct } = loadingStepProps({ phase: 'opening', loaded: 0, total: 0 });
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
  }
  if (sync.filesMeta.length === 0 && sync.syncing) {
    const { label, pct } = loadingStepProps(sync.syncProgress);
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
  }

  const syncPct = sync.syncProgress.total > 0 ? Math.round((sync.syncProgress.loaded / sync.syncProgress.total) * 100) : null;

  const activeLeafForStatus = findLeaf(paneTree, activePaneId);
  const activeTabForStatus = activeLeafForStatus?.tabs.find((t) => t.id === activeLeafForStatus.activeTabId);
  const activeFileForStatus = activeTabForStatus ? filesById.get(activeTabForStatus.fileId) : null;
  const activeContentForStatus = activeTabForStatus ? buffers[activeTabForStatus.fileId]?.content || '' : '';
  const activeBacklinkCount = activeFileForStatus ? (sync.backlinkIndex.get(activeFileForStatus.id) || new Set()).size : 0;
  const currentOpenIds = new Set(collectLeaves(paneTree).flatMap((l) => l.tabs.map((t) => t.fileId)));

  return (
    <div className="app-shell">
      {sync.syncing && syncPct !== null && (
        <div className="topbar-progress">
          <div className="topbar-progress-fill" style={{ width: `${syncPct}%` }} />
        </div>
      )}
      <div className={`workspace ${mobileDockOpen ? 'dock-open' : ''}`}>
        <ActivityBar
          activeView={activeSideView}
          onSetView={(v) => {
            setActiveSideView(v);
            setMobileDockOpen(true);
          }}
          onOpenCommandPalette={() => setPaletteMode('commands')}
          onOpenGraph={() => setGraphOpen(true)}
          onSync={() => sync.syncNow()}
          syncing={sync.syncing}
          onChangeFolder={handlePickFolder}
          onSignOut={signOut}
          folderName={folder.name}
        />
        <div className="side-dock" style={{ width: sideDockWidth }}>
          <div className="side-dock-panels">
            {activeSideView === 'explorer' && (
              <ExplorerPanel
                tree={tree}
                vaultRootId={folder.id}
                currentIds={currentOpenIds}
                onOpenFile={handleSidebarOpenFile}
                onOpenImage={handleSidebarOpenImage}
                onCreateNote={handleCreateNoteIn}
                onCreateDatabase={handleCreateDatabaseIn}
                onCreateCanvas={handleCreateCanvasIn}
                onCreateFolder={handleCreateFolderIn}
                onUploadFiles={handleUploadFiles}
                onRename={handleRenameNode}
                onDelete={handleDeleteNode}
                onMoveNode={handleMoveNode}
                canUpload={!isProxy(token)}
                bookmarks={bookmarks}
                onToggleBookmark={toggleBookmark}
              />
            )}
            {activeSideView === 'search' && (
              <SearchPanel
                query={searchQuery}
                setQuery={setSearchQuery}
                filesMeta={sync.filesMeta}
                linkIndex={sync.linkIndex}
                getBody={vaultIndex.getBody}
                tagsByFileId={tagsByFileId}
                onOpenNote={(id) => openFileInPane(activePaneId, id)}
                indexing={vaultIndex}
                ensureIndexed={vaultIndex.ensureIndexed}
                indexVersion={vaultIndex.version}
              />
            )}
            {activeSideView === 'tags' && (
              <TagsPanel
                filesMeta={sync.filesMeta}
                getBody={vaultIndex.getBody}
                onOpenTag={(tag) => {
                  setActiveSideView('search');
                  setSearchQuery(`tag:${tag}`);
                }}
                indexing={vaultIndex}
                ensureIndexed={vaultIndex.ensureIndexed}
                indexVersion={vaultIndex.version}
              />
            )}
            {activeSideView === 'toc' && (
              <TocPanel
                file={activeFileForStatus}
                content={activeContentForStatus}
                onNavigate={handlers.onNavigateToHeading}
              />
            )}
            {activeSideView === 'bookmarks' && (
              <BookmarksPanel
                bookmarks={bookmarks}
                filesMeta={sync.filesMeta}
                onOpenFile={handleSidebarOpenFile}
                onOpenImage={handleSidebarOpenImage}
                onToggleBookmark={toggleBookmark}
              />
            )}
          </div>
          <div className="vault-footer">
            <span className="vault-footer-name">
              <IconFolder size={13} />
              {folder.name}
            </span>
            <div className="vault-footer-actions">
              <div className="accent-picker-anchor" ref={accentPickerAnchorRef}>
                <button
                  className="icon-btn"
                  title="Accent color"
                  onClick={() => setAccentPickerOpen((v) => !v)}
                >
                  <IconPalette size={15} />
                </button>
                {accentPickerOpen && (
                  <AccentColorPicker
                    accent={accentColor}
                    onChange={setAccentColor}
                    onClose={() => setAccentPickerOpen(false)}
                    anchorRef={accentPickerAnchorRef}
                    pickerRef={accentPickerPortalRef}
                  />
                )}
              </div>
              <button className="icon-btn" title="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
                <IconHelp size={15} />
              </button>
              <button className="icon-btn" title="Change store folder" onClick={handlePickFolder}>
                <IconSettings size={15} />
              </button>
            </div>
          </div>
        </div>
        <ResizeHandle direction="row" onResize={(dx) => setSideDockWidth((w) => Math.min(480, Math.max(200, w + dx)))} />
        <div className="dock-scrim" onClick={() => setMobileDockOpen(false)} />
        <div className="pane-area">
          <PaneNode
            node={paneTree}
            filesById={filesById}
            linkIndex={sync.linkIndex}
            phantomRecords={phantomRecords}
            buffers={buffers}
            activePaneId={activePaneId}
            onFocusPane={setActivePaneId}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onNewTab={(paneId) => {
              setActivePaneId(paneId);
              paletteForceNewTabRef.current = true;
              setPaletteMode('switcher');
            }}
            onSplitTab={splitTabDirect}
            onCloseOthers={closeOthers}
            onCloseAll={closeAllTabs}
            onSplit={splitPane}
            onClosePane={closePane}
            canClosePane={collectLeaves(paneTree).length > 1}
            onBack={(paneId) => navigateHistory(paneId, -1)}
            onForward={(paneId) => navigateHistory(paneId, 1)}
            onToggleMode={toggleTabMode}
            onChange={handleContentChange}
            handlers={handlers}
            backlinkIndex={sync.backlinkIndex}
            allFiles={sync.filesMeta}
            getBody={vaultIndex.getBody}
            bookmarks={bookmarks}
            onToggleBookmark={toggleBookmark}
            onResizeSplit={resizeSplit}
            onToggleDock={() => setMobileDockOpen((v) => !v)}
            pendingRowOpen={pendingRowOpen}
            onConsumeRowOpen={() => setPendingRowOpen(null)}
          />
        </div>
      </div>
      <StatusBar
        file={activeFileForStatus}
        content={activeContentForStatus}
        backlinkCount={activeBacklinkCount}
        syncing={sync.syncing}
        syncError={sync.syncError}
        dirty={activeTabForStatus ? !!buffers[activeTabForStatus.fileId]?.dirty : false}
        saving={activeTabForStatus ? !!buffers[activeTabForStatus.fileId]?.saving : false}
        selectionText={editorSelectionText}
        appVersion={appUpdate.version}
        updateAvailable={appUpdate.updateAvailable}
        onApplyUpdate={appUpdate.applyUpdate}
      />
      {paletteMode && (
        <Suspense fallback={null}>
          <PaletteModal
            mode={paletteMode}
            files={sync.filesMeta}
            commands={commands}
            onClose={() => setPaletteMode(null)}
            onPickFile={handlePaletteFilePick}
            onRunCommand={handlePaletteCommand}
          />
        </Suspense>
      )}
      {helpOpen && (
        <Suspense fallback={null}>
          <HelpModal onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
      {graphOpen && (
        <Suspense fallback={null}>
          <GraphViewModal
            onClose={() => setGraphOpen(false)}
            linkIndex={sync.linkIndex}
            linksByFileId={sync.linksByFileId}
            onOpenFile={handleSidebarOpenFile}
            activeFileId={activeFileForStatus?.id}
          />
        </Suspense>
      )}
      {showProxyFolderPicker && (
        <ProxyFolderBrowser
          token={token}
          onPick={handleProxyFolderPicked}
          onCancel={() => setShowProxyFolderPicker(false)}
          variant="modal"
        />
      )}
    </div>
  );
}
