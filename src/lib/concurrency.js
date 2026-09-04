
// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------
// Runs `worker` over `items` with at most `limit` in flight at once,
// preserving each result's original position. A single slow/failing item
// only occupies one of the `limit` lanes — the rest keep moving. Returns
// { ok, value } or { ok: false, error } per item (never throws itself).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}


// Small retry wrapper for transient Drive errors (429 rate limit, 5xx).
// Running requests concurrently makes hitting these more likely than the
// old one-at-a-time loop did, so it matters more now than it used to.
async function withRetry(fn, retries = 2, baseDelayMs = 400) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

export { mapWithConcurrency, withRetry };
