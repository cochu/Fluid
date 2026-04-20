/**
 * presets.js – Named scene presets.
 *
 * Each preset is a pure partial-state descriptor: a CONFIG patch (engineering
 * values) and an optional slider patch (raw 0..100 thumb positions). They are
 * applied by mutating CONFIG in place and then dispatching synthetic 'input'
 * events on the affected sliders so the existing UI handlers re-derive the
 * engineering values from the curve mappings — the same path that handles a
 * user dragging the slider, so no special UI rebuild is needed.
 *
 * Design constraints (per Erik's review):
 *   - Presets touch only numerical knobs + booleans + palette. They MUST NOT
 *     require `rebuildSubsystems()`. If you add a field that needs a rebuild
 *     (resolution, format, FBO count), you have to call rebuild explicitly
 *     in main.js — not from this module.
 *   - Presets DO NOT clear the user's painted obstacles or placed sources.
 *     Those are user creations; presets only re-tune the simulation around
 *     them.
 *   - Permission-gated state (AUDIO_REACTIVE, TILT_REACTIVE) is never set
 *     from a preset — turning the mic on requires a fresh user gesture.
 */

/**
 * The ordered preset list. Activation cycles through it in order; the
 * `default` preset restores the project defaults so a user can always
 * step back without reloading.
 *
 * Pick palettes from the existing `Palettes.js` modes so the ◐ button keeps
 * working immediately after a preset switch.
 */
export const PRESETS = Object.freeze([
  {
    id:    'default',
    label: 'Default',
    cfg: {
      COLOR_MODE:             'rainbow',
      BLOOM:                  true,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0,
      CURL:                   16,
    },
    sliders: { 'slider-force': 50, 'slider-dissipation': 65, 'slider-viscosity': 0 },
  },
  {
    id:    'aurora',
    label: 'Aurora',
    cfg: {
      COLOR_MODE:             'forest',
      BLOOM:                  true,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0,
      CURL:                   28,
    },
    sliders: { 'slider-force': 30, 'slider-dissipation': 88, 'slider-viscosity': 0 },
  },
  {
    id:    'ink',
    label: 'Ink in water',
    cfg: {
      COLOR_MODE:             'mono',
      BLOOM:                  false,
      PARTICLES:              false,
      HIGH_QUALITY_ADVECTION: true,
      // Mild viscosity gives the slow billowing ink-cloud look without
      // re-introducing the trame (see gotchas #1: HQ-advect on dye is fine,
      // velocity self-advection stays plain SL inside the simulation).
      VISCOSITY:              0.004,
      CURL:                   8,
    },
    sliders: { 'slider-force': 22, 'slider-dissipation': 92, 'slider-viscosity': 22 },
  },
  {
    id:    'lava',
    label: 'Lava',
    cfg: {
      COLOR_MODE:             'magma',
      BLOOM:                  true,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0.008,
      CURL:                   12,
    },
    sliders: { 'slider-force': 65, 'slider-dissipation': 80, 'slider-viscosity': 35 },
  },
  {
    id:    'smoke',
    label: 'Smoke',
    cfg: {
      COLOR_MODE:             'mono',
      BLOOM:                  false,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0,
      CURL:                   34,
    },
    sliders: { 'slider-force': 18, 'slider-dissipation': 70, 'slider-viscosity': 0 },
  },
  {
    id:    'plasma',
    label: 'Plasma',
    cfg: {
      COLOR_MODE:             'cycle',
      BLOOM:                  true,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0,
      CURL:                   40,
    },
    sliders: { 'slider-force': 75, 'slider-dissipation': 85, 'slider-viscosity': 0 },
  },
  {
    id:    'ocean',
    label: 'Deep ocean',
    cfg: {
      COLOR_MODE:             'ocean',
      BLOOM:                  true,
      PARTICLES:              true,
      HIGH_QUALITY_ADVECTION: true,
      VISCOSITY:              0.002,
      CURL:                   18,
    },
    sliders: { 'slider-force': 40, 'slider-dissipation': 90, 'slider-viscosity': 14 },
  },
]);

/** Look up a preset by id. Returns the default preset on miss. */
export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

/** Return the next preset id after `currentId` (wraps around). */
export function nextPresetId(currentId) {
  const i = Math.max(0, PRESETS.findIndex((p) => p.id === currentId));
  return PRESETS[(i + 1) % PRESETS.length].id;
}

/**
 * Apply a preset to CONFIG and the slider DOM.
 *
 * @param {string} id        Preset id (falls back to 'default' if unknown)
 * @param {object} CONFIG    The shared CONFIG object to mutate
 * @returns {string[]}       List of slider ids that were updated; the caller
 *                           should fire synthetic 'input' events on them so
 *                           the UI handlers re-derive engineering values via
 *                           the curve mappings.
 */
export function applyPreset(id, CONFIG) {
  const p = getPreset(id);
  // CONFIG patch.
  for (const k of Object.keys(p.cfg)) {
    CONFIG[k] = p.cfg[k];
  }
  // Maintain the legacy COLORFUL alias.
  if (typeof CONFIG.COLOR_MODE === 'string') {
    CONFIG.COLORFUL = CONFIG.COLOR_MODE !== 'mono';
  }
  // Slider patch.
  const changed = [];
  for (const id of Object.keys(p.sliders)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = String(p.sliders[id]);
    changed.push(id);
  }
  return changed;
}
