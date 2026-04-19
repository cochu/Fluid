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
  SPLAT_FORCE: 3000,

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

  /** Render point size (px, before DPR scaling). */
  PARTICLE_SIZE: 1.5,

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

  /** Bass band lower bound (Hz) used to detect kicks / sub-bass. */
  AUDIO_BASS_LOW_HZ: 20,
  /** Bass band upper bound (Hz). 200 captures the body of a kick drum. */
  AUDIO_BASS_HIGH_HZ: 200,

  /**
   * Beat trigger threshold expressed as a multiplier over the slow
   * adaptive baseline. 1.4–2.0 works well in typical rooms.
   */
  AUDIO_SENSITIVITY: 1.55,

  /** Absolute lower bound on smoothed bass energy (0..1). Below this we
   *  consider the room silent and never trigger, regardless of ratio. */
  AUDIO_NOISE_FLOOR: 0.06,

  /** Minimum gap between consecutive rings (ms). Prevents smearing on
   *  sustained bass and roughly caps trigger rate at 5 Hz. */
  AUDIO_REFRACTORY_MS: 180,

  /** Extra gain applied on top of SPLAT_FORCE for audio-triggered rings. */
  AUDIO_GAIN: 0.85,

  /** Number of radial splats emitted per detected beat (more = rounder
   *  ring, but each splat is a fragment shader pass — keep it modest). */
  AUDIO_SPLAT_COUNT: 16,
};
