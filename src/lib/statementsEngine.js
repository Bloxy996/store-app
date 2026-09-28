// ---------------------------------------------------------------------------
// Phrase-similarity engine backing sorter-enabled spark categories (see
// CLAUDE.md section 3.9). Ported from the removed server/python/
// statements_engine.py to run client-side — same scoring shape: semantic
// embedding cosine similarity + a custom word-alignment score + whole-phrase
// string-similarity ratio, weighted and summed — and the same tie-break
// chain (first letter -> length -> formatting style -> syllable count).
//
// Deliberate differences from the removed Python version (an exact
// algorithmic match wasn't required):
//   - Whole-phrase and word-level similarity ratios now come from the
//     `string-similarity-js` package (Dice coefficient over character
//     bigrams) instead of Python's difflib.SequenceMatcher
//     (Ratcliff/Obershelp gestalt matching). Both are "0 = nothing alike,
//     1 = identical" ratios but are NOT numerically identical, so
//     DEFAULT_WEIGHTS below were adjusted slightly for the new scale (see
//     this file's README note in server/README.md's replacement).
//   - Embeddings come from @xenova/transformers running the same
//     all-MiniLM-L6-v2 model as an ONNX build, in-browser — see
//     statementsEmbeddings.js.
//   - Spellcheck (spellcheck.js, not in this file) uses nspell +
//     dictionary-en (Hunspell-based) instead of pyspellchecker (Norvig
//     frequency-list based) — different suggestions, same result shape.
//
// Caching: the caches below mirror the Python version's remaining
// module-level caches (word-similarity, alignment, syllables, pairwise
// score) — same unbounded-with-periodic-clear approach, same
// MAX_CACHE_ENTRIES threshold. Embedding caching lives in
// statementsEmbeddings.js instead, since it's tied to the model/tensor
// lifecycle rather than being pure-JS state.
// ---------------------------------------------------------------------------

import { stringSimilarity } from 'string-similarity-js';

import { embed, cosineSimilarityRow, cosineSimilarity } from './statementsEmbeddings.js';

const DEFAULT_WEIGHTS = { semantic: 0.5, alignment: 0.3, phraseMatcher: 0.2 };

const MAX_CACHE_ENTRIES = 20000;
const wordSimCache = new Map();
const alignmentCache = new Map();
const syllableCache = new Map();
const pairScoreCache = new Map();

const TOKEN_RE = /[^\w\s]/g;

function maybeTrimCache(cache) {
  if (cache.size > MAX_CACHE_ENTRIES) cache.clear();
}

function tokenize(phrase) {
  return phrase.replace(TOKEN_RE, '').toLowerCase().split(/\s+/).filter(Boolean);
}

function normalize(phrase) {
  return phrase.replace(TOKEN_RE, '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function formattingDensity(phrase) {
  const stripped = phrase.replace(/[\w\s]/g, '').length;
  let upper = 0;
  for (const c of phrase) if (c !== c.toLowerCase() && c === c.toUpperCase()) upper++;
  return stripped + upper;
}

// Mirrors Python's ''.join(c for c in phrase if not c.islower() and not
// c.isspace()) — "not lowercase" means uppercase letters, digits, and
// punctuation all count; only actual lowercase letters are excluded.
function computeMetadata(phrase) {
  let style = '';
  for (const c of phrase) {
    if (/\s/.test(c)) continue;
    const isLowerLetter = /[a-z]/.test(c) && c === c.toLowerCase() && c !== c.toUpperCase();
    if (!isLowerLetter) style += c;
  }
  return {
    firstChar: phrase ? phrase[0].toLowerCase() : '',
    length: phrase.length,
    formattingStyle: style
  };
}

// Groups phrases by normalized form, keeps the highest-formatting-density
// variant per group, preserves first-seen order — same rule as the removed
// Python version's dedupe().
function dedupe(phrases) {
  const kept = new Map();
  const order = [];
  for (const raw of phrases) {
    const p = (raw || '').trim();
    if (!p) continue;
    const norm = normalize(p);
    if (!kept.has(norm)) {
      kept.set(norm, p);
      order.push(norm);
    } else if (formattingDensity(p) > formattingDensity(kept.get(norm))) {
      kept.set(norm, p);
    }
  }
  return order.map((n) => kept.get(n));
}

function cachedStringSimilarity(w1, w2) {
  const key = `${w1}\u0000${w2}`;
  if (!wordSimCache.has(key)) {
    maybeTrimCache(wordSimCache);
    wordSimCache.set(key, stringSimilarity(w1, w2));
  }
  return wordSimCache.get(key);
}

function computeCustomAlignment(words1, words2) {
  const key = `${words1.join('\u0001')}\u0000${words2.join('\u0001')}`;
  if (alignmentCache.has(key)) return alignmentCache.get(key);
  const len1 = words1.length;
  const len2 = words2.length;
  if (len1 === 0 || len2 === 0) return 0.0;
  let total = 0.0;
  for (let i = 0; i < len1; i++) {
    const w1 = words1[i];
    const relPos1 = len1 > 1 ? i / len1 : 0.0;
    let best = -1.0;
    for (let j = 0; j < len2; j++) {
      const w2 = words2[j];
      const relPos2 = len2 > 1 ? j / len2 : 0.0;
      const wordSim = cachedStringSimilarity(w1, w2);
      if (wordSim > 0.4) {
        const contribution = wordSim * (1.0 - 2.0 * Math.abs(relPos1 - relPos2));
        if (contribution > best) best = contribution;
      }
    }
    if (best !== -1.0) total += best;
  }
  const res = Math.max(-1.0, Math.min(1.0, total / len1));
  maybeTrimCache(alignmentCache);
  alignmentCache.set(key, res);
  return res;
}

function estimateSyllables(text) {
  if (syllableCache.has(text)) return syllableCache.get(text);
  let count = 0;
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const word of words) {
    const vowelGroups = word.match(/[aeiouy]+/g) || [];
    let n = vowelGroups.length;
    if (word.endsWith('e') && n > 1) n -= 1;
    count += Math.max(1, n);
  }
  maybeTrimCache(syllableCache);
  syllableCache.set(text, count);
  return count;
}

