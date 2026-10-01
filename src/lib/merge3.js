// Line-based three-way merge (diff3-style) for text notes edited in two
// places at once. `base` is the last content both sides agreed on, `mine` is
// the local edit, `theirs` is what's now in Drive.
//
// Returns { merged, conflict }: `conflict` is true if any region was changed
// differently on both sides — those regions are emitted with git-style
// markers in `merged`. Returns null if the inputs are too large to diff
// cheaply (callers treat that as an unresolvable conflict).

const MAX_CELLS = 4_000_000;

// For each line of `a`, the index of its LCS-matched line in `b` (or -1).
function matchLines(a, b) {
  const res = new Int32Array(a.length).fill(-1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) { res[p] = p; p++; }
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) {
    res[a.length - 1 - s] = b.length - 1 - s;
    s++;
  }
  const n = a.length - p - s;
  const m = b.length - p - s;
  if (!n || !m) return res;
  if (n * m > MAX_CELLS) return null;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[p + i] === b[p + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[p + i] === b[p + j]) { res[p + i] = p + j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return res;
}

const same = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);

function merge3(base, mine, theirs) {
  const B = base.split('\n'), M = mine.split('\n'), T = theirs.split('\n');
  const ma = matchLines(B, M);
  const mb = matchLines(B, T);
  if (!ma || !mb) return null;
  const out = [];
  let conflict = false;
  let bi = 0, mi = 0, ti = 0;
  const region = (bEnd, mEnd, tEnd) => {
    const b = B.slice(bi, bEnd), m = M.slice(mi, mEnd), t = T.slice(ti, tEnd);
    if (same(m, b)) out.push(...t);
    else if (same(t, b) || same(m, t)) out.push(...m);
    else {
      conflict = true;
      out.push('<<<<<<< mine', ...m, '=======', ...t, '>>>>>>> theirs');
    }
  };
  for (let i = 0; i < B.length; i++) {
    if (ma[i] < 0 || mb[i] < 0) continue;
    region(i, ma[i], mb[i]);
    out.push(B[i]);
    bi = i + 1;
    mi = ma[i] + 1;
    ti = mb[i] + 1;
  }
  region(B.length, M.length, T.length);
  return { merged: out.join('\n'), conflict };
}

export { merge3 };
