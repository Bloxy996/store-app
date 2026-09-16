// Client-side replacement for the removed /api/statements/* backend (Node
// proxy -> separate Python service, sentence-transformers/torch). Same
// exported functions and return shapes as before — CategorySorterPanel.jsx
// doesn't need to change — now computed in-browser instead of over the
// network. See statementsEngine.js, statementsEmbeddings.js, spellcheck.js.
import { sortPhrases, insertPhrases, lookupSimilar } from './statementsEngine.js';
import { spellcheckPhrases } from './spellcheck.js';

// Full re-sort of a phrase list — returns the new order. Used for
// "re-sort everything" rather than the normal add-phrases flow, which
// uses insertStatements instead so existing order isn't disturbed.
function sortStatements(phrases, weights) {
  return sortPhrases(phrases, weights);
}

// { phrases, results } — results has one entry per input phrase:
// { phrase, action: 'inserted'|'replaced_duplicate'|'skipped_duplicate', ... }
function insertStatements(existing, newPhrases, weights) {
  return insertPhrases(existing, newPhrases, weights).then(([phrases, results]) => ({ phrases, results }));
}

function lookupStatements(queries, corpus, n, weights) {
  return lookupSimilar(queries, corpus, n, weights);
}

function spellcheckStatements(phrases) {
  return spellcheckPhrases(phrases);
}

export { sortStatements, insertStatements, lookupStatements, spellcheckStatements };