function pairwiseScore(p1, p2, semanticScore, weights) {
  const key = `${p1}\u0000${p2}\u0000${weights.semantic}\u0000${weights.alignment}\u0000${weights.phraseMatcher}`;
  if (pairScoreCache.has(key)) return pairScoreCache.get(key);
  const alignment = computeCustomAlignment(tokenize(p1), tokenize(p2));
  const matcher = stringSimilarity(p1, p2);
  const score = Math.max(
    0.0,
    semanticScore * weights.semantic + alignment * weights.alignment + matcher * weights.phraseMatcher
  );
  maybeTrimCache(pairScoreCache);
  pairScoreCache.set(key, score);
  return score;
}

function breakTie(anchorPhrase, anchorMeta, idxsIn, phrases, metas) {
  let idxs = idxsIn;
  if (anchorMeta.firstChar) {
    const matches = idxs.filter((i) => metas[i].firstChar === anchorMeta.firstChar);
    if (matches.length) idxs = matches;
  }
  if (idxs.length > 1) {
    const target = anchorMeta.length;
    const minDiff = Math.min(...idxs.map((i) => Math.abs(metas[i].length - target)));
    idxs = idxs.filter((i) => Math.abs(metas[i].length - target) === minDiff);
  }
  if (idxs.length > 1) {
    let bestFmt = -1.0;
    let fmtIdxs = [];
    for (const i of idxs) {
      const s = cachedStringSimilarity(anchorMeta.formattingStyle, metas[i].formattingStyle);
      if (Math.abs(s - bestFmt) < 1e-9) {
        fmtIdxs.push(i);
      } else if (s > bestFmt) {
        bestFmt = s;
        fmtIdxs = [i];
      }
    }
    idxs = fmtIdxs;
  }
  if (idxs.length > 1) {
    const target = estimateSyllables(anchorPhrase);
    const minDiff = Math.min(...idxs.map((i) => Math.abs(estimateSyllables(phrases[i]) - target)));
    idxs = idxs.filter((i) => Math.abs(estimateSyllables(phrases[i]) - target) === minDiff);
  }
  return idxs;
}

// Highest-scoring entry in candPhrases/candEmbs against the anchor, ties
// resolved by the same chain the sort loop uses. Returns
// [indexIntoCandidates, score].
function bestCandidate(anchorPhrase, anchorEmb, candPhrases, candEmbs, weights) {
  const sims = cosineSimilarityRow(anchorEmb, candEmbs);
  const scores = candPhrases.map((p, i) => pairwiseScore(anchorPhrase, p, Math.max(0.0, Math.min(1.0, sims[i])), weights));
  const best = Math.max(...scores);
  let bestIdxs = scores.map((s, i) => i).filter((i) => Math.abs(scores[i] - best) < 1e-9);
  if (bestIdxs.length > 1) {
    const metas = candPhrases.map((p) => computeMetadata(p));
    bestIdxs = breakTie(anchorPhrase, computeMetadata(anchorPhrase), bestIdxs, candPhrases, metas);
  }
  return [bestIdxs[0], scores[bestIdxs[0]]];
}

