import { DEFAULT_FORCES } from './useForceGraph.js';

// ---------------------------------------------------------------------------
// Graph View preferences — Obsidian keeps the equivalent of this in
// .obsidian/graph.json so filters/forces/groups survive between sessions;
// same idea here via localStorage (same mechanism as accent color and the
// frontmatter schema — this is view preference, not vault content, so it
// doesn't touch section 3.1's Drive-content rule).
// ---------------------------------------------------------------------------
const GRAPH_SETTINGS_KEY = 'vault_graph_settings';

const DEFAULT_GRAPH_SETTINGS = {
  showAttachments: false,
  hideOrphans: false,
  localMode: false,
  localDepth: 1,
  forces: DEFAULT_FORCES,
  groups: [] // { id, query, color }
};

function loadGraphSettings() {
  try {
    const raw = localStorage.getItem(GRAPH_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_GRAPH_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_GRAPH_SETTINGS,
      ...parsed,
      forces: { ...DEFAULT_FORCES, ...(parsed?.forces || {}) },
      groups: Array.isArray(parsed?.groups) ? parsed.groups : []
    };
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

function saveGraphSettings(settings) {
  try {
    localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Unavailable storage just means it won't persist across sessions —
    // same tradeoff as every other localStorage-backed preference here.
  }
}

export { GRAPH_SETTINGS_KEY, DEFAULT_GRAPH_SETTINGS, loadGraphSettings, saveGraphSettings };
