/**
 * GLUtils.js – Low-level WebGL2 helpers.
 *
 * Covers shader compilation, program linking, texture/FBO creation,
 * and the double-buffer (ping-pong) FBO pattern used by the simulation.
 */

/* ──────────────────────────────────────────────────────────────────────
   Shader compilation
   ────────────────────────────────────────────────────────────────────── */

/**
 * Compile a single GLSL shader.
 * @param {WebGL2RenderingContext} gl
 * @param {number} type  gl.VERTEX_SHADER | gl.FRAGMENT_SHADER
 * @param {string} src   GLSL source string
 * @returns {WebGLShader}
 */
export function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error:\n${info}\n\nSource:\n${src}`);
  }
  return shader;
}

/**
 * Link a vertex + fragment shader into a program.
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 * @returns {{ program: WebGLProgram, uniforms: Object<string,WebGLUniformLocation> }}
 */
export function createProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);

  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error:\n${info}`);
  }

  // Enumerate and cache all active uniform locations.
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    uniforms[info.name] = gl.getUniformLocation(program, info.name);
  }

  return { program, uniforms };
}

/* ──────────────────────────────────────────────────────────────────────
   Textures & FBOs
   ────────────────────────────────────────────────────────────────────── */

/**
 * Create a 2-D texture and an FBO that writes into it.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {number} w
 * @param {number} h
 * @param {number} internalFormat  e.g. gl.RGBA16F
 * @param {number} format          e.g. gl.RGBA
 * @param {number} type            e.g. gl.HALF_FLOAT
 * @param {number} filter          gl.LINEAR | gl.NEAREST
 * @returns {FBO}
 */
export function createFBO(gl, w, h, internalFormat, format, type, filter) {
  gl.activeTexture(gl.TEXTURE0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0
  );
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  return {
    texture,
    fbo,
    width: w,
    height: h,
    texelSizeX: 1 / w,
    texelSizeY: 1 / h,
    /**
     * Bind this texture to a texture unit and return the unit index.
     *
     * Side effect: calls `gl.activeTexture` and `gl.bindTexture` — this modifies
     * global GL texture-unit state.  Always call this immediately before setting
     * the corresponding sampler uniform so binding order is predictable.
     *
     * @param {number} id  Texture unit index (0-based)
     * @returns {number}   The same `id`, for convenient use in `gl.uniform1i` calls.
     */
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      return id;
    },
  };
}

/**
 * Create a ping-pong double FBO so we can read from one and write to the other.
 *
 * The `.read` / `.write` getters always point to the current read/write buffers.
 * Call `.swap()` to flip them after each simulation step.
 */
export function createDoubleFBO(gl, w, h, internalFormat, format, type, filter) {
  let fbo0 = createFBO(gl, w, h, internalFormat, format, type, filter);
  let fbo1 = createFBO(gl, w, h, internalFormat, format, type, filter);

  return {
    width: w,
    height: h,
    texelSizeX: fbo0.texelSizeX,
    texelSizeY: fbo0.texelSizeY,
    get read() { return fbo0; },
    get write() { return fbo1; },
    swap() { [fbo0, fbo1] = [fbo1, fbo0]; },
  };
}

/**
 * Release a single FBO created via `createFBO`. After this call the
 * object MUST NOT be used again — its texture, framebuffer and any cached
 * sampler bindings are gone. Always call this when discarding a sim or
 * adaptive-resize tear-down to avoid GPU memory leaks.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{texture:WebGLTexture, fbo:WebGLFramebuffer}} target
 */
export function destroyFBO(gl, target) {
  if (!target) return;
  try { gl.deleteTexture(target.texture); } catch (_) { /* noop */ }
  try { gl.deleteFramebuffer(target.fbo); } catch (_) { /* noop */ }
}

/**
 * Release both buffers of a double FBO created via `createDoubleFBO`.
 * Safe to call with `null` or a partially initialised object.
 */
export function destroyDoubleFBO(gl, target) {
  if (!target) return;
  destroyFBO(gl, target.read);
  destroyFBO(gl, target.write);
}


export function resizeDoubleFBO(gl, target, w, h, internalFormat, format, type, filter) {
  if (target.width === w && target.height === h) return target;

  // We need the old read texture to blit, but for simplicity we just create fresh.
  return createDoubleFBO(gl, w, h, internalFormat, format, type, filter);
}

/* ──────────────────────────────────────────────────────────────────────
   Full-screen quad geometry
   ────────────────────────────────────────────────────────────────────── */

/**
 * Create a VAO + VBO for a full-screen triangle-strip quad.
 * Attribute 0 = vec2 position in NDC ([-1,1] range).
 */
export function createQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  // Two triangles covering the full screen
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return {
    vao, vbo,
    draw() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); },
  };
}

/* ──────────────────────────────────────────────────────────────────────
   WebGL2 context creation
   ────────────────────────────────────────────────────────────────────── */

/**
 * Obtain a WebGL2 context with the required extensions.
 *
 * Returns `null` if WebGL2 is not available.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {{ gl: WebGL2RenderingContext, ext: Object } | null}
 */
export function getWebGL2Context(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  });

  if (!gl) return null;

  // Half-float textures (always available in WebGL2 core, but check for renderable).
  const extColorBufferFloat = gl.getExtension('EXT_color_buffer_float');
  const extColorBufferHalfFloat = gl.getExtension('EXT_color_buffer_half_float');

  if (!extColorBufferFloat && !extColorBufferHalfFloat) {
    console.warn('Float render targets not supported – falling back to UNSIGNED_BYTE');
  }

  return {
    gl,
    ext: {
      colorBufferFloat: extColorBufferFloat,
      colorBufferHalfFloat: extColorBufferHalfFloat,
      /** Whether we can render to half-float FBOs. */
      supportHalfFloat: !!(extColorBufferFloat || extColorBufferHalfFloat),
    },
  };
}

/**
 * Choose the best internal format / type pair for float render targets.
 *
 * We always use RGBA16F (when available) for all targets because single- and
 * dual-channel half-float render targets are not guaranteed colour-renderable
 * on all WebGL2 implementations (especially mobile).  The wasted channels are
 * negligible for our grid sizes.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {boolean} supportHalfFloat
 * @returns {{ rgba: {internalFormat, format, type}, rg: {internalFormat, format, type}, r: {internalFormat, format, type} }}
 */
export function getSupportedFormats(gl, supportHalfFloat) {
  if (supportHalfFloat) {
    const fmt = { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    return { rgba: fmt, rg: fmt, r: fmt };
  }
  // Fallback: 8-bit RGBA — least-common-denominator, always renderable
  const fmt = { internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  return { rgba: fmt, rg: fmt, r: fmt };
}
