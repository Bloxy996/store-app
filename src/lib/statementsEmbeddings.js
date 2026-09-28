// ---------------------------------------------------------------------------
// In-browser replacement for the removed server/python/statements_engine.py
// embed() (formerly sentence-transformers/all-MiniLM-L6-v2 running under
// PyTorch, in a long-running Python process kept warm specifically so the
// model didn't need reloading per request). Runs the exact
// same model, converted to ONNX (Xenova/all-MiniLM-L6-v2), via
// @xenova/transformers' in-browser WASM/WebGPU runtime — no server
// round-trip, no separate host to keep warm.
//
// Model weights are fetched from Hugging Face's CDN on first use and cached
// by @xenova/transformers itself via the browser's Cache Storage API (a
// separate mechanism from the service worker's workbox cache in
// vite.config.js) — so this needs network access to huggingface.co (or a
// configured mirror, see env.remoteHost below) the first time, but not on
// later sessions. That's a new runtime network dependency the old
// Vercel/Render deploy never had; worth confirming huggingface.co is
// reachable from wherever this ships.
//
// Caching: module-level Map keyed by exact phrase text, same shape as the
// removed _EMBEDDING_CACHE. Lives only as long as this tab/session does
// (unlike the old warm Python process) — re-embedding on a fresh session is
// cheap per-phrase (per the original code's own comment) once the model
// itself is loaded, so this hasn't been backed by IndexedDB; revisit if
// profiling ever shows otherwise (see statementsEngine.js's header for the
// same reasoning applied to the pure-JS caches).
// ---------------------------------------------------------------------------

import { pipeline, env } from '@xenova/transformers';

// Fetch models from the default remote host rather than expecting local
// model files bundled into the app; let the library manage its own
// browser-cache of the downloaded weights.
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MAX_CACHE_ENTRIES = 20000;

let extractorPromise = null;
const embeddingCache = new Map();

function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL_ID);
  }
  return extractorPromise;
}

function maybeTrimCache() {
  if (embeddingCache.size > MAX_CACHE_ENTRIES) embeddingCache.clear();
}

// Encodes phrases to embeddings (Float32Array per phrase, mean-pooled +
// L2-normalized), reusing embeddingCache for any phrase already embedded
// this session — only genuinely new phrases hit the model. Returns an
// array of Float32Array in the same order as the input, matching the old
// embed()'s "stacked in input order" behavior.
async function embed(phrases) {
  phrases = Array.from(phrases);
  const toEncode = phrases.filter((p) => !embeddingCache.has(p));
  if (toEncode.length) {
    maybeTrimCache();
    const extractor = await loadExtractor();
    for (const phrase of toEncode) {
      const output = await extractor(phrase, { pooling: 'mean', normalize: true });
      embeddingCache.set(phrase, Float32Array.from(output.data));
    }
  }
  return phrases.map((p) => embeddingCache.get(p));
}

// Cosine similarity between two embeddings. embed() already L2-normalizes,
// so this is really just a dot product, but computed generally in case
// that ever changes.
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Cosine similarity of one embedding against a list of others — mirrors
// the removed Python version's _cos_sim_row.
function cosineSimilarityRow(anchorEmb, otherEmbs) {
  return otherEmbs.map((e) => cosineSimilarity(anchorEmb, e));
}

export { embed, cosineSimilarity, cosineSimilarityRow };
