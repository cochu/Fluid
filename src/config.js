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
   */
  HIGH_QUALITY_ADVECTION: true,

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
   * in 0.2-0.5). Threshold 0.22 lets bright splat overlaps glow, the
   * tight 0.12 knee keeps the glow defined instead of a vague wash,
   * and 1.35 intensity makes the toggle visibly punchy. */
  BLOOM_INTENSITY: 1.35,
  BLOOM_THRESHOLD: 0.22,
  BLOOM_SOFT_KNEE: 0.12,

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

  /** Render point size (px, before DPR scaling). Larger = more aquatic blob. */
  PARTICLE_SIZE: 4.5,

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

  /** Dimming factor applied to splat colours so they blend well in the fluid. */
  DYE_BRIGHTNESS: 0.15,

  /* ── Audio reactivity ─────────────────────────────────────────────── */
  /**
   * Master enable for microphone-driven splats. Toggled at runtime by the
   * 🎤 UI button; the AudioReactivity module is a no-op when this is off.
   */
  AUDIO_REACTIVE: false,

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

  /* ── Tilt / accelerometer reactivity ─────────────────────────────── */
  /**
   * Master enable for accelerometer-driven stirring. OFF by default —
   * permission must be requested from a user gesture (the 🧭 UI button)
   * and the feature is mostly meaningful on mobile / tablet devices.
   */
  TILT_REACTIVE: false,
};
