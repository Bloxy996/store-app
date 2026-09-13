// Tiny shared numeric helper(s) with no other home; see CLAUDE.md section 5.
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export { clamp };
