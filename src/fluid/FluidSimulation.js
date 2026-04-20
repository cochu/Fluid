/**
 * FluidSimulation.js – Navier-Stokes fluid solver running on the GPU.
 *
 * Each frame the solver:
 *   1.  Applies external forces (splats from user input)
 *   2.  Computes curl for vorticity confinement
 *   3.  Applies vorticity confinement force
 *   4.  Advects velocity (semi-Lagrangian, self-advection)
 *   5.  Computes divergence ∇·v
 *   6.  Solves pressure Poisson equation via Jacobi iteration
 *   7.  Subtracts pressure gradient → divergence-free velocity
 *   8.  Advects dye texture
 */

import {
  createProgram,
  createFBO,
  createDoubleFBO,
  destroyFBO,
  destroyDoubleFBO,
  createQuad,
  getSupportedFormats,
} from '../webgl/GLUtils.js';

import {
  BASE_VERT,
  SIMPLE_VERT,
  COPY_FRAG,
  CLEAR_FRAG,
  SPLAT_FRAG,
  SINK_FRAG,
  ADVECTION_FRAG,
  ADVECTION_REVERSE_FRAG,
  MACCORMACK_FRAG,
  BFECC_FRAG,
  BOUNDARY_FRAG,
  VISCOSITY_FRAG,
  CURL_FRAG,
  VORTICITY_FRAG,
  DIVERGENCE_FRAG,
  PRESSURE_FRAG,
  GRADIENT_SUBTRACT_FRAG,
  DISPLAY_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_BLUR_FRAG,
  BODY_FORCE_FRAG,
  OBSTACLE_PAINT_FRAG,
  OBSTACLE_CLEAR_FRAG,
} from './Shaders.js';

