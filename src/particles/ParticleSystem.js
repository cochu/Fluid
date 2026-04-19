/**
 * ParticleSystem.js – GPU-accelerated particle system.
 *
 * Particle positions are stored in a float texture (RGBA16F).
 * Each texel represents one particle: (x, y, lifetime, 0).
 *
 * Update pass: fragment shader advects each particle using the fluid
 *              velocity field and decrements its lifetime.
 * Render pass: vertex shader reads position via `texelFetch` using
 *              `gl_VertexID`; particles drawn as GL_POINTS with soft glow.
 */

import { createProgram, createDoubleFBO, createFBO } from '../webgl/GLUtils.js';
import {
  SIMPLE_VERT,
  PARTICLE_UPDATE_FRAG,
  PARTICLE_SPAWN_FRAG,
  PARTICLE_RENDER_VERT,
  PARTICLE_RENDER_FRAG,
} from '../fluid/Shaders.js';

export class ParticleSystem {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ supportHalfFloat: boolean }} ext
   * @param {import('../config.js').CONFIG} config
   */
  constructor(gl, ext, config) {
    this.gl     = gl;
    this.ext    = ext;
    this.config = config;

    this._count    = 0;
    this._texW     = 0;
    this._texH     = 0;
    this._posFBO   = null;  // double FBO for ping-pong
    this._indexBuf = null;
    this._randSeed = 0;
    this._t0       = performance.now();

    this._compilePrograms();
    this._init(config.PARTICLE_COUNT);
  }

  /* ──────────────────────────────────────────────────────────────────
     Initialisation
     ────────────────────────────────────────────────────────────────── */

  _compilePrograms() {
    const { gl } = this;
    this._updateProg = createProgram(gl, SIMPLE_VERT, PARTICLE_UPDATE_FRAG);
    this._spawnProg  = createProgram(gl, SIMPLE_VERT, PARTICLE_SPAWN_FRAG);
    this._renderProg = createProgram(gl, PARTICLE_RENDER_VERT, PARTICLE_RENDER_FRAG);
  }

  /**
   * (Re-)initialise particle buffers for a given count.
   * Called on startup and when the user changes PARTICLE_COUNT.
   */
  _init(count) {
    const { gl } = this;

    // Track the requested count so resize() can compare correctly
    this._requestedCount = count;

    // Choose texture dimensions — square-ish, power of 2 not required
    const side = Math.ceil(Math.sqrt(count));
    this._texW  = side;
    this._texH  = side;
    this._count = side * side;  // actual particle capacity (≥ count)

    // Choose format — RGBA16F if available, else RGBA unsigned byte
    const internalFormat = this.ext.supportHalfFloat ? gl.RGBA16F : gl.RGBA;
    const format         = gl.RGBA;
    const type           = this.ext.supportHalfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    // Seed initial positions (random scatter, full lifetime)
    const data = new Float32Array(this._count * 4);
    for (let i = 0; i < this._count; i++) {
      data[i * 4 + 0] = Math.random();          // x
      data[i * 4 + 1] = Math.random();          // y
      data[i * 4 + 2] = Math.random();          // lifetime [0,1] (staggered)
      data[i * 4 + 3] = 0;
    }

    // For UNSIGNED_BYTE fallback we can't easily seed, so use empty (particles respawn)
    const initialData = this.ext.supportHalfFloat ? data : null;

    // Position double FBO
    this._posFBO = createDoubleFBO(
      gl, this._texW, this._texH,
      internalFormat, format, type, gl.NEAREST
    );

    // Upload initial data into the read FBO
    if (initialData) {
      gl.bindTexture(gl.TEXTURE_2D, this._posFBO.read.texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, internalFormat,
        this._texW, this._texH, 0,
        format, type, initialData
      );
    }

    // Index buffer [0, 1, 2, ..., count-1] for the render draw call
    this._buildIndexBuffer();
  }

  _buildIndexBuffer() {
    const { gl } = this;

    if (this._indexBuf) gl.deleteBuffer(this._indexBuf);

    const indices = new Int32Array(this._count);
    for (let i = 0; i < this._count; i++) indices[i] = i;

    // We don't actually need to upload this — WebGL2 has gl_VertexID.
    // We just need to know the draw count.
    this._drawCount = this._count;
  }

  /* ──────────────────────────────────────────────────────────────────
     Per-frame update & render
     ────────────────────────────────────────────────────────────────── */

  /**
   * Update particle positions (GPU pass).
   * @param {import('../webgl/GLUtils.js').FBO} velocityFBO  Read-only velocity FBO
   * @param {number} dt  Delta time in seconds
   */
  update(velocityFBO, dt) {
    const { gl } = this;

    const { program, uniforms } = this._updateProg;
    gl.useProgram(program);

    gl.uniform1i(uniforms.uPositions, this._posFBO.read.attach(0));
    gl.uniform1i(uniforms.uVelocity,  velocityFBO.attach(1));
    gl.uniform1f(uniforms.uDt,        dt);

    // Render to position write buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._posFBO.write.fbo);
    gl.viewport(0, 0, this._texW, this._texH);
    this._drawQuad();

    this._posFBO.swap();
  }

  /**
   * Drop a batch of particles around UV (x, y).
   *
   * For each particle, with probability `prob` it is teleported to the drop
   * point with a small jitter (radius `radius` in UV units) and re-armed.
   * Designed to be called once per animation frame while the user drags the
   * dedicated drop button across the canvas.
   *
   * @param {number} x   UV x [0,1]
   * @param {number} y   UV y [0,1]
   * @param {number} [prob]    Fraction of particles relocated this call
   * @param {number} [radius]  Jitter radius in UV units
   */
  spawnAt(x, y, prob = this.config.PARTICLE_DROP_RATE, radius = this.config.PARTICLE_DROP_RADIUS) {
    const { gl } = this;
    const { program, uniforms } = this._spawnProg;
    gl.useProgram(program);

    this._randSeed = (this._randSeed + 0.1337) % 1;

    gl.uniform1i(uniforms.uPositions, this._posFBO.read.attach(0));
    gl.uniform2f(uniforms.uPoint,     x, y);
    gl.uniform1f(uniforms.uRadius,    radius);
    gl.uniform1f(uniforms.uSpawnProb, prob);
    gl.uniform1f(uniforms.uRandSeed,  this._randSeed);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._posFBO.write.fbo);
    gl.viewport(0, 0, this._texW, this._texH);
    this._drawQuad();

    this._posFBO.swap();
  }

  /**
   * Render particles onto the current framebuffer.
   * Assumes blending is already set up by the caller.
   *
   * @param {number} canvasW  Canvas width in pixels
   * @param {number} canvasH  Canvas height in pixels
   * @param {import('../webgl/GLUtils.js').FBO} velocityFBO
   */
  render(canvasW, canvasH, velocityFBO) {
    const { gl, config } = this;

    const { program, uniforms } = this._renderProg;
    gl.useProgram(program);

    gl.uniform1i(uniforms.uPositions,  this._posFBO.read.attach(0));
    gl.uniform1i(uniforms.uVelocity,   velocityFBO.attach(1));
    gl.uniform2i(uniforms.uTexSize,    this._texW, this._texH);
    gl.uniform1f(uniforms.uPointSize,  config.PARTICLE_SIZE * window.devicePixelRatio);
    gl.uniform2f(uniforms.uCanvasSize, canvasW, canvasH);
    gl.uniform1f(uniforms.uTime,       (performance.now() - this._t0) * 0.001);
    // When COLORFUL is on we let the fluid's hue cycling tint the droplets;
    // otherwise we stay on the pure aqua palette so the visual reads as water.
    const tint = config.COLORFUL ? 0.55 : 0.0;
    gl.uniform1f(uniforms.uTintMix,    tint);
    // Hue picker — slow rotation so droplets re-tint over time without
    // strobing. Drives uColor used by the fragment when uTintMix > 0.
    const tSec = (performance.now() - this._t0) * 0.001;
    const h = (tSec * 0.05) % 1;
    const r = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.00));
    const g = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.33));
    const b = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.66));
    gl.uniform3f(uniforms.uColor,      r, g, b);

    // Render as points (no VAO needed — we rely on gl_VertexID)
    gl.bindVertexArray(null);
    gl.drawArrays(gl.POINTS, 0, this._drawCount);
  }

  /**
   * Resize (recreate) particle buffers when count changes.
   * Compares against the originally requested count, not the rounded-up texture size.
   * @param {number} newCount
   */
  resize(newCount) {
    if (newCount !== this._requestedCount) {
      this._init(newCount);
    }
  }

  /* ──────────────────────────────────────────────────────────────────
     Helpers
     ────────────────────────────────────────────────────────────────── */

  /** Draw a full-screen quad for the update pass. */
  _drawQuad() {
    const { gl } = this;
    // Lazily create a shared quad VAO
    if (!this._quadVAO) {
      this._quadVAO = gl.createVertexArray();
      gl.bindVertexArray(this._quadVAO);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    gl.bindVertexArray(this._quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
