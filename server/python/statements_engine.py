# ---------------------------------------------------------------------------
# Phrase-similarity engine backing sorter-enabled spark categories (see
# CLAUDE.md section 3.9 and this folder's README). Ported from the original
# CLI tool (temp/processing/statements/scripts/app.py): same scoring —
# semantic embedding cosine similarity + a custom word-alignment score +
# whole-phrase SequenceMatcher ratio, weighted and summed — and the same
# tie-break chain (first letter -> length -> formatting style -> syllable
# count). What changed moving from a one-shot CLI to a service:
#   - No disk-pickled similarity cache and no interactive tie-halt-and-ask —
#     an API call resolves ties itself via the same chain and returns a
#     result, it doesn't block on a human.
#   - Two new operations the CLI never had: sorted-insertion (place new
#     phrases into an already-sorted list without re-sorting everything) and
#     lookup (rank stored phrases by similarity to a query, not reorder).
#
# Caching: all caches below (_EMBEDDING_CACHE plus the four further down)
# are module-level, so they live for as long as this process stays warm —
# not just one request. That matters now more than it used to: the sorter
# is no longer tied to one hardcoded category, so the same corpus of
# phrases can come back across many sort/insert/lookup calls across
# multiple categories, and re-embedding (by far the most expensive step —
# a model forward pass, vs. the cheap pure-Python alignment/matcher scores)
# on every call would scale badly with that. Keyed by exact phrase text, so
# a cache hit only ever returns a value some prior call already computed
# for that exact string. Unbounded like the pre-existing caches below; see
# _maybe_trim_cache if that ever needs a real eviction policy instead of a
# blunt periodic clear.
# ---------------------------------------------------------------------------

import re
from difflib import SequenceMatcher

DEFAULT_WEIGHTS = {'semantic': 0.50, 'alignment': 0.30, 'phrase_matcher': 0.20}

_MODEL = None
_EMBEDDING_CACHE = {}
_WORD_SIM_CACHE = {}
_ALIGNMENT_CACHE = {}
_SYLLABLE_CACHE = {}
_PAIR_SCORE_CACHE = {}

# Rough cap so a long-running process handling many distinct phrases over
# time doesn't grow these dicts unboundedly. Not an LRU — just a full clear
# once a cache gets big, cheap re-warming since embedding is the only
# genuinely slow part and even that's fast per-phrase once the model is
# loaded.
_MAX_CACHE_ENTRIES = 20000

TOKEN_RE = re.compile(r'[^\w\s]')


def _maybe_trim_cache(cache):
    if len(cache) > _MAX_CACHE_ENTRIES:
        cache.clear()


def load_model():
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer
        _MODEL = SentenceTransformer('all-MiniLM-L6-v2')
    return _MODEL


def embed(phrases):
    """Encodes phrases to embeddings, reusing _EMBEDDING_CACHE for any
    phrase (exact string match) already embedded by a prior call — only
    genuinely new phrases hit the model. Returns a tensor stacked in the
    same order as the input, matching the old encode()-only behavior."""
    import torch

    phrases = list(phrases)
    to_encode = [p for p in phrases if p not in _EMBEDDING_CACHE]
    if to_encode:
        _maybe_trim_cache(_EMBEDDING_CACHE)
        new_embs = load_model().encode(to_encode, convert_to_tensor=True, show_progress_bar=False)
        for p, e in zip(to_encode, new_embs):
            _EMBEDDING_CACHE[p] = e
    return torch.stack([_EMBEDDING_CACHE[p] for p in phrases])


def _cos_sim_row(anchor_emb, other_embs):
    from sentence_transformers import util
    return util.cos_sim(anchor_emb.unsqueeze(0), other_embs)[0]


def _cos_sim_one(a, b):
    from sentence_transformers import util
    return float(util.cos_sim(a.unsqueeze(0), b.unsqueeze(0))[0][0])


def tokenize(phrase):
    return tuple(TOKEN_RE.sub('', phrase).lower().split())


def normalize(phrase):
    return ' '.join(TOKEN_RE.sub('', phrase).lower().split())


def formatting_density(phrase):
    return len(re.sub(r'[\w\s]', '', phrase)) + sum(1 for c in phrase if c.isupper())


def compute_metadata(phrase):
    return {
        'first_char': phrase[0].lower() if phrase else '',
        'length': len(phrase),
        'formatting_style': ''.join(c for c in phrase if not c.islower() and not c.isspace())
    }


def dedupe(phrases):
    """Groups phrases by normalized form, keeps the highest-"formatting
    density" variant per group, preserves first-seen order — same rule as
    the original CLI's unique_groups pass."""
    kept = {}
    order = []
    for p in phrases:
        p = (p or '').strip()
        if not p:
            continue
        norm = normalize(p)
        if norm not in kept:
            kept[norm] = p
            order.append(norm)
        elif formatting_density(p) > formatting_density(kept[norm]):
            kept[norm] = p
    return [kept[n] for n in order]


