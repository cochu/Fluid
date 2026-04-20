/**
 * persistence.js – Persist a curated allow-list of CONFIG keys and slider
 * positions across reloads, plus encode/decode the same snapshot in a
 * shareable URL hash.
 *
 * Boundaries (per Maya's pre-flight review):
 *   - This module never reads CONFIG inside the hot path. It snapshots on
 *     debounced UI events only.
 *   - It never re-exports CONFIG; it imports it solely to build the snapshot.
 *   - It never mutates CONFIG during the frame loop. The only mutation point
 *     is `applyToConfig` called from main.js *before* FluidSimulation is
 *     constructed.
 *   - Resolution / iteration counts are deliberately NOT in the allow-list
 *     because adaptive-downscale rewrites them in-place; persisting them
 *     would freeze a slow-device sample on a fast device. The user's
 *     intent is captured separately via `PERF_MODE`.
 *   - Permission-gated flags (AUDIO_REACTIVE, TILT_REACTIVE) are NOT
 *     persisted: they require a fresh user gesture each session anyway.
 *
 * Storage failure (Safari private mode, denied permission, quota full)
 * collapses to a single console.warn and zero functional impact — every
 * read and write is wrapped in try/catch.
 */

import { CONFIG } from './config.js';

/* ──────────────────────────────────────────────────────────────────────
   Schema
   --------------------------------------------------------------------
   Bump SCHEMA_VERSION on a breaking key removal/rename. New keys added
   to either list are forward-compatible without a bump (loads from an
   older snapshot just leave the new keys at their CONFIG defaults).
   ────────────────────────────────────────────────────────────────────── */

export const SCHEMA_VERSION  = 1;
export const STORAGE_KEY     = 'fluid:settings:v1';

/** CONFIG keys persisted. Order is irrelevant. */
export const PERSISTED_CONFIG_KEYS = Object.freeze([
  'COLOR_MODE',
  'BLOOM',
  'PARTICLES',
  'HIGH_QUALITY_ADVECTION',
  'SPLAT_FORCE',
  'DENSITY_DISSIPATION',
  'VELOCITY_DISSIPATION',
  'VISCOSITY',
  'CURL',
  'PERF_MODE',
  'WALLPAPER_MODE',
  'OBSTACLE_PAINT_RADIUS',
  'SOURCES',
  'AUDIO_GAIN',
  'AUDIO_MIDS_GAIN',
  'AUDIO_HIGHS_GAIN',
  'AUDIO_SENSITIVITY',
  'AUDIO_MIDS_SENSITIVITY',
  'AUDIO_HIGHS_SENSITIVITY',
]);

/** Slider DOM ids whose `value` (0..100) is persisted alongside CONFIG so
 *  the visible thumb matches the loaded engineering value without inverting
 *  the per-slider curve. */
export const PERSISTED_SLIDER_IDS = Object.freeze([
  'slider-force',
  'slider-dissipation',
  'slider-viscosity',
]);

/** Maximum number of sources encoded into a share link. Persistence stores
 *  all of them; only the URL hash is capped for shareability (a 25-source
 *  user shouldn't end up with a 4 KB URL). */
export const SHARE_LINK_SOURCE_CAP = 8;

/* ──────────────────────────────────────────────────────────────────────
   Snapshot helpers
   ────────────────────────────────────────────────────────────────────── */

/**
 * Produce a JSON-serializable snapshot of the current state.
 * Only allow-listed CONFIG keys + slider values are included.
 */
export function snapshot() {
  const cfg = {};
  for (const k of PERSISTED_CONFIG_KEYS) {
    if (k in CONFIG) cfg[k] = CONFIG[k];
  }
  const sliders = {};
  for (const id of PERSISTED_SLIDER_IDS) {
    const el = document.getElementById(id);
    if (el && 'value' in el) sliders[id] = Number(el.value);
  }
  return { v: SCHEMA_VERSION, cfg, sliders };
}

/**
 * Apply a snapshot back onto CONFIG and the slider DOM.
 * Safe with partial/malformed payloads — unknown keys are ignored,
 * type-mismatched values are skipped.
 *
 * Returns the list of slider element ids whose value was changed; the
 * caller is expected to dispatch synthetic 'input' events on them so
 * the existing UI handlers re-derive engineering values.
 */
