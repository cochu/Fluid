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

  /** Vorticity / curl confinement strength – adds swirly detail. */
  CURL: 25,

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
  COLORFUL: true,

  /** How fast hue rotates when COLORFUL is on (°/s). */
  COLOR_UPDATE_SPEED: 10,

  /** Bloom post-process toggle. */
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  BLOOM_INTENSITY: 0.8,
  BLOOM_THRESHOLD: 0.6,
  BLOOM_SOFT_KNEE: 0.7,

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
  PARTICLE_SIZE: 3.0,

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
};