// Dedupes, then greedily chains phrases by "most similar to the phrase just
// placed" — same nearest-neighbor-chain shape as the removed Python
// version's sort_phrases. A chain-build tie is resolved via breakTie rather
// than halting (the CLI it was originally ported from halted on ties and
// asked a human; the service version — Python or this one — never did).
async function sortPhrases(phrases, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  const deduped = dedupe(phrases);
  if (deduped.length <= 1) return deduped;
  const embeddings = await embed(deduped);
  const order = [0];
  let remaining = deduped.map((_, i) => i).slice(1);
  while (remaining.length) {
    const anchorIdx = order[order.length - 1];
    const candPhrases = remaining.map((i) => deduped[i]);
    const candEmbs = remaining.map((i) => embeddings[i]);
    const [localIdx] = bestCandidate(deduped[anchorIdx], embeddings[anchorIdx], candPhrases, candEmbs, w);
    order.push(remaining[localIdx]);
    remaining = remaining.filter((_, i) => i !== localIdx);
  }
  return order.map((i) => deduped[i]);
}

// Places each new phrase into an already-sorted list one at a time:
// duplicate-checked against the working list with the same normalize +
// formatting-density rule dedupe() uses (a denser duplicate replaces the
// stored one in place; a plainer one is skipped), then anchored to
// whichever existing phrase scores highest against it, then placed on
// whichever side of that anchor — before or after — has the higher-scoring
// neighbor (a missing neighbor never wins, so an anchor at either end of
// the list resolves to the open side). Returns [workingList, results],
// mirroring the removed Python version's (working, results) tuple.
async function insertPhrases(existingPhrases, newPhrases, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  const working = existingPhrases.slice();
  const results = [];
  for (const raw of newPhrases) {
    const phrase = (raw || '').trim();
    if (!phrase) continue;
    const norm = normalize(phrase);
    const dupIdx = working.findIndex((p) => normalize(p) === norm);
    if (dupIdx !== -1) {
      if (formattingDensity(phrase) > formattingDensity(working[dupIdx])) {
        results.push({ phrase, action: 'replaced_duplicate', position: dupIdx, previous: working[dupIdx] });
        working[dupIdx] = phrase;
      } else {
        results.push({ phrase, action: 'skipped_duplicate', matched: working[dupIdx] });
      }
      continue;
    }

    if (!working.length) {
      working.push(phrase);
      results.push({ phrase, action: 'inserted', position: 0 });
      continue;
    }

    const embeddings = await embed([phrase, ...working]);
    const phraseEmb = embeddings[0];
    const existingEmbs = embeddings.slice(1);
    const [anchorIdx, anchorScore] = bestCandidate(phrase, phraseEmb, working, existingEmbs, w);

    const leftScore =
      anchorIdx > 0
        ? pairwiseScore(phrase, working[anchorIdx - 1], cosineSimilarity(phraseEmb, existingEmbs[anchorIdx - 1]), w)
        : -Infinity;
    const rightScore =
      anchorIdx + 1 < working.length
        ? pairwiseScore(phrase, working[anchorIdx + 1], cosineSimilarity(phraseEmb, existingEmbs[anchorIdx + 1]), w)
        : -Infinity;
    const insertAt = leftScore > rightScore ? anchorIdx : anchorIdx + 1;
    working.splice(insertAt, 0, phrase);
    results.push({
      phrase,
      action: 'inserted',
      position: insertAt,
      anchor: working[insertAt > anchorIdx ? anchorIdx : anchorIdx + 1],
      score: anchorScore
    });
  }

  return [working, results];
}

// For each query phrase, the N stored phrases scored highest against it —
// a read-only rank, not a reorder (unlike sort/insert).
async function lookupSimilar(queryPhrases, corpusPhrases, n, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  const count = Math.max(1, Number(n) || 5);
  const results = [];
  const corpusEmbs = corpusPhrases.length ? await embed(corpusPhrases) : null;
  for (const raw of queryPhrases) {
    const q = (raw || '').trim();
    if (!q) continue;
    if (!corpusPhrases.length) {
      results.push({ query: q, matches: [] });
      continue;
    }
    const [qEmb] = await embed([q]);
    const sims = cosineSimilarityRow(qEmb, corpusEmbs);
    const scored = corpusPhrases.map((p, i) => [
      pairwiseScore(q, p, Math.max(0.0, Math.min(1.0, sims[i])), w),
      p
    ]);
    scored.sort((a, b) => b[0] - a[0]);
    results.push({ query: q, matches: scored.slice(0, count).map(([score, phrase]) => ({ phrase, score })) });
  }
  return results;
}

export { DEFAULT_WEIGHTS, sortPhrases, insertPhrases, lookupSimilar };