export function applyToConfig(snap) {
  if (!snap || typeof snap !== 'object') return [];
  if (snap.v !== SCHEMA_VERSION)         return [];

  // CONFIG values
  const incoming = snap.cfg || {};
  for (const k of PERSISTED_CONFIG_KEYS) {
    if (!(k in incoming)) continue;
    const v = incoming[k];
    // Cheap type guard against tampered input.
    if (k === 'SOURCES') {
      if (Array.isArray(v)) CONFIG.SOURCES = sanitiseSources(v);
      continue;
    }
    if (typeof CONFIG[k] === typeof v || CONFIG[k] === undefined) {
      CONFIG[k] = v;
    }
  }
  // Maintain the legacy COLORFUL alias (gotcha #6).
  if (typeof CONFIG.COLOR_MODE === 'string') {
    CONFIG.COLORFUL = CONFIG.COLOR_MODE !== 'mono';
  }

  // Slider DOM values
  const changed = [];
  const sliders = snap.sliders || {};
  for (const id of PERSISTED_SLIDER_IDS) {
    if (!(id in sliders)) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    const n = Number(sliders[id]);
    if (!Number.isFinite(n)) continue;
    el.value = String(Math.max(0, Math.min(100, n)));
    changed.push(id);
  }
  return changed;
}

/**
 * Defensive normaliser for the SOURCES list — in particular, validates
 * that each entry has the expected shape so a malformed share-link can't
 * crash the per-frame source emission loop.
 */
function sanitiseSources(arr) {
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const x  = +s.x,  y  = +s.y;
    const dx = +s.dx, dy = +s.dy;
    if (!Number.isFinite(x) || !Number.isFinite(y))   continue;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const c = (s.color && typeof s.color === 'object') ? {
      r: Number(s.color.r) || 0,
      g: Number(s.color.g) || 0,
      b: Number(s.color.b) || 0,
    } : { r: 0, g: 0, b: 0 };
    const rate = Number.isFinite(+s.rate) ? +s.rate : 1;
    out.push({
      x: clamp01(x), y: clamp01(y),
      dx, dy,
      color: c,
      rate,
    });
  }
  return out;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/* ──────────────────────────────────────────────────────────────────────
   localStorage I/O
   ────────────────────────────────────────────────────────────────────── */

/**
 * Read the saved snapshot. Returns `null` on any failure (denied storage,
 * malformed JSON, schema mismatch). Never throws.
 */
export function loadFromStorage() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== SCHEMA_VERSION) return null;
    return snap;
  } catch (e) {
    console.warn('[Fluid] localStorage read failed:', e?.message || e);
    return null;
  }
}

/** Write the supplied snapshot. Silent on any failure. */
export function saveToStorage(snap) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch (e) {
    // Quota exceeded, denied, etc. — silently degrade.
    console.warn('[Fluid] localStorage write failed:', e?.message || e);
  }
}

/** Wipe the persisted snapshot. Used by the long-press Reset action. */
export function clearStorage() {
  try { window.localStorage?.removeItem(STORAGE_KEY); }
  catch (_) { /* noop */ }
}

/* ──────────────────────────────────────────────────────────────────────
   URL hash encoding (shareable links)
   ────────────────────────────────────────────────────────────────────── */

/**
 * Build a `#<base64url>` fragment encoding the current settings. The
 * SOURCES list is capped to `SHARE_LINK_SOURCE_CAP` to keep links short.
 */
export function encodeShareHash() {
  const snap = snapshot();
  if (Array.isArray(snap.cfg.SOURCES) && snap.cfg.SOURCES.length > SHARE_LINK_SOURCE_CAP) {
    snap.cfg.SOURCES = snap.cfg.SOURCES.slice(0, SHARE_LINK_SOURCE_CAP);
  }
  const json = JSON.stringify(snap);
  // Use URL-safe base64 so the fragment contains no `+`, `/`, `=`.
  const b64  = btoa(unescape(encodeURIComponent(json)));
  const safe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#s=${safe}`;
}

