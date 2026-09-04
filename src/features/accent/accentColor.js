import { useCallback, useEffect, useState } from 'react';

import { clamp } from '../../lib/mathUtils.js';


// ---------------------------------------------------------------------------
// App — top-level composition and view-transition wiring
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Accent color — user-customizable, persisted to localStorage, applied as
// CSS custom properties on the document root. Every accent-derived color in
// App.css (--accent-hover, --accent-soft, --link-color, --tag-bg,
// --tag-color) is computed from the one base hex here rather than being a
// second hardcoded value, so picking a new accent recolors links, tags,
// active states, and the selection highlight consistently in one place.
// ---------------------------------------------------------------------------
const ACCENT_STORAGE_KEY = 'vault_accent_color';

const DEFAULT_ACCENT = '#8875e0';

const ACCENT_PRESETS = ['#8875e0', '#4f8ef7', '#3fb27f', '#e0a23f', '#e0685f', '#e85d9c', '#5fc3e0', '#9e9e9e'];


function hexToRgbArr(hex) {
  const clean = (hex || DEFAULT_ACCENT).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hexToRgbArr(DEFAULT_ACCENT);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbArrToHex([r, g, b]) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

function lightenRgb(rgb, amount) {
  return rgb.map((v) => v + (255 - v) * amount);
}


function applyAccentColor(hex) {
  const rgb = hexToRgbArr(hex);
  const hoverHex = rgbArrToHex(lightenRgb(rgb, 0.12));
  const linkHex = rgbArrToHex(lightenRgb(rgb, 0.3));
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-hover', hoverHex);
  root.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, 0.16)`);
  root.setProperty('--link-color', linkHex);
  root.setProperty('--tag-bg', `rgba(${rgb.join(', ')}, 0.14)`);
  root.setProperty('--tag-color', linkHex);
}


function useAccentColor() {
  const [accent, setAccentState] = useState(() => {
    try {
      return localStorage.getItem(ACCENT_STORAGE_KEY) || DEFAULT_ACCENT;
    } catch {
      return DEFAULT_ACCENT;
    }
  });
  useEffect(() => {
    applyAccentColor(accent);
  }, [accent]);
  const setAccent = useCallback((hex) => {
    setAccentState(hex);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, hex);
    } catch {
      // localStorage unavailable (private mode, quota) — color still
      // applies for this session via state, just won't persist.
    }
  }, []);
  return [accent, setAccent];
}

export { ACCENT_STORAGE_KEY, DEFAULT_ACCENT, ACCENT_PRESETS, hexToRgbArr, rgbArrToHex, lightenRgb, applyAccentColor, useAccentColor };