def cached_sequence_matcher(w1, w2):
    key = (w1, w2)
    if key not in _WORD_SIM_CACHE:
        _maybe_trim_cache(_WORD_SIM_CACHE)
        _WORD_SIM_CACHE[key] = SequenceMatcher(None, w1, w2).ratio()
    return _WORD_SIM_CACHE[key]


def compute_custom_alignment(words1, words2):
    key = (words1, words2)
    if key in _ALIGNMENT_CACHE:
        return _ALIGNMENT_CACHE[key]
    len1, len2 = len(words1), len(words2)
    if len1 == 0 or len2 == 0:
        return 0.0
    total = 0.0
    for i, w1 in enumerate(words1):
        rel_pos1 = i / len1 if len1 > 1 else 0.0
        best = -1.0
        for j, w2 in enumerate(words2):
            rel_pos2 = j / len2 if len2 > 1 else 0.0
            word_sim = cached_sequence_matcher(w1, w2)
            if word_sim > 0.4:
                contribution = word_sim * (1.0 - (2.0 * abs(rel_pos1 - rel_pos2)))
                if contribution > best:
                    best = contribution
        if best != -1.0:
            total += best
    res = max(-1.0, min(1.0, total / len1))
    _maybe_trim_cache(_ALIGNMENT_CACHE)
    _ALIGNMENT_CACHE[key] = res
    return res


def estimate_syllables(text):
    if text in _SYLLABLE_CACHE:
        return _SYLLABLE_CACHE[text]
    count = 0
    for word in re.findall(r'[a-z]+', text.lower()):
        vowels = re.findall(r'[aeiouy]+', word)
        n = len(vowels)
        if word.endswith('e') and n > 1:
            n -= 1
        count += max(1, n)
    _maybe_trim_cache(_SYLLABLE_CACHE)
    _SYLLABLE_CACHE[text] = count
    return count


def pairwise_score(p1, p2, semantic_score, weights):
    key = (p1, p2, weights['semantic'], weights['alignment'], weights['phrase_matcher'])
    if key in _PAIR_SCORE_CACHE:
        return _PAIR_SCORE_CACHE[key]
    alignment = compute_custom_alignment(tokenize(p1), tokenize(p2))
    matcher = SequenceMatcher(None, p1, p2).ratio()
    score = max(0.0, semantic_score * weights['semantic'] + alignment * weights['alignment'] + matcher * weights['phrase_matcher'])
    _maybe_trim_cache(_PAIR_SCORE_CACHE)
    _PAIR_SCORE_CACHE[key] = score
    return score


def _break_tie(anchor_phrase, anchor_meta, idxs, phrases, metas):
    if anchor_meta['first_char']:
        matches = [i for i in idxs if metas[i]['first_char'] == anchor_meta['first_char']]
        if matches:
            idxs = matches
    if len(idxs) > 1:
        target = anchor_meta['length']
        min_diff = min(abs(metas[i]['length'] - target) for i in idxs)
        idxs = [i for i in idxs if abs(metas[i]['length'] - target) == min_diff]
    if len(idxs) > 1:
        best_fmt, fmt_idxs = -1.0, []
        for i in idxs:
            s = cached_sequence_matcher(anchor_meta['formatting_style'], metas[i]['formatting_style'])
            if abs(s - best_fmt) < 1e-9:
                fmt_idxs.append(i)
            elif s > best_fmt:
                best_fmt, fmt_idxs = s, [i]
        idxs = fmt_idxs
    if len(idxs) > 1:
        target = estimate_syllables(anchor_phrase)
        min_diff = min(abs(estimate_syllables(phrases[i]) - target) for i in idxs)
        idxs = [i for i in idxs if abs(estimate_syllables(phrases[i]) - target) == min_diff]
    return idxs


def _best_candidate(anchor_phrase, anchor_emb, cand_phrases, cand_embs, weights):
    """Highest-scoring entry in cand_phrases/cand_embs against the anchor,
    ties resolved by the same chain the sort loop uses. Returns
    (index_into_candidates, score)."""
    sims = _cos_sim_row(anchor_emb, cand_embs)
    scores = [pairwise_score(anchor_phrase, p, max(0.0, min(1.0, float(sims[i]))), weights) for i, p in enumerate(cand_phrases)]
    best = max(scores)
    best_idxs = [i for i, s in enumerate(scores) if abs(s - best) < 1e-9]
    if len(best_idxs) > 1:
        metas = [compute_metadata(p) for p in cand_phrases]
        best_idxs = _break_tie(anchor_phrase, compute_metadata(anchor_phrase), best_idxs, cand_phrases, metas)
    return best_idxs[0], scores[best_idxs[0]]


