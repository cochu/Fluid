/**
 * config.js – Central configuration for the fluid simulation.
 *
 * All parameters can be adjusted at runtime via the UI or programmatically.
 */
export const CONFIG = {
  /* ── Simulation grid ──────────────────────────────────────────────── */
  /** Resolution of the velocity / pressure grid (lower = faster). */
  SIM_RESOLUTION: 128,

  /** Resolution of the dye (colour) texture. */
  DYE_RESOLUTION: 512,

  /* ── Fluid dynamics ───────────────────────────────────────────────── */
  /** How quickly dye fades each step (1 = no fade, 0 = instant clear). */
  DENSITY_DISSIPATION: 0.99,

  /** How quickly velocity decays (1 = no decay). */
  VELOCITY_DISSIPATION: 0.99,

  /** Pressure fade per iteration – reduces numerical ringing. */
  PRESSURE: 0.8,

  /** Number of Jacobi pressure-solve iterations (more = more accurate). */
  PRESSURE_ITERATIONS: 25,

  /** Vorticity / curl confinement strength – adds swirly detail.
   *  Lowered from 25→16 in tandem with the gated VORTICITY_FRAG; the
   *  gate suppresses noise amplification so we no longer need the
   *  large strength that previously masked pre-existing trame. */
  CURL: 16,

  /**
   * Use second-order MacCormack/Selle advection (3-pass, with limiter)
   * instead of plain semi-Lagrangian. Significantly reduces numerical
   * diffusion at the cost of two extra advection passes per advected field.
   *
   * Kept as a backward-compat boolean alias of `DYE_ADVECTION === 'maccormack'`
   * for old persisted snapshots; new code should read DYE_ADVECTION instead.
   */
  HIGH_QUALITY_ADVECTION: true,

  /**
   * Dye advection scheme — one of 'standard', 'maccormack', 'bfecc'.
   * Velocity self-advection is always plain semi-Lagrangian (golden
   * rule #1: MacCormack on the velocity path re-creates the
   * zero-viscosity grid trame). BFECC and MacCormack share the first
   * two passes, so the GPU cost is identical between them.
   */
  DYE_ADVECTION: 'maccormack',

  /**
   * Wall boundary condition for the velocity field.
   *  - false (default): free-slip — fluid slides along the canvas
   *    edges (normal component negated, tangential preserved).
   *  - true            : no-slip  — fluid sticks to the edges, creating
   *    visible boundary-layer drag near the walls. Pairs nicely with
   *    a non-zero VISCOSITY for a thicker, more viscous look.
   * Implemented as a single uniform branch in BOUNDARY_FRAG.
   */
  NO_SLIP_BOUNDARY: false,

  /**
   * Faux-3D dye shading. When true, the display shader treats dye
   * luminance as a height field, computes a screen-space normal from
   * the local gradient, and lights it with a fixed virtual sun
   * (Lambert + tight specular). Purely cosmetic — does not touch the
   * simulation. Off by default because the flat look is already part
   * of the project's identity; the user opts in via the ✦ button.
   */
  SHADING: false,

  /**
   * Kinematic viscosity ν. 0 disables the implicit viscous diffusion pass
   * entirely (no cost). Typical visible range is roughly 0–0.5; the value
   * is multiplied by Δt · N² internally so the slider feel is independent
   * of SIM_RESOLUTION.
   */
  VISCOSITY: 0,

  /** Number of Jacobi iterations for the viscous diffusion solve. */
  VISCOSITY_ITERATIONS: 20,

  /* ── Interaction ──────────────────────────────────────────────────── */
  /** Gaussian splat radius (fraction of shorter screen side). */
  SPLAT_RADIUS: 0.28,

  /** Force magnitude applied on pointer drag. */
  SPLAT_FORCE: 1500,

  /* ── Visuals ──────────────────────────────────────────────────────── */
  /**
   * Active hue palette for new splats. One of:
   *   'rainbow' (legacy random hue per pointer), 'cycle' (slow rainbow),
   *   'ocean', 'sunset', 'magma', 'forest', 'mono'.
   * Cycled at runtime by the ◐ palette button.
   */
  COLOR_MODE: 'rainbow',

  /**
   * Legacy alias kept for backward compatibility with older snippets /
   * external scripts. New code should test COLOR_MODE !== 'mono' instead.
   */
  COLORFUL: true,

  /** How fast hue rotates when COLOR_MODE === 'cycle' (°/s). */
  COLOR_UPDATE_SPEED: 10,

  /** Bloom post-process toggle. */
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  /* Tuned against DYE_BRIGHTNESS=0.15 (typical accumulated dye lives
   * in 0.2-0.5). Threshold 0.15 lets even mid-bright dye start glowing,
   * the wider 0.20 knee softens the bright/dark transition for a richer
   * halo, and 1.9 intensity (paired with the quadratic HDR boost in
   * DISPLAY_FRAG) makes the toggle clearly painterly rather than fade. */
  BLOOM_INTENSITY: 1.9,
  BLOOM_THRESHOLD: 0.15,
  BLOOM_SOFT_KNEE: 0.20,

  /* ── Particles ────────────────────────────────────────────────────── */
  PARTICLES: true,

  /** Total number of GPU particles. */
  PARTICLE_COUNT: 5000,

  /**
   * Max particle lifetime in seconds.
   * Currently informational — particles do not auto-decay; they live until
   * relocated by the "drop particles" tool. Kept for backward compatibility.
   */
  PARTICLE_LIFETIME: 5.0,

  /** Render point size (px, before DPR scaling). Larger = more aquatic blob.
   *  Bumped from 4.5 → 5.5 to give the wider luminous halo room to read
   *  without the core feeling chunkier (the halo Gaussian is shallow). */
  PARTICLE_SIZE: 5.5,

  /**
   * Fraction of particles relocated to the cursor on each "drop" frame
   * (when dragging from the dedicated drop button onto the canvas).
   */
  PARTICLE_DROP_RATE: 0.06,

  /** Spread (UV radius) of the particle drop around the cursor. */
  PARTICLE_DROP_RADIUS: 0.025,

  /* ── Performance ──────────────────────────────────────────────────── */
  PAUSED: false,

  /**
   * Auto-reduce resolution when frame time exceeds this threshold (ms).
   * 22 ms ≈ 45 FPS minimum — below this we start sacrificing quality for smoothness.
   * Set to 0 to disable adaptive quality.
   */
  ADAPTIVE_RESOLUTION_THRESHOLD_MS: 22,

  /** How often (seconds) to re-evaluate whether adaptive resolution should trigger. */
  ADAPTIVE_RESOLUTION_CHECK_INTERVAL: 2,

  /** Number of consecutive bad-frame check windows required before an
   *  adaptive downscale fires. Two windows (~4 s with the default
   *  CHECK_INTERVAL) filters out a single hiccup such as a GC pause or
   *  tab refresh — gotcha #8. */
  ADAPTIVE_DOWNSCALE_CONSECUTIVE: 2,

  /** Average frame time below which adaptive recovery considers
   *  upscaling. Set to a clear margin under the downscale threshold so
   *  the system doesn't ping-pong: the gap between this and
   *  ADAPTIVE_RESOLUTION_THRESHOLD_MS is the hysteresis band. Default
   *  ~13 ms ≈ 0.6 × the 22 ms downscale gate. */
  ADAPTIVE_UPSCALE_THRESHOLD_MS: 13,

  /** Number of consecutive good-frame check windows required before an
   *  adaptive upscale fires. Higher than DOWNSCALE_CONSECUTIVE because
   *  recovery is the riskier transition (a sudden doubling can blow
   *  the budget itself); 4 windows ≈ 8 s of clean frames. */
  ADAPTIVE_UPSCALE_CONSECUTIVE: 4,

  /** Cool-down (ms) after a downscale before another adaptive decision
   *  can fire — gives the smaller grid time to settle the EMA. */
  ADAPTIVE_COOLDOWN_AFTER_DOWNSCALE_MS: 3000,

  /** Cool-down (ms) after an upscale. Longer than the downscale path
   *  because doubling resolution is the riskier transition. */
  ADAPTIVE_COOLDOWN_AFTER_UPSCALE_MS: 5000,

  /** Master kill-switch for adaptive resolution. The bench harness
   *  flips this true before instantiation so its measurements aren't
   *  contaminated by mid-run resolution changes. */
  ADAPTIVE_RESOLUTION_DISABLED: false,

  /** Dimming factor applied to splat colours so they blend well in the fluid. */
  DYE_BRIGHTNESS: 0.15,

  /* ── Audio reactivity ─────────────────────────────────────────────── */
  /**
   * Master enable for microphone-driven splats. Toggled at runtime by the
   * 🎤 UI button; the AudioReactivity module is a no-op when this is off.
   */
  AUDIO_REACTIVE: false,

  /** Persisted MediaDeviceInfo.deviceId for the preferred microphone.
   *  Empty string = use the browser's default device. The id is stable
   *  per-(browser,origin) so this survives reloads but doesn't cross
   *  devices. Populated by the device picker in the audio sub-panel. */
  AUDIO_DEVICE_ID: '',

  /** Bass band (Hz). 60–160 trims 50/60 Hz mains hum and stays on the
   *  body of a kick drum. Drives soft converging ring. */
  AUDIO_BASS_LOW_HZ: 60,
  AUDIO_BASS_HIGH_HZ: 160,
  /** Mids band (Hz). Snares / vocals. Drives counter-rotating vortex pairs. */
  AUDIO_MIDS_LOW_HZ: 300,
  AUDIO_MIDS_HIGH_HZ: 2200,
  /** Highs band (Hz). Hi-hats / cymbals. Drives small dye-only sparkles. */
  AUDIO_HIGHS_LOW_HZ: 4000,
  AUDIO_HIGHS_HIGH_HZ: 12000,

  /** Beat thresholds — multiplier over the slow adaptive baseline. */
  AUDIO_SENSITIVITY:        1.55,   // legacy / bass
  AUDIO_MIDS_SENSITIVITY:   1.45,
  AUDIO_HIGHS_SENSITIVITY:  1.65,

  /** Absolute lower bound on smoothed band energy (0..1). */
  AUDIO_NOISE_FLOOR:        0.05,
  AUDIO_MIDS_NOISE_FLOOR:   0.04,
  AUDIO_HIGHS_NOISE_FLOOR:  0.03,

  /** Refractory windows (ms) – cap trigger rate per band. */
  AUDIO_REFRACTORY_MS:        220,
  AUDIO_MIDS_REFRACTORY_MS:   140,
  AUDIO_HIGHS_REFRACTORY_MS:   90,

  /** Per-band gains. Bass is intentionally soft (< 0.3) — earlier versions
   *  multiplied the user's SPLAT_FORCE by ~1× and felt violent. */
  AUDIO_GAIN:        0.22,   // bass corner-pulse gain
  AUDIO_MIDS_GAIN:   0.55,   // mids vortex-pair gain
  AUDIO_HIGHS_GAIN:  0.18,   // highs sparkle dye intensity

  /** Number of splats per bass ring (8 = clean approximation of radial
   *  symmetry; fewer aliases into × / diamond patterns). */
  AUDIO_SPLAT_COUNT: 8,

  /* ── MIDI input ───────────────────────────────────────────────────── */
  /** Master enable for MIDI reactivity. NOT persisted — the underlying
   *  Web MIDI permission must be re-requested from a user gesture each
   *  reload (mirrors AUDIO_REACTIVE / TILT_REACTIVE). */
  MIDI_REACTIVE: false,

  /** Channel filter for incoming MIDI messages. -1 = listen to all
   *  channels; 0..15 = restrict to a single channel. Dev-tier: there is
   *  no v1 UI for this, but a power-user can set it from devtools. */
  MIDI_CHANNEL_FILTER: -1,

  /** Multiplier on velocity → splat force. 1.0 leaves the velocity
   *  curve untouched; lower values make the keyboard "softer". */
  MIDI_NOTE_GAIN: 1.0,

  /** Live-mutable map of {ccNumber: 'CONFIG_KEY_NAME'} pairs. The MIDI
   *  module looks up the target key on every CC and remaps the value
   *  through a target-specific curve. Defaults: modwheel → SPLAT_FORCE,
   *  filter cutoff → CURL. Add entries from devtools to map more
   *  controllers (recognised targets: SPLAT_FORCE, CURL,
   *  DENSITY_DISSIPATION, VISCOSITY). */
  MIDI_CC_MAP: { 1: 'SPLAT_FORCE', 74: 'CURL' },

  /* ── Tilt / accelerometer reactivity ─────────────────────────────── */
  /**
   * Master enable for accelerometer-driven stirring. OFF by default —
   * permission must be requested from a user gesture (the 🧭 UI button)
   * and the feature is mostly meaningful on mobile / tablet devices.
   */
  TILT_REACTIVE: false,

  /**
   * Calibration window (ms) at the start of a tilt session: the device's
   * resting acceleration vector is averaged over this window and stored
   * as the new "zero". Subsequent tilt is measured as a delta from this
   * baseline, so the user can hold the phone in any orientation.
   */
  TILT_CALIBRATION_MS: 450,

  /**
   * Body-force gain applied to the tilt delta. Output is in UV/s² and is
   * passed straight to fluid.applyBodyForce. 0.05 means a 1 m/s² delta
   * moves the field at 0.05 UV/s², a gentle drift over a couple seconds.
   */
  TILT_BODY_FORCE_GAIN: 0.05,

  /* ── Obstacles ───────────────────────────────────────────────────── */
  /** Master enable for the obstacle-paint pointer mode. Toggled by 🧱. */
  OBSTACLE_MODE: false,
  /**
   * Gaussian radius (UV-fraction-of-shorter-side) of the obstacle brush.
   * Matches `brushFromSlider(35)` in UI.js so the very first painted dab
   * (before the user touches the slider) lines up with the slider knob.
   */
  OBSTACLE_PAINT_RADIUS: 0.0053,

  /* ── Permanent fluid sources ─────────────────────────────────────── */
  /**
   * Persistent emitters. Each entry: { x, y, dx, dy, color, rate }.
   *   x, y      UV position [0,1]
   *   dx, dy    velocity injected per emission (UV/s, before SPLAT_FORCE)
   *   color     {r,g,b}, already pre-multiplied by DYE_BRIGHTNESS
   *   rate      0..1 amplitude scale (UI default 1)
   *
   * Mutated by the UI; consumed once per frame in main.js animate loop.
   */
  SOURCES: [],
  /** Master enable for the source-placement pointer mode. Toggled by 💠. */
  SOURCE_MODE: false,

  /** Master enable for the sink-placement pointer mode. Toggled by 🕳.
   *  Mutex with SOURCE_MODE and OBSTACLE_MODE — only one editing mode
   *  is active at a time. A "sink" is a SOURCES entry with `kind:'sink'`
   *  (no dx/dy/color) that drains dye from a Gaussian neighbourhood
   *  each frame. Not persisted — placement mode is transient. */
  SINK_MODE: false,

  /** Per-frame fraction of dye drained at the centre of each sink, in
   *  units of "fraction-removed/sec at peak". 1.5 corresponds to ~78%
   *  drained over a second at the bull's-eye of an undisturbed sink —
   *  a visible drain that lets transient brush-overs survive a moment
   *  before fading. Multiplied by `dt` and `rate` per frame so behaviour
   *  is frame-rate independent. */
  SINK_RATE: 1.5,

  /**
   * When true *and* OBSTACLE_MODE is also true, drags subtract from the
   * obstacle field (eraser) instead of adding. Toggled by 🩹. Not
   * persisted — eraser is a transient editing mode, not a scene
   * property.
   */
  OBSTACLE_ERASE: false,

  /**
   * User-explicit performance mode. Distinct from the live SIM_RESOLUTION
   * (which adaptive downscale also rewrites): this captures the user's
   * intent so persistence can restore the perf-mode preset on reload
   * without freezing a transient adaptive state. Toggled by ⚡.
   */
  PERF_MODE: false,

  /* ── Wallpaper / screensaver mode ─────────────────────────────────── */
  /**
   * Toggled by 🌙. When true, the UI panel + version tag + FPS counter
   * fade out after WALLPAPER_FADE_TIMEOUT_MS of no pointer/keyboard
   * activity (CSS-driven via the `.wallpaper-on`/`.wallpaper-revealed`
   * body classes), and the animate loop emits one soft auto-splat every
   * WALLPAPER_AUTOSPLAT_INTERVAL_MS so the canvas keeps breathing.
   * Both pause (CONFIG.PAUSED) and tab-hide (document.hidden) gate the
   * auto-splat naturally because animate() returns early in those
   * states — no separate timer to leak (gotcha #11).
   */
  WALLPAPER_MODE: false,
  WALLPAPER_AUTOSPLAT_INTERVAL_MS: 1800,
  WALLPAPER_FADE_TIMEOUT_MS: 5000,
  /** Force scale applied to wallpaper auto-splats relative to a normal
   *  user splat (lower = gentler ambient cadence). */
  WALLPAPER_AUTOSPLAT_FORCE_SCALE: 0.4,
};
