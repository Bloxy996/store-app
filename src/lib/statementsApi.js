import { BACKEND_URL } from './vaultConfig.js';

// Thin wrappers around /api/statements/* (server/src/routes/statements.js,
// which proxies to the Python service — server/python/README.md). Every
// call needs credentials: 'include' for the same session-cookie reason as
// driveApi.js's backend calls.
async function postJson(path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Statements request failed (${res.status})`);
  return data;
}

// Full re-sort of a phrase list — returns the new order. Used for
// "re-sort everything" rather than the normal add-phrases flow, which
// uses insertStatements instead so existing order isn't disturbed.
function sortStatements(phrases, weights) {
  return postJson('/api/statements/sort', { phrases, weights }).then((d) => d.phrases);
}

// { phrases, results } — results has one entry per input phrase:
// { phrase, action: 'inserted'|'replaced_duplicate'|'skipped_duplicate', ... }
function insertStatements(existing, newPhrases, weights) {
  return postJson('/api/statements/insert', { existing, newPhrases, weights });
}

function lookupStatements(queries, corpus, n, weights) {
  return postJson('/api/statements/lookup', { queries, corpus, n, weights }).then((d) => d.results);
}

function spellcheckStatements(phrases) {
  return postJson('/api/statements/spellcheck', { phrases }).then((d) => d.results);
}

export { sortStatements, insertStatements, lookupStatements, spellcheckStatements };
