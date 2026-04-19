/**
 * Shaders.js – All GLSL shader sources for the fluid simulation.
 *
 * Every shader is a tagged template literal exported as a string constant.
 * WebGL2 / GLSL ES 3.00 is required.
 */

/* ══════════════════════════════════════════════════════════════════════
   VERTEX SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Base vertex shader: outputs NDC quad + UV coords + 4 neighbour UVs.
 * `uTexelSize` must be set to (1/w, 1/h) of the TARGET framebuffer.
 */
export const BASE_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;

out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;

uniform vec2 uTexelSize;

void main() {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(uTexelSize.x, 0.0);
    vR = vUv + vec2(uTexelSize.x, 0.0);
    vT = vUv + vec2(0.0, uTexelSize.y);
    vB = vUv - vec2(0.0, uTexelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Minimal vertex shader: just UV, no neighbour offsets. */
export const SIMPLE_VERT = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/* ══════════════════════════════════════════════════════════════════════
   UTILITY FRAGMENT SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/** Copy a texture unchanged. */
export const COPY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 fragColor;
void main() { fragColor = texture(uTexture, vUv); }
`;

/** Multiply texture by a scalar (used to fade pressure, etc.). */
export const CLEAR_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uValue;
out vec4 fragColor;
void main() { fragColor = uValue * texture(uTexture, vUv); }
`;

/* ══════════════════════════════════════════════════════════════════════
   FLUID SIMULATION SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Splat shader – adds a Gaussian blob of velocity or dye at a screen point.
 *
 * uPoint  : splat centre in UV [0,1]
 * uRadius : Gaussian half-width (adjusted for aspect ratio)
 * uColor  : RGB colour/velocity to add
 */
export const SPLAT_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform vec3  uColor;
uniform vec2  uPoint;
uniform float uRadius;
out vec4 fragColor;
void main() {
    vec2 p = vUv - uPoint;
    p.x   *= uAspectRatio;
    vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
    fragColor  = vec4(texture(uTarget, vUv).rgb + splat, 1.0);
}
`;

/**
 * Semi-Lagrangian advection with manual bilinear interpolation.
 *
 * Works for both velocity self-advection (dyeTexelSize == velTexelSize)
 * and dye advection (different texel sizes).
 */
export const ADVECTION_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2  uTexelSize;     // velocity texture texel
uniform vec2  uDyeTexelSize;  // source  texture texel
uniform float uDt;
uniform float uDissipation;
out vec4 fragColor;

// Manual bilinear sample (avoids precision issues on some mobile GPUs)
vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st    = uv / tsize - 0.5;
    vec2 iuv   = floor(st);
    vec2 fuv   = fract(st);
    vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
    // Trace back along velocity
    vec2 vel   = bilerp(uVelocity, vUv, uTexelSize).xy;
    vec2 coord = vUv - uDt * vel;
    fragColor  = uDissipation * bilerp(uSource, coord, uDyeTexelSize);
}
`;

/** Compute curl (z-component of ∇×v) for vorticity confinement. */
export const CURL_FRAG = /* glsl */`#version 300 es
precision mediump float;
precision mediump sampler2D;
in vec2 vUv;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float T = texture(uVelocity, vT).x;
    float B = texture(uVelocity, vB).x;
    // curl = dVy/dx - dVx/dy  (central difference)
    fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}
`;

/**
 * Vorticity confinement – injects angular momentum to restore small-scale
 * swirling that numerical diffusion would otherwise erase.
 */
export const VORTICITY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
out vec4 fragColor;
void main() {
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float T = texture(uCurl, vT).x;
    float B = texture(uCurl, vB).x;
    float C = texture(uCurl, vUv).x;

    // Gradient of |curl|
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    // Normalise (avoid div-by-zero)
    force /= length(force) + 1e-5;
    // Perpendicular to curl gradient, scaled by curl magnitude
    force  = vec2(force.y, -force.x) * uCurlStrength * C;

    vec2 vel = texture(uVelocity, vUv).xy;
    fragColor = vec4(vel + force * uDt, 0.0, 1.0);
}
`;

/** Compute velocity divergence ∇·v (central differences). */
export const DIVERGENCE_FRAG = /* glsl */`#version 300 es
precision mediump float;
precision mediump sampler2D;
in vec2 vUv;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
    float L = texture(uVelocity, vL).x;
    float R = texture(uVelocity, vR).x;
    float T = texture(uVelocity, vT).y;
    float B = texture(uVelocity, vB).y;
    fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

/**
 * Jacobi iteration for the pressure Poisson equation ∇²p = div(v).
 * Run 20-30 times each frame.
 */
export const PRESSURE_FRAG = /* glsl */`#version 300 es
precision mediump float;
precision mediump sampler2D;
in vec2 vUv;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
out vec4 fragColor;
void main() {
    float pL  = texture(uPressure, vL).x;
    float pR  = texture(uPressure, vR).x;
    float pT  = texture(uPressure, vT).x;
    float pB  = texture(uPressure, vB).x;
    float div = texture(uDivergence, vUv).x;
    float p   = (pL + pR + pT + pB - div) * 0.25;
    fragColor = vec4(p, 0.0, 0.0, 1.0);
}
`;

/**
 * Gradient subtraction – make velocity divergence-free:
 *   v_new = v - ∇p
 */
export const GRADIENT_SUBTRACT_FRAG = /* glsl */`#version 300 es
precision mediump float;
precision mediump sampler2D;
in vec2 vUv;
in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
    float pL = texture(uPressure, vL).x;
    float pR = texture(uPressure, vR).x;
    float pT = texture(uPressure, vT).x;
    float pB = texture(uPressure, vB).x;
    vec2  vel = texture(uVelocity, vUv).xy;
    vel -= 0.5 * vec2(pR - pL, pT - pB);
    fragColor  = vec4(vel, 0.0, 1.0);
}
`;

/* ══════════════════════════════════════════════════════════════════════
   DISPLAY / POST-PROCESS SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Display shader – renders the dye texture to the screen with a
 * simple exposure/gamma curve.  Optionally adds a subtle shading effect
 * based on the velocity magnitude.
 */
export const DISPLAY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform sampler2D uVelocity;
uniform float     uBloomIntensity;
uniform bool      uUseBloom;
uniform bool      uShading;
out vec4 fragColor;

// Filmic tone-map (approx. ACES)
vec3 toneMap(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}

void main() {
    vec3 c = texture(uTexture, vUv).rgb;

    if (uUseBloom) {
        vec3 bloom = texture(uBloom, vUv).rgb;
        c += bloom * uBloomIntensity;
    }

    if (uShading) {
        // Subtle shading: darken where velocity is low (looks like shadows)
        float speed = length(texture(uVelocity, vUv).xy);
        float shade = 1.0 - exp(-speed * 4.0) * 0.15;
        c *= shade;
    }

    c = toneMap(c * 1.2);
    fragColor = vec4(c, 1.0);
}
`;

/**
 * Bloom threshold / extract pass – isolates bright regions.
 */
export const BLOOM_PREFILTER_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uThreshold;
uniform float uSoftKnee;
out vec4 fragColor;
void main() {
    vec3 c = texture(uTexture, vUv).rgb;
    float brightness = max(c.r, max(c.g, c.b));
    // Soft-knee threshold curve
    float rq = clamp(brightness - uThreshold + uSoftKnee, 0.0, 2.0 * uSoftKnee);
    rq       = (rq * rq) / (4.0 * uSoftKnee + 0.00001);
    float w  = max(rq, brightness - uThreshold) / max(brightness, 0.00001);
    fragColor = vec4(c * w, 1.0);
}
`;

/** Separable Gaussian blur – one pass (horizontal or vertical). */
export const BLOOM_BLUR_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2      uTexelSize;
uniform vec2      uDirection;  // (1,0) or (0,1)
out vec4 fragColor;
// 9-tap Gaussian kernel
void main() {
    vec4 sum = vec4(0.0);
    vec2 step = uTexelSize * uDirection;
    sum += texture(uTexture, vUv - step * 4.0) * 0.0162;
    sum += texture(uTexture, vUv - step * 3.0) * 0.0540;
    sum += texture(uTexture, vUv - step * 2.0) * 0.1216;
    sum += texture(uTexture, vUv - step * 1.0) * 0.1945;
    sum += texture(uTexture, vUv             ) * 0.2270;
    sum += texture(uTexture, vUv + step * 1.0) * 0.1945;
    sum += texture(uTexture, vUv + step * 2.0) * 0.1216;
    sum += texture(uTexture, vUv + step * 3.0) * 0.0540;
    sum += texture(uTexture, vUv + step * 4.0) * 0.0162;
    fragColor = sum;
}
`;

/** Additive blend: accumulate bloom passes. */
export const BLOOM_FINAL_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform float     uIntensity;
out vec4 fragColor;
void main() {
    fragColor = texture(uTexture, vUv) + texture(uBloom, vUv) * uIntensity;
}
`;

/* ══════════════════════════════════════════════════════════════════════
   PARTICLE SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Particle position update (fragment shader renders into position texture).
 *
 * Each texel encodes one particle: (x, y, lifetime, _).
 * Particles are advected by the fluid velocity and wrap at the boundaries.
 *
 * Particles do NOT auto-respawn when they "die": dead particles stay dormant
 * until the user explicitly drops them via the dedicated drop tool
 * (see PARTICLE_SPAWN_FRAG). This avoids the disorienting effect of
 * particles randomly reappearing across the screen.
 */
export const PARTICLE_UPDATE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uPositions;  // current particle positions
uniform sampler2D uVelocity;   // fluid velocity field
uniform float     uDt;
out vec4 fragColor;

void main() {
    vec4  p        = texture(uPositions, vUv);
    vec2  pos      = p.xy;
    float lifetime = p.z;

    if (lifetime <= 0.0) {
        // Dormant — leave untouched until the user drops a fresh particle here.
        fragColor = p;
    } else {
        // Advect by velocity field, wrapping at boundaries.
        vec2 vel = texture(uVelocity, pos).xy;
        pos += vel * uDt;
        pos  = fract(pos + 1.0);
        fragColor = vec4(pos, lifetime, 0.0);
    }
}
`;

/**
 * Particle spawn / "drop" shader.
 *
 * For every particle, with probability `uSpawnProb` we relocate it to a
 * jittered position around `uPoint` and re-arm its lifetime. Used to
 * implement the drag-and-drop "pour particles" interaction.
 */
export const PARTICLE_SPAWN_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uPositions;
uniform vec2  uPoint;       // drop centre in UV
uniform float uRadius;      // jitter radius (UV units)
uniform float uSpawnProb;   // [0,1] fraction relocated this pass
uniform float uRandSeed;
out vec4 fragColor;

float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
    vec4 p = texture(uPositions, vUv);
    if (rand(vUv + uRandSeed) < uSpawnProb) {
        float a      = rand(vUv + uRandSeed + 1.7) * 6.2831853;
        float radius = sqrt(rand(vUv + uRandSeed + 3.3)) * uRadius;
        vec2  jitter = vec2(cos(a), sin(a)) * radius;
        fragColor    = vec4(uPoint + jitter, 1.0, 0.0);
    } else {
        fragColor = p;
    }
}
`;

/**
 * Particle render – VERTEX shader.
 *
 * Reads particle position from the position texture using gl_VertexID.
 * Outputs gl_Position and particle lifetime (for alpha fade in fragment).
 */
export const PARTICLE_RENDER_VERT = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uPositions;
uniform ivec2     uTexSize;    // (width, height) of position texture
uniform float     uPointSize;  // base point size in pixels
uniform vec2      uCanvasSize; // (width, height) of the canvas in CSS pixels

out float vLifetime;
out vec2  vVelocity;

uniform sampler2D uVelocity;

void main() {
    int  idx = gl_VertexID;
    int  px  = idx % uTexSize.x;
    int  py  = idx / uTexSize.x;
    vec4 p   = texelFetch(uPositions, ivec2(px, py), 0);

    vec2  pos      = p.xy;
    float lifetime = p.z;
    vLifetime      = lifetime;
    vVelocity      = texture(uVelocity, pos).xy;

    // UV [0,1] → NDC [-1,1]. The fluid display & splat both treat UV.y=1
    // as the top of the screen, so particles must follow the same convention
    // (no extra Y flip) to react consistently to the velocity field.
    vec2 clip   = pos * 2.0 - 1.0;

    if (lifetime <= 0.0) {
        // Hide dormant particles off-screen instead of drawing them at (0,0).
        gl_Position  = vec4(2.0, 2.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }

    gl_Position = vec4(clip, 0.0, 1.0);
    // Scale point size with lifetime and velocity magnitude
    float speed = length(vVelocity);
    gl_PointSize = uPointSize * lifetime * (1.0 + speed * 2.0);
}
`;

/**
 * Particle render – FRAGMENT shader.
 *
 * Renders each particle as a soft glowing circle using gl_PointCoord.
 */
export const PARTICLE_RENDER_FRAG = /* glsl */`#version 300 es
precision highp float;

in float vLifetime;
in vec2  vVelocity;

uniform vec3 uColor;

out vec4 fragColor;

void main() {
    // Soft circle
    vec2  d     = gl_PointCoord - 0.5;
    float dist  = length(d);
    float alpha = (1.0 - smoothstep(0.25, 0.5, dist)) * vLifetime;

    // Subtle speed-based brightness boost (clamped so we don't blow out the image)
    float speedMul = 1.0 + clamp(length(vVelocity) * 0.05, 0.0, 2.0);
    vec3  colour   = uColor * speedMul * vLifetime;

    fragColor = vec4(colour, alpha);
}
`;