export class FluidSimulation {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ supportHalfFloat: boolean }} ext
   * @param {import('../config.js').CONFIG} config  Shared live config object
   */
  constructor(gl, ext, config) {
    this.gl     = gl;
    this.ext    = ext;
    this.config = config;

    this._formats = getSupportedFormats(gl, ext.supportHalfFloat);
    this._quad    = createQuad(gl);

    this._compilePrograms();
    this._createFBOs();

    // Hue state for colorful mode
    this._hue = Math.random() * 360;
  }

  /**
   * Release every GPU resource owned by this instance: shader programs,
   * textures, framebuffers, the unit quad VAO/VBO. Idempotent — safe to
   * call multiple times. Always invoke before discarding the reference,
   * otherwise textures from old simulations leak across adaptive resizes
   * and perf-mode toggles and can OOM mobile GPUs after a few minutes.
   */
  destroy() {
    const { gl } = this;
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._prog) {
      for (const k of Object.keys(this._prog)) {
        try { gl.deleteProgram(this._prog[k].program); } catch (_) {}
      }
      this._prog = null;
    }

    const doubles = ['velocity', 'dye', 'pressure', 'obstacles'];
    const singles = ['divergence', 'curl',
                     'dyeTmpFwd', 'dyeTmpBak', 'viscB', 'bloomFBO', 'bloomTemp'];
    for (const k of doubles) { destroyDoubleFBO(gl, this[k]); this[k] = null; }
    for (const k of singles) { destroyFBO(gl, this[k]);       this[k] = null; }

    if (this._quad) {
      try { gl.deleteBuffer(this._quad.vbo);    } catch (_) {}
      try { gl.deleteVertexArray(this._quad.vao); } catch (_) {}
      this._quad = null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Program compilation
     ────────────────────────────────────────────────────────────────── */
  _compilePrograms() {
    const { gl } = this;

    this._prog = {
      copy:             createProgram(gl, SIMPLE_VERT, COPY_FRAG),
      clear:            createProgram(gl, SIMPLE_VERT, CLEAR_FRAG),
      splat:            createProgram(gl, SIMPLE_VERT, SPLAT_FRAG),
      sink:             createProgram(gl, SIMPLE_VERT, SINK_FRAG),
      advection:        createProgram(gl, SIMPLE_VERT, ADVECTION_FRAG),
      advectionRev:     createProgram(gl, SIMPLE_VERT, ADVECTION_REVERSE_FRAG),
      maccormack:       createProgram(gl, SIMPLE_VERT, MACCORMACK_FRAG),
      bfecc:            createProgram(gl, SIMPLE_VERT, BFECC_FRAG),
      boundary:         createProgram(gl, SIMPLE_VERT, BOUNDARY_FRAG),
      viscosity:        createProgram(gl, BASE_VERT,   VISCOSITY_FRAG),
      curl:             createProgram(gl, BASE_VERT,   CURL_FRAG),
      vorticity:        createProgram(gl, BASE_VERT,   VORTICITY_FRAG),
      divergence:       createProgram(gl, BASE_VERT,   DIVERGENCE_FRAG),
      pressure:         createProgram(gl, BASE_VERT,   PRESSURE_FRAG),
      gradientSubtract: createProgram(gl, BASE_VERT,   GRADIENT_SUBTRACT_FRAG),
      display:          createProgram(gl, SIMPLE_VERT, DISPLAY_FRAG),
      bloomPrefilter:   createProgram(gl, SIMPLE_VERT, BLOOM_PREFILTER_FRAG),
      bloomBlur:        createProgram(gl, SIMPLE_VERT, BLOOM_BLUR_FRAG),
      bodyForce:        createProgram(gl, SIMPLE_VERT, BODY_FORCE_FRAG),
      obstaclePaint:    createProgram(gl, SIMPLE_VERT, OBSTACLE_PAINT_FRAG),
      obstacleClear:    createProgram(gl, SIMPLE_VERT, OBSTACLE_CLEAR_FRAG),
    };
  }

  /* ──────────────────────────────────────────────────────────────────
     FBO creation
     ────────────────────────────────────────────────────────────────── */
  _createFBOs() {
    const { gl, config } = this;
    const fmt = this._formats;
    const simW = this._clampRes(config.SIM_RESOLUTION);
    const simH = simW;
    const dyeW = this._clampRes(config.DYE_RESOLUTION);
    const dyeH = dyeW;

    this.velocity   = createDoubleFBO(gl, simW, simH, fmt.rg.internalFormat, fmt.rg.format, fmt.rg.type, gl.LINEAR);
    this.dye        = createDoubleFBO(gl, dyeW, dyeH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
    this.pressure   = createDoubleFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);
    this.divergence = createFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);
    this.curl       = createFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);

    // MacCormack temporaries for the dye field — must be separate from
    // the dye ping-pong because the original field φ_n must remain
    // intact across the forward, backward and combiner passes.
    // (Velocity self-advection no longer uses MacCormack — see step()
    // for the rationale — so no velocity tmp FBOs are needed.)
    this.dyeTmpFwd  = createFBO(gl, dyeW, dyeH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
    this.dyeTmpBak  = createFBO(gl, dyeW, dyeH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);

    // Frozen RHS for the implicit viscosity Jacobi solve. Reused as scratch.
    this.viscB      = createFBO(gl, simW, simH, fmt.rg.internalFormat, fmt.rg.format, fmt.rg.type, gl.NEAREST);

    // Obstacle mask. Single-channel R, NEAREST. Painted via OBSTACLE_PAINT_FRAG
    // (additive Gaussian splats), consumed by OBSTACLE_CLEAR_FRAG and the
    // display shader. Double-buffered so paint can read+write atomically.
    this.obstacles  = createDoubleFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.LINEAR);

    // Bloom FBOs (half the dye resolution)
    const bloomW = Math.max(1, Math.floor(dyeW / 2));
    const bloomH = Math.max(1, Math.floor(dyeH / 2));
    this.bloomFBO  = createFBO(gl, bloomW, bloomH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
    this.bloomTemp = createFBO(gl, bloomW, bloomH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
  }

  /** Clamp a resolution to the GPU's maximum texture size. */
  _clampRes(res) {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    return Math.min(res, max);
  }

  /* ──────────────────────────────────────────────────────────────────
     Public API
     ────────────────────────────────────────────────────────────────── */

  /**
   * Advance the simulation by `dt` seconds.
   * @param {number} dt  Delta time in seconds
   */
  step(dt) {
    const { gl, config } = this;

    // Disable blending for simulation passes
    gl.disable(gl.BLEND);

    // 1. Curl
    this._computeCurl();

    // 2. Vorticity confinement
    if (config.CURL > 0) {
      this._applyVorticity(dt);
    }

    // 3. Self-advect velocity. Always plain semi-Lagrangian — MacCormack
    //    on velocity preserves grid-scale modes, which combines with the
    //    vorticity-confinement gradient to produce a stable checkerboard
    //    "trame" once viscosity is at zero. The user-facing HQ-advect
    //    toggle still applies to dye below, where the limiter works as
    //    intended without an energy source feeding back into itself.
    this._advect(this.velocity, this.velocity, config.VELOCITY_DISSIPATION, dt);

    // 4. Implicit viscous diffusion. Skipped when ν = 0 (zero cost) AND when
    //    the resulting α would be below a noise floor — running 20 Jacobi
    //    iterations for an essentially-identity transform was the root cause
    //    of a faint grid pattern at very low ν.
    if (config.VISCOSITY > 0) {
      this._applyViscosity(dt);
    }

    // 5. Enforce velocity boundary BEFORE divergence so the projection sees
    //    a no-penetration field. Otherwise the BC patch would re-introduce
    //    divergence in the cells next to the wall.
    this._enforceVelocityBoundary();

    // 6. Divergence
    this._computeDivergence();

    // 7. Clear / fade pressure before solving
    this._fadePressure(config.PRESSURE);

    // 8. Pressure Jacobi solve. Pressure FBOs use CLAMP_TO_EDGE on the
    //    sampler, which makes a boundary cell read itself as its outer
    //    neighbour — i.e. ∂p/∂n = 0 (Neumann) is enforced implicitly on
    //    every iteration. No explicit boundary pass needed for pressure.
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      this._pressureIteration();
    }

    // 9. Gradient subtraction
    this._subtractGradient();

    // 10. Re-enforce velocity boundary post-projection (safety: gradient
    //     subtract slightly disturbs the boundary ring).
    this._enforceVelocityBoundary();

    // 10b. Zero velocity inside obstacles. Approximate boundary condition —
    //      on the next frame the projection re-smooths the resulting micro
    //      divergence at the obstacle skin. Visually sufficient for static
    //      sparse obstacles; see anouk-cfd.md for the proper way.
    this._clearVelocityInObstacles();

    // 11. Advect dye. Three schemes available:
    //       'standard'   — semi-Lagrangian (1 pass, most dissipative)
    //       'maccormack' — 3 passes; correction at destination
    //       'bfecc'      — 3 passes; correction of source field, then re-advect
    //     BFECC is sharper than MacCormack on thin filaments (Selle 2008
    //     §4.2) at identical GPU cost (the first two passes are shared).
    //     `HIGH_QUALITY_ADVECTION` is the legacy boolean — when set true
    //     and DYE_ADVECTION is unset, fall back to MacCormack.
    const scheme = config.DYE_ADVECTION
                || (config.HIGH_QUALITY_ADVECTION ? 'maccormack' : 'standard');
    if (scheme === 'maccormack') {
      this._advectMacCormack(this.dye, this.velocity, this.dyeTmpFwd, this.dyeTmpBak, config.DENSITY_DISSIPATION, dt);
    } else if (scheme === 'bfecc') {
      this._advectBFECC(this.dye, this.velocity, this.dyeTmpFwd, this.dyeTmpBak, config.DENSITY_DISSIPATION, dt);
    } else {
      this._advect(this.dye, this.velocity, config.DENSITY_DISSIPATION, dt);
    }
  }

  /**
   * Add a velocity + colour splat at UV coordinates (x, y).
   *
   * @param {number} x   UV x  [0, 1]
   * @param {number} y   UV y  [0, 1]
   * @param {number} dx  Velocity x (UV units/s)
   * @param {number} dy  Velocity y (UV units/s)
   * @param {{ r, g, b }} color  Dye colour
   */
  splat(x, y, dx, dy, color) {
    const { gl, config } = this;
    const aspectRatio = gl.canvas.width / gl.canvas.height;

    const { program, uniforms } = this._prog.splat;
    gl.useProgram(program);

    // --- velocity splat ---
    gl.uniform1i(uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(uniforms.uAspectRatio, aspectRatio);
    gl.uniform3f(uniforms.uColor, dx, dy, 0);
    gl.uniform2f(uniforms.uPoint, x, y);
    gl.uniform1f(uniforms.uRadius, config.SPLAT_RADIUS / 100);
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();

    // --- dye splat ---
    gl.uniform1i(uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform3f(uniforms.uColor, color.r, color.g, color.b);
    gl.uniform1f(uniforms.uRadius, config.SPLAT_RADIUS / 100);
    this._blit(this.dye.write.fbo, this.dye.write.width, this.dye.write.height);
    this.dye.swap();
  }

  /**
   * Drain dye in a Gaussian neighbourhood. Multiplicative — dye RGB at
   * each pixel is scaled by `(1 - amount * gauss(r))`, clamped to 0.
   * Velocity is intentionally untouched (sinks are dye-only in v1).
   *
   * @param {number} x       UV x [0, 1]
   * @param {number} y       UV y [0, 1]
   * @param {number} amount  Peak drain fraction at the centre this
   *                         frame (e.g. 0.05 removes 5 % per frame at
   *                         the bull's-eye, less in the falloff).
   */
  drainDye(x, y, amount) {
    const { gl, config } = this;
    if (!(amount > 0)) return;
    const aspectRatio = gl.canvas.width / gl.canvas.height;
    const { program, uniforms } = this._prog.sink;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform1f(uniforms.uAspectRatio, aspectRatio);
    gl.uniform1f(uniforms.uAmount, amount);
    gl.uniform2f(uniforms.uPoint, x, y);
    gl.uniform1f(uniforms.uRadius, config.SPLAT_RADIUS / 100);
    this._blit(this.dye.write.fbo, this.dye.write.width, this.dye.write.height);
    this.dye.swap();
  }

  /**
   * Apply a uniform body force to the entire velocity field for `dt`
   * seconds. Used by the accelerometer/tilt input. A uniform force is
   * divergence-free, so it can be applied at any point in the step
   * without violating mass conservation. We call it from main.js right
   * before `step()` so the force enters the advection cycle the same
   * frame it's emitted.
   *
   * No-op when the magnitude is essentially zero — saves a draw call
   * on every frame the device is held still.
   *
   * @param {number} fx  Force in UV/s² along screen X
   * @param {number} fy  Force in UV/s² along screen Y (UV.y=1 is top)
   * @param {number} dt  Δt in seconds
   */
  applyBodyForce(fx, fy, dt) {
    if (Math.abs(fx) + Math.abs(fy) < 1e-5) return;
    const { gl } = this;
    const { program, uniforms } = this._prog.bodyForce;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uVelocity,  this.velocity.read.attach(0));
    gl.uniform1i(uniforms.uObstacles, this.obstacles.read.attach(1));
    gl.uniform2f(uniforms.uForce, fx, fy);
    gl.uniform1f(uniforms.uDt, dt);
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();
  }

  /**
   * Paint or erase obstacle mass at UV (x, y). Additive Gaussian splat
   * into the obstacle ping-pong; clamped to [0,1] inside the shader.
   *
   * @param {number} x  UV x [0,1]
   * @param {number} y  UV y [0,1]
   * @param {number} radius  Gaussian radius (UV-fraction-of-shorter-side)
   * @param {number} value   +1 to paint, -1 to erase
   */
  paintObstacle(x, y, radius = 0.04, value = 1) {
    const { gl } = this;
    const aspectRatio = gl.canvas.width / gl.canvas.height;
    const { program, uniforms } = this._prog.obstaclePaint;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uTarget, this.obstacles.read.attach(0));
    gl.uniform1f(uniforms.uAspectRatio, aspectRatio);
    gl.uniform1f(uniforms.uValue, value);
    gl.uniform2f(uniforms.uPoint, x, y);
    gl.uniform1f(uniforms.uRadius, radius);
    this._blit(this.obstacles.write.fbo, this.obstacles.write.width, this.obstacles.write.height);
    this.obstacles.swap();
  }

  /** Wipe every painted obstacle. */
  clearObstacles() {
    const { gl } = this;
    for (const fbo of [this.obstacles.read.fbo, this.obstacles.write.fbo]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** Zero velocity inside obstacle cells. Cheap full-screen pass. */
  _clearVelocityInObstacles() {
    const { gl } = this;
    const { program, uniforms } = this._prog.obstacleClear;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uVelocity,  this.velocity.read.attach(0));
    gl.uniform1i(uniforms.uObstacles, this.obstacles.read.attach(1));
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();
  }

  /**
   * Render the dye texture (+ optional bloom) to the default framebuffer.
   *
   * @param {WebGLFramebuffer|null} targetFBO  null = canvas
   * @param {number} w  Target width
   * @param {number} h  Target height
   */
  render(targetFBO, w, h) {
    const { gl, config } = this;

    let bloomFBO = null;
    if (config.BLOOM) {
      bloomFBO = this._renderBloom();
    }

    const { program, uniforms } = this._prog.display;
    gl.useProgram(program);

    gl.uniform1i(uniforms.uTexture,  this.dye.read.attach(0));
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(1));
    gl.uniform1i(uniforms.uShading,  config.SHADING ? 1 : 0);

    // Obstacle mask is always bound (cleared FBO = no-op)
    gl.uniform1i(uniforms.uObstacles, this.obstacles.read.attach(3));

    // Always bind something to unit 2 (required by GLSL even when the branch is not taken)
    const bloomTex = (config.BLOOM && bloomFBO) ? bloomFBO : this.dye.read;
    gl.uniform1i(uniforms.uBloom,          bloomTex.attach(2));
    gl.uniform1i(uniforms.uUseBloom,       (config.BLOOM && bloomFBO) ? 1 : 0);
    gl.uniform1f(uniforms.uBloomIntensity, config.BLOOM_INTENSITY);

    this._blit(targetFBO, w, h);
  }

  /** Reset the dye and velocity fields to zero. */
  reset() {
    const { gl } = this;

    const clearColor = [0, 0, 0, 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.velocity.read.fbo);
    gl.clearColor(...clearColor);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.velocity.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dye.read.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dye.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pressure.read.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pressure.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Generate an HSL colour for automatic colorful mode.
   * @param {number} deltaTime  dt in seconds
   * @returns {{ r: number, g: number, b: number }}
   */
  generateColor(deltaTime) {
    if (this.config.COLORFUL) {
      this._hue = (this._hue + this.config.COLOR_UPDATE_SPEED * deltaTime) % 360;
    }
    return hsvToRgb(this._hue / 360, 1.0, 1.0, this.config.DYE_BRIGHTNESS);
  }

  /* ──────────────────────────────────────────────────────────────────
     Simulation passes (private)
     ────────────────────────────────────────────────────────────────── */

  _computeCurl() {
    const { gl } = this;
    const { program, uniforms } = this._prog.curl;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(0));
    this._blit(this.curl.fbo, this.curl.width, this.curl.height);
  }

  _applyVorticity(dt) {
    const { gl, config } = this;
    const { program, uniforms } = this._prog.vorticity;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(uniforms.uCurlStrength, config.CURL);
    gl.uniform1f(uniforms.uDt, dt);
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();
  }

  _advect(target, velocityFBO, dissipation, dt) {
    const { gl } = this;
    const { program, uniforms } = this._prog.advection;
    gl.useProgram(program);
    const velTex = velocityFBO.read;
    const srcTex = target.read;
    gl.uniform1i(uniforms.uVelocity,    velTex.attach(0));
    gl.uniform1i(uniforms.uSource,      srcTex.attach(1));
    gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
    gl.uniform2f(uniforms.uDyeTexelSize, srcTex.texelSizeX, srcTex.texelSizeY);
    gl.uniform1f(uniforms.uDt, dt);
    gl.uniform1f(uniforms.uDissipation, dissipation);
    this._blit(target.write.fbo, target.write.width, target.write.height);
    target.swap();
  }

  /**
   * MacCormack/Selle advection — three passes:
   *   φ_forward = advect(φ_n, +dt)
   *   φ_back    = advect(φ_forward, -dt)
   *   φ_new    = limiter( φ_forward + 0.5 * (φ_n - φ_back) ) * dissipation
   *
   * The carrier velocity (`velocityFBO.read`) is frozen across all three
   * passes — for self-advection this is v_n; for dye it's the latest
   * projected velocity.
   *
   * @param {DoubleFBO} target       Field being advected (read = φ_n; write swapped at end)
   * @param {DoubleFBO} velocityFBO  Carrier (only `.read` is sampled)
   * @param {FBO} tmpFwd             Scratch FBO at target's resolution / format
   * @param {FBO} tmpBak             Scratch FBO at target's resolution / format
   */
  _advectMacCormack(target, velocityFBO, tmpFwd, tmpBak, dissipation, dt) {
    const { gl } = this;
    const velTex = velocityFBO.read;
    const phiN   = target.read;

    // ── Pass 1: forward advect φ_n into tmpFwd (no dissipation, raw value).
    {
      const { program, uniforms } = this._prog.advection;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(0));
      gl.uniform1i(uniforms.uSource,      phiN.attach(1));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, phiN.texelSizeX,   phiN.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      gl.uniform1f(uniforms.uDissipation, 1.0);
      this._blit(tmpFwd.fbo, tmpFwd.width, tmpFwd.height);
    }

    // ── Pass 2: reverse advect tmpFwd into tmpBak (carrier still v_n).
    {
      const { program, uniforms } = this._prog.advectionRev;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(0));
      gl.uniform1i(uniforms.uSource,      tmpFwd.attach(1));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, tmpFwd.texelSizeX, tmpFwd.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      this._blit(tmpBak.fbo, tmpBak.width, tmpBak.height);
    }

    // ── Pass 3: combine + limiter, write to target.write, swap.
    {
      const { program, uniforms } = this._prog.maccormack;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uPhi,         phiN.attach(0));
      gl.uniform1i(uniforms.uPhiForward,  tmpFwd.attach(1));
      gl.uniform1i(uniforms.uPhiBack,     tmpBak.attach(2));
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(3));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, phiN.texelSizeX,   phiN.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      gl.uniform1f(uniforms.uDissipation, dissipation);
      this._blit(target.write.fbo, target.write.width, target.write.height);
      target.swap();
    }
  }

  /**
   * BFECC dye advection. Passes 1 and 2 are byte-for-byte identical to
   * the MacCormack pipeline (forward then reverse advect); only the
   * combiner pass differs. We don't share a helper because the two
   * methods may diverge later (e.g. Anouk's wishlist mentions a per-axis
   * limiter for BFECC) and inlining keeps both call sites readable.
   */
  _advectBFECC(target, velocityFBO, tmpFwd, tmpBak, dissipation, dt) {
    const { gl } = this;
    const velTex = velocityFBO.read;
    const phiN   = target.read;

    // ── Pass 1: forward advect φ_n into tmpFwd (no dissipation).
    {
      const { program, uniforms } = this._prog.advection;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(0));
      gl.uniform1i(uniforms.uSource,      phiN.attach(1));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, phiN.texelSizeX,   phiN.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      gl.uniform1f(uniforms.uDissipation, 1.0);
      this._blit(tmpFwd.fbo, tmpFwd.width, tmpFwd.height);
    }

    // ── Pass 2: reverse advect tmpFwd into tmpBak (carrier still v_n).
    {
      const { program, uniforms } = this._prog.advectionRev;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(0));
      gl.uniform1i(uniforms.uSource,      tmpFwd.attach(1));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, tmpFwd.texelSizeX, tmpFwd.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      this._blit(tmpBak.fbo, tmpBak.width, tmpBak.height);
    }

    // ── Pass 3: BFECC combiner — corrects the source field and re-advects
    //           in a single fragment (linearity of bilerp does the merging).
    {
      const { program, uniforms } = this._prog.bfecc;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uPhi,         phiN.attach(0));
      gl.uniform1i(uniforms.uPhiBack,     tmpBak.attach(1));
      gl.uniform1i(uniforms.uVelocity,    velTex.attach(2));
      gl.uniform2f(uniforms.uTexelSize,    velTex.texelSizeX, velTex.texelSizeY);
      gl.uniform2f(uniforms.uDyeTexelSize, phiN.texelSizeX,   phiN.texelSizeY);
      gl.uniform1f(uniforms.uDt, dt);
      gl.uniform1f(uniforms.uDissipation, dissipation);
      this._blit(target.write.fbo, target.write.width, target.write.height);
      target.swap();
    }
  }

  /**
   * Free-slip boundary on the velocity field. Single full-screen pass on the
   * (small) velocity grid → negligible cost. Reads from velocity.read,
   * writes to velocity.write, swaps.
   */
  _enforceVelocityBoundary() {
    const { gl } = this;
    const { program, uniforms } = this._prog.boundary;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform2i(uniforms.uSize, this.velocity.width, this.velocity.height);
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();
  }

  /**
   * Implicit viscous diffusion. Solves (I - νΔt∇²) v_new = v_advected via
   * Jacobi iteration. The RHS `b` is copied into `viscB` once and stays
   * frozen while the velocity ping-pong holds the iterate `x`.
   *
   * α is multiplied by N² so the user-facing VISCOSITY value is roughly
   * resolution-independent (h = 1/N → 1/h² = N²).
   */
  _applyViscosity(dt) {
    const { gl, config } = this;
    const N      = this.velocity.width;
    const alpha  = config.VISCOSITY * dt * (N * N);
    // Early-out below the noise floor: 20 Jacobi passes that each only
    // perturb the field by < 1 ULP of fp16/fp32 simply etch the texel grid
    // into the velocity texture. Below α≈1e-3 the visible diffusion is
    // imperceptible anyway so we skip the whole solve.
    if (alpha < 1e-3) return;

    // Iteration scheduling: at small α the operator is close to identity
    // and 4 passes suffice. At large α the spectral radius approaches 1 so
    // residual decays slowly; bump the cap up to 40 iterations to keep
    // reduction per frame around 50% even at the slider top (α≈14).
    const baseCap   = config.VISCOSITY_ITERATIONS;
    const stretched = alpha > 5 ? Math.max(baseCap, 40) : baseCap;
    const iters = Math.max(4, Math.min(
      stretched,
      Math.ceil(2 + 18 * Math.min(1, alpha * 4))
    ));

    // 1. Snapshot the advected velocity into the immutable RHS texture.
    {
      const { program, uniforms } = this._prog.copy;
      gl.useProgram(program);
      gl.uniform1i(uniforms.uTexture, this.velocity.read.attach(0));
      this._blit(this.viscB.fbo, this.viscB.width, this.viscB.height);
    }

    // 2. Jacobi iterations: x_{k+1} = (b + α (xL+xR+xT+xB)) / (1 + 4α)
    const { program, uniforms } = this._prog.viscosity;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1f(uniforms.uAlpha, alpha);
    gl.uniform1i(uniforms.uB, this.viscB.attach(1));
    for (let i = 0; i < iters; i++) {
      gl.uniform1i(uniforms.uX, this.velocity.read.attach(0));
      this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
      this.velocity.swap();
    }
  }

  _computeDivergence() {
    const { gl } = this;
    const { program, uniforms } = this._prog.divergence;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(0));
    this._blit(this.divergence.fbo, this.divergence.width, this.divergence.height);
  }

  _fadePressure(value) {
    const { gl } = this;
    const { program, uniforms } = this._prog.clear;
    gl.useProgram(program);
    gl.uniform1i(uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(uniforms.uValue, value);
    this._blit(this.pressure.write.fbo, this.pressure.write.width, this.pressure.write.height);
    this.pressure.swap();
  }

  _pressureIteration() {
    const { gl } = this;
    const { program, uniforms } = this._prog.pressure;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.pressure.texelSizeX, this.pressure.texelSizeY);
    gl.uniform1i(uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(uniforms.uDivergence, this.divergence.attach(1));
    this._blit(this.pressure.write.fbo, this.pressure.write.width, this.pressure.write.height);
    this.pressure.swap();
  }

  _subtractGradient() {
    const { gl } = this;
    const { program, uniforms } = this._prog.gradientSubtract;
    gl.useProgram(program);
    gl.uniform2f(uniforms.uTexelSize, this.pressure.texelSizeX, this.pressure.texelSizeY);
    gl.uniform1i(uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(uniforms.uVelocity, this.velocity.read.attach(1));
    this._blit(this.velocity.write.fbo, this.velocity.write.width, this.velocity.write.height);
    this.velocity.swap();
  }

  /* ──────────────────────────────────────────────────────────────────
     Bloom (optional post-process)
     ────────────────────────────────────────────────────────────────── */

  _renderBloom() {
    const { gl, config } = this;

    // Prefilter (threshold extract)
    const { program: pf, uniforms: uf } = this._prog.bloomPrefilter;
    gl.useProgram(pf);
    gl.uniform1i(uf.uTexture, this.dye.read.attach(0));
    gl.uniform1f(uf.uThreshold, config.BLOOM_THRESHOLD);
    gl.uniform1f(uf.uSoftKnee, config.BLOOM_SOFT_KNEE);
    this._blit(this.bloomFBO.fbo, this.bloomFBO.width, this.bloomFBO.height);

    // Iterative blur passes
    const { program: pb, uniforms: ub } = this._prog.bloomBlur;
    gl.useProgram(pb);

    for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
      // Horizontal
      gl.uniform1i(ub.uTexture, this.bloomFBO.attach(0));
      gl.uniform2f(ub.uTexelSize, this.bloomFBO.texelSizeX, this.bloomFBO.texelSizeY);
      gl.uniform2f(ub.uDirection, 1, 0);
      this._blit(this.bloomTemp.fbo, this.bloomTemp.width, this.bloomTemp.height);

      // Vertical
      gl.uniform1i(ub.uTexture, this.bloomTemp.attach(0));
      gl.uniform2f(ub.uTexelSize, this.bloomTemp.texelSizeX, this.bloomTemp.texelSizeY);
      gl.uniform2f(ub.uDirection, 0, 1);
      this._blit(this.bloomFBO.fbo, this.bloomFBO.width, this.bloomFBO.height);
    }

    return this.bloomFBO;
  }

  /* ──────────────────────────────────────────────────────────────────
     Helpers
     ────────────────────────────────────────────────────────────────── */

  /**
   * Bind the target FBO, set the viewport, and draw the full-screen quad.
   * Pass `null` for `targetFBO` to render to the canvas.
   */
  _blit(targetFBO, w, h) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
    gl.viewport(0, 0, w, h);
    this._quad.draw();
  }

  /** Expose the velocity FBO for external reads (e.g. particle system). */
  get velocityTexture() { return this.velocity.read; }

  /** Expose the dye FBO for external reads. */
  get dyeTexture() { return this.dye.read; }
}

/* ──────────────────────────────────────────────────────────────────────
   Colour helpers
   ────────────────────────────────────────────────────────────────────── */

/**
 * Convert HSV (hue [0,1], saturation [0,1], value [0,1]) to RGB object.
 * `brightness` scales the output — use `CONFIG.DYE_BRIGHTNESS` to keep values
 * consistent with the dye brightness setting everywhere.
 * @returns {{ r: number, g: number, b: number }}
 */
function hsvToRgb(h, s, v, brightness = 1) {
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: r * brightness, g: g * brightness, b: b * brightness };
}
