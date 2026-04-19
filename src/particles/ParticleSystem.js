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

    this._compilePrograms();
    this._init(config.PARTICLE_COUNT);
  }

  /* ──────────────────────────────────────────────────────────────────
     Initialisation
     ────────────────────────────────────────────────────────────────── */

  _compilePrograms() {
    const { gl } = this;
    this._updateProg = createProgram(gl, SIMPLE_VERT, PARTICLE_UPDATE_FRAG);
    this._renderProg = createProgram(gl, PARTICLE_RENDER_VERT, PARTICLE_RENDER_FRAG);
  }

  /**
   * (Re-)initialise particle buffers for a given count.
   * Called on startup and when the user changes PARTICLE_COUNT.
   */
  _init(count) {
    const { gl } = this;

    // Choose texture dimensions — square-ish, power of 2 not required
    const side = Math.ceil(Math.sqrt(count));
    this._texW  = side;
    this._texH  = side;
    this._count = side * side;

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
    const { gl, config } = this;

    // Increment random seed each frame for varied re-spawning
    this._randSeed = (this._randSeed + 0.1337) % 1;

    const { program, uniforms } = this._updateProg;
    gl.useProgram(program);

    gl.uniform1i(uniforms.uPositions,   this._posFBO.read.attach(0));
    gl.uniform1i(uniforms.uVelocity,    velocityFBO.attach(1));
    gl.uniform1f(uniforms.uDt,          dt);
    gl.uniform1f(uniforms.uLifetimeDec, dt / config.PARTICLE_LIFETIME);
    gl.uniform1f(uniforms.uRandSeed,    this._randSeed);

    // Render to position write buffer
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
    gl.uniform3f(uniforms.uColor,      1.0, 1.0, 1.0);

    // Render as points (no VAO needed — we rely on gl_VertexID)
    gl.bindVertexArray(null);
    gl.drawArrays(gl.POINTS, 0, this._drawCount);
  }

  /**
   * Resize (recreate) particle buffers when count changes.
   * @param {number} newCount
   */
  resize(newCount) {
    if (newCount !== this._count) {
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
