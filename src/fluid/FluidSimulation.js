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
  createQuad,
  getSupportedFormats,
} from '../webgl/GLUtils.js';

import {
  BASE_VERT,
  SIMPLE_VERT,
  COPY_FRAG,
  CLEAR_FRAG,
  SPLAT_FRAG,
  ADVECTION_FRAG,
  CURL_FRAG,
  VORTICITY_FRAG,
  DIVERGENCE_FRAG,
  PRESSURE_FRAG,
  GRADIENT_SUBTRACT_FRAG,
  DISPLAY_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_BLUR_FRAG,
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

  /* ──────────────────────────────────────────────────────────────────
     Program compilation
     ────────────────────────────────────────────────────────────────── */
  _compilePrograms() {
    const { gl } = this;

    this._prog = {
      copy:             createProgram(gl, SIMPLE_VERT, COPY_FRAG),
      clear:            createProgram(gl, SIMPLE_VERT, CLEAR_FRAG),
      splat:            createProgram(gl, SIMPLE_VERT, SPLAT_FRAG),
      advection:        createProgram(gl, SIMPLE_VERT, ADVECTION_FRAG),
      curl:             createProgram(gl, BASE_VERT,   CURL_FRAG),
      vorticity:        createProgram(gl, BASE_VERT,   VORTICITY_FRAG),
      divergence:       createProgram(gl, BASE_VERT,   DIVERGENCE_FRAG),
      pressure:         createProgram(gl, BASE_VERT,   PRESSURE_FRAG),
      gradientSubtract: createProgram(gl, BASE_VERT,   GRADIENT_SUBTRACT_FRAG),
      display:          createProgram(gl, SIMPLE_VERT, DISPLAY_FRAG),
      bloomPrefilter:   createProgram(gl, SIMPLE_VERT, BLOOM_PREFILTER_FRAG),
      bloomBlur:        createProgram(gl, SIMPLE_VERT, BLOOM_BLUR_FRAG),
    };
  }

  /* ──────────────────────────────────────────────────────────────────
     FBO creation
     ────────────────────────────────────────────────────────────────── */
  _createFBOs() {
    const { gl, config } = this;
    const fmt = this._formats;
    const simW = this._calcRes(config.SIM_RESOLUTION);
    const simH = simW;
    const dyeW = this._calcRes(config.DYE_RESOLUTION);
    const dyeH = dyeW;

    this.velocity   = createDoubleFBO(gl, simW, simH, fmt.rg.internalFormat, fmt.rg.format, fmt.rg.type, gl.LINEAR);
    this.dye        = createDoubleFBO(gl, dyeW, dyeH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
    this.pressure   = createDoubleFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);
    this.divergence = createFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);
    this.curl       = createFBO(gl, simW, simH, fmt.r.internalFormat, fmt.r.format, fmt.r.type, gl.NEAREST);

    // Bloom FBOs (half the dye resolution)
    const bloomW = Math.max(1, Math.floor(dyeW / 2));
    const bloomH = Math.max(1, Math.floor(dyeH / 2));
    this.bloomFBO  = createFBO(gl, bloomW, bloomH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
    this.bloomTemp = createFBO(gl, bloomW, bloomH, fmt.rgba.internalFormat, fmt.rgba.format, fmt.rgba.type, gl.LINEAR);
  }

  /** Return a resolution that is a power-of-two ≤ the requested value. */
  _calcRes(res) {
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

    // 3. Self-advect velocity
    this._advect(this.velocity, this.velocity, config.VELOCITY_DISSIPATION, dt);

    // 4. Divergence
    this._computeDivergence();

    // 5. Clear / fade pressure before solving
    this._fadePressure(config.PRESSURE);

    // 6. Pressure Jacobi solve
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      this._pressureIteration();
    }

    // 7. Gradient subtraction
    this._subtractGradient();

    // 8. Advect dye
    this._advect(this.dye, this.velocity, config.DENSITY_DISSIPATION, dt);
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
    return hsvToRgb(this._hue / 360, 1.0, 1.0);
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
 * @returns {{ r: number, g: number, b: number }}
 */
function hsvToRgb(h, s, v) {
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
  return { r: r * 0.15, g: g * 0.15, b: b * 0.15 };
}
