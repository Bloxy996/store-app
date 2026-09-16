// ---------------------------------------------------------------------------
// Which spark categories are "sorter" categories — i.e. their sparks are
// kept in a similarity-sorted order (via the Python service's phrase-sort
// engine, server/python/statements_engine.py) instead of being browsed by
// capture time like a normal category (see CategorySorterPanel.jsx).
//
// This used to be one hardcoded category ("statements"). Now it's a set the
// user builds themselves — any category can be toggled in or out from the
// Sparks panel's category tree, and more than one can be enabled at once,
// each sorted independently. Persisted in localStorage alongside the app's
// other settings (CLAUDE.md 3.1).
//
// A category with sub-categories nested under it (e.g. "phrases/quotes"
// under "phrases") only sorts sparks filed directly under its own exact
// path — a nested category is a separate category, independently
// toggleable. That's enforced by exact-match filtering in
// CategorySorterPanel.jsx, not here; this module only tracks which paths
// are marked.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'store-sorted-spark-categories';

// Back-compat default for anyone upgrading from before the sorter was
// generalized, when this was the one hardcoded category — so existing
// "statements" sparks keep sorting the same way with no manual step.
const DEFAULT_SORTED_CATEGORIES = ['statements'];

function loadSortedCategories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set(DEFAULT_SORTED_CATEGORIES);
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : []);
  } catch {
    return new Set(DEFAULT_SORTED_CATEGORIES);
  }
}

function saveSortedCategories(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // localStorage unavailable (private browsing etc.) — the toggle just
    // won't persist across reloads; not worth surfacing an error for.
  }
}

// Flips one category's membership and persists the result, returning the
// new Set so callers can put it straight into state.
function toggleSortedCategory(path) {
  const set = loadSortedCategories();
  if (set.has(path)) set.delete(path);
  else set.add(path);
  saveSortedCategories(set);
  return set;
}

export { loadSortedCategories, saveSortedCategories, toggleSortedCategory };