/**
 * Decode a share-link fragment. Tolerates missing prefix, malformed
 * base64 or JSON. Returns the snapshot or `null`.
 */
export function decodeShareHash(hashStr) {
  if (!hashStr) return null;
  try {
    const m = String(hashStr).match(/[#&]s=([^&]+)/);
    if (!m) return null;
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = decodeURIComponent(escape(atob(b64)));
    const snap = JSON.parse(json);
    if (!snap || snap.v !== SCHEMA_VERSION) return null;
    return snap;
  } catch (e) {
    console.warn('[Fluid] Share link decode failed:', e?.message || e);
    return null;
  }
}

/** Build the full canonical share URL using the current `location` and
 *  the encoded snapshot. */
export function buildShareUrl() {
  const url = new URL(window.location.href);
  url.hash  = encodeShareHash();
  return url.href;
}

/* ──────────────────────────────────────────────────────────────────────
   Boot helper — combines hash + storage precedence
   ────────────────────────────────────────────────────────────────────── */

/**
 * Resolve initial settings: URL hash takes precedence (a guest's intent),
 * then localStorage (this device's memory), then existing CONFIG defaults.
 *
 * Returns `{ source, sliderIds }`:
 *   - source     'hash' | 'storage' | 'default'
 *   - sliderIds  list of slider DOM ids that were updated and should be
 *                fired with a synthetic input event
 *
 * When the source is 'hash', the caller should NOT auto-persist on its
 * first save (so a shared link doesn't permanently overwrite the
 * recipient's local memory) — but subsequent user mutations are normal.
 * The simplest enforcement is to skip writing the very first debounced
 * snapshot triggered by `applyToConfig`-driven slider events; main.js
 * does this by suppressing persistence for one frame after boot.
 */
export function bootstrap() {
  const fromHash = decodeShareHash(window.location.hash);
  if (fromHash) {
    const sliderIds = applyToConfig(fromHash);
    return { source: 'hash', sliderIds };
  }
  const fromStore = loadFromStorage();
  if (fromStore) {
    const sliderIds = applyToConfig(fromStore);
    return { source: 'storage', sliderIds };
  }
  return { source: 'default', sliderIds: [] };
}

/* ──────────────────────────────────────────────────────────────────────
   Debounced auto-save
   --------------------------------------------------------------------
   The watcher binds a SINGLE delegated listener on the UI panel (input +
   click), which covers every slider and button without each handler
   needing to opt in. The `gate` callback returns true when persistence
   should currently be suppressed (used to skip the post-boot tail and the
   in-progress adaptive downscale frame).
   ────────────────────────────────────────────────────────────────────── */

/**
 * Install the auto-save watcher.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panelEl     The element whose input/click events trigger a save
 * @param {() => boolean} [opts.gate]    Called before each save; returns true to skip
 * @param {number} [opts.debounceMs=400]
 * @returns {{ teardown: () => void, requestSave: () => void }}
 *   - `teardown` removes the listeners and cancels any pending save.
 *   - `requestSave` re-schedules the debounced save explicitly. Use it for
 *     state mutations that don't bubble through the panel (e.g. removing a
 *     source via the SVG overlay, applying a preset programmatically).
 */
export function installAutoSave({ panelEl, gate, debounceMs = 400 } = {}) {
  let timer = 0;
  const requestSave = () => {
    if (gate && gate()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Snapshot is read at fire time (not enqueue time) so a burst of
      // slider drag events collapses to one save with the latest value.
      saveToStorage(snapshot());
    }, debounceMs);
  };
  if (panelEl) {
    // Bubble phase (capture=false) so the UI's own handlers — which
    // mutate CONFIG synchronously inside the slider/click callback — get
    // to run first; then the snapshot we save reflects the new state.
    panelEl.addEventListener('input', requestSave);
    panelEl.addEventListener('click', requestSave);
  }
  return {
    teardown() {
      clearTimeout(timer);
      if (panelEl) {
        panelEl.removeEventListener('input', requestSave);
        panelEl.removeEventListener('click', requestSave);
      }
    },
    requestSave,
  };
}