def sort_phrases(phrases, weights=None):
    """Dedupes, then greedily chains phrases by "most similar to the phrase
    just placed" — same nearest-neighbor-chain shape as the original CLI's
    custom_similarity_sort, minus its live telemetry (no terminal to draw
    to) and its halt-on-tie (a chain-build tie is resolved instead of
    stopping — see _break_tie)."""
    weights = weights or DEFAULT_WEIGHTS
    deduped = dedupe(phrases)
    if len(deduped) <= 1:
        return deduped
    embeddings = embed(deduped)
    order = [0]
    remaining = list(range(1, len(deduped)))
    while remaining:
        anchor_idx = order[-1]
        cand_phrases = [deduped[i] for i in remaining]
        cand_embs = embeddings[remaining]
        local_idx, _ = _best_candidate(deduped[anchor_idx], embeddings[anchor_idx], cand_phrases, cand_embs, weights)
        order.append(remaining.pop(local_idx))
    return [deduped[i] for i in order]


def insert_phrases(existing_phrases, new_phrases, weights=None):
    """Places each new phrase into an already-sorted list one at a time:
    duplicate-checked against the working list with the same normalize +
    formatting-density rule dedupe() uses (a denser duplicate replaces the
    stored one in place; a plainer one is skipped), then anchored to
    whichever existing phrase scores highest against it, then placed on
    whichever side of that anchor — before or after — has the
    higher-scoring neighbor (a missing neighbor never wins, so an anchor at
    either end of the list resolves to the open side)."""
    weights = weights or DEFAULT_WEIGHTS
    working = list(existing_phrases)
    results = []
    for raw in new_phrases:
        phrase = (raw or '').strip()
        if not phrase:
            continue
        norm = normalize(phrase)
        dup_idx = next((i for i, p in enumerate(working) if normalize(p) == norm), None)
        if dup_idx is not None:
            if formatting_density(phrase) > formatting_density(working[dup_idx]):
                results.append({'phrase': phrase, 'action': 'replaced_duplicate', 'position': dup_idx, 'previous': working[dup_idx]})
                working[dup_idx] = phrase
            else:
                results.append({'phrase': phrase, 'action': 'skipped_duplicate', 'matched': working[dup_idx]})
            continue

        if not working:
            working.append(phrase)
            results.append({'phrase': phrase, 'action': 'inserted', 'position': 0})
            continue

        embeddings = embed([phrase] + working)
        phrase_emb, existing_embs = embeddings[0], embeddings[1:]
        anchor_idx, anchor_score = _best_candidate(phrase, phrase_emb, working, existing_embs, weights)

        left_score = pairwise_score(phrase, working[anchor_idx - 1], _cos_sim_one(phrase_emb, existing_embs[anchor_idx - 1]), weights) if anchor_idx > 0 else float('-inf')
        right_score = (
            pairwise_score(phrase, working[anchor_idx + 1], _cos_sim_one(phrase_emb, existing_embs[anchor_idx + 1]), weights)
            if anchor_idx + 1 < len(working)
            else float('-inf')
        )
        insert_at = anchor_idx if left_score > right_score else anchor_idx + 1
        working.insert(insert_at, phrase)
        results.append({'phrase': phrase, 'action': 'inserted', 'position': insert_at, 'anchor': working[anchor_idx if insert_at > anchor_idx else anchor_idx + 1], 'score': anchor_score})

    return working, results


def lookup_similar(query_phrases, corpus_phrases, n=5, weights=None):
    """For each query phrase, the N stored phrases scored highest against
    it — a read-only rank, not a reorder (unlike sort/insert)."""
    weights = weights or DEFAULT_WEIGHTS
    n = max(1, int(n or 5))
    results = []
    corpus_embs = embed(corpus_phrases) if corpus_phrases else None
    for raw in query_phrases:
        q = (raw or '').strip()
        if not q:
            continue
        if not corpus_phrases:
            results.append({'query': q, 'matches': []})
            continue
        q_emb = embed([q])[0]
        sims = _cos_sim_row(q_emb, corpus_embs)
        scored = [(pairwise_score(q, p, max(0.0, min(1.0, float(sims[i]))), weights), p) for i, p in enumerate(corpus_phrases)]
        scored.sort(key=lambda x: x[0], reverse=True)
        results.append({'query': q, 'matches': [{'phrase': p, 'score': s} for s, p in scored[:n]]})
    return results


_SPELLCHECKER = None
WORD_RE = re.compile(r"[A-Za-z']+")


def spellcheck_phrases(phrases):
    global _SPELLCHECKER
    if _SPELLCHECKER is None:
        from spellchecker import SpellChecker
        _SPELLCHECKER = SpellChecker()
    results = []
    for phrase in phrases:
        phrase = (phrase or '').strip()
        if not phrase:
            continue
        issues = []
        for word in WORD_RE.findall(phrase):
            lower = word.lower()
            if len(lower) < 2 or lower in _SPELLCHECKER:
                continue
            candidates = sorted(_SPELLCHECKER.candidates(lower) or [])[:5]
            issues.append({'word': word, 'suggestion': _SPELLCHECKER.correction(lower), 'candidates': candidates})
        results.append({'phrase': phrase, 'issues': issues})
    return results
