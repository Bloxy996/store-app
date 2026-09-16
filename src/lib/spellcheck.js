// ---------------------------------------------------------------------------
// In-browser replacement for the removed server/python/statements_engine.py
// spellcheck_phrases() (formerly pyspellchecker — a Norvig
// edit-distance/word-frequency-list checker). Uses nspell (a Hunspell-based
// port) with the `dictionary-en` word list — a different underlying
// algorithm and dictionary, so suggestions won't match the old service
// word-for-word; an accepted tradeoff (see statementsEngine.js's header),
// not an oversight.
//
// nspell's own constructor takes the raw .aff/.dic file contents directly
// (string or Buffer) rather than needing dictionary-en's bundled loader
// function, which reads via Node's `fs` and doesn't run in a browser build.
// So the two files are imported as Vite static assets (`?url`) and fetched
// lazily on first use, instead of importing `dictionary-en` itself as code.
// That also means the ~550KB word list is only downloaded if/when
// spellcheck is actually used, not bundled into the app shell — the same
// "outside the hot path" treatment CLAUDE.md section 4 gives graph/database/
// canvas/vector.
// ---------------------------------------------------------------------------

import nspell from 'nspell';
import affUrl from 'dictionary-en/index.aff?url';
import dicUrl from 'dictionary-en/index.dic?url';

const WORD_RE = /[A-Za-z']+/g;

let spellerPromise = null;

function loadSpeller() {
  if (!spellerPromise) {
    spellerPromise = Promise.all([fetch(affUrl).then((r) => r.text()), fetch(dicUrl).then((r) => r.text())]).then(
      ([aff, dic]) => nspell(aff, dic)
    );
  }
  return spellerPromise;
}

async function spellcheckPhrases(phrases) {
  const speller = await loadSpeller();
  const results = [];
  for (const raw of phrases) {
    const phrase = (raw || '').trim();
    if (!phrase) continue;
    const issues = [];
    const words = phrase.match(WORD_RE) || [];
    for (const word of words) {
      const lower = word.toLowerCase();
      if (lower.length < 2 || speller.correct(lower)) continue;
      const candidates = (speller.suggest(lower) || []).slice(0, 5).sort();
      issues.push({ word, suggestion: candidates[0] || null, candidates });
    }
    results.push({ phrase, issues });
  }
  return results;
}

export { spellcheckPhrases };
