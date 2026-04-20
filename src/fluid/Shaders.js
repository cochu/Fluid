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
 * Painted-sink dye drain. Multiplies the existing dye RGB by
 * (1 - uAmount * gauss(r)) clamped to [0, 1]. This:
 *   - never injects negative dye into the RGBA16F buffer (which would
 *     persist invisibly and re-emerge via bloom or additive splats),
 *   - acts as a *fraction* removal so already-light areas drain less in
 *     absolute terms than already-bright ones (visually natural drain),
 *   - leaves velocity untouched — sinks are dye-only in v1; the
 *     ambient VELOCITY_DISSIPATION carries the slowdown.
 *
 * Reuses the SPLAT_FRAG uniform layout (uTarget/uPoint/uRadius/uAspectRatio)
 * so the JS-side draw loop can swap between additive and drain passes
 * without rebinding the full uniform set.
 */
export const SINK_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform float uAmount;
uniform vec2  uPoint;
uniform float uRadius;
out vec4 fragColor;
void main() {
    vec2 p = vUv - uPoint;
    p.x   *= uAspectRatio;
    float g = exp(-dot(p, p) / uRadius);
    float k = clamp(1.0 - uAmount * g, 0.0, 1.0);
    vec3 dye = texture(uTarget, vUv).rgb * k;
    fragColor = vec4(dye, 1.0);
}
`;

/**
 * Semi-Lagrangian advection with manual bilinear interpolation.
 *
 * Works for both velocity self-advection (dyeTexelSize == velTexelSize)
 * and dye advection (different texel sizes).
 *
 * The trace-back coordinate is clamped to one half-texel inside the source
 * texture so that CLAMP_TO_EDGE wrapping cannot re-inject the boundary into
 * the interior (which would otherwise produce visible smudging at the edges).
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
    // Boundary fix #3: clamp to one half-texel inside the source so we do
    // not re-sample the auto-clamped border (cf. CLAMP_TO_EDGE).
    coord      = clamp(coord, 0.5 * uDyeTexelSize, 1.0 - 0.5 * uDyeTexelSize);
    fragColor  = uDissipation * bilerp(uSource, coord, uDyeTexelSize);
}
`;

/**
 * Reverse-time semi-Lagrangian advection — used for the backward pass of the
 * MacCormack scheme. Same logic as ADVECTION_FRAG but with `+ uDt` and no
 * dissipation (we want the raw error estimate). Implemented as a tiny variant
 * to keep ADVECTION_FRAG itself unmodified for the standard path.
 */
export const ADVECTION_REVERSE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2  uTexelSize;
uniform vec2  uDyeTexelSize;
uniform float uDt;
out vec4 fragColor;

vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st  = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
    vec2 vel   = bilerp(uVelocity, vUv, uTexelSize).xy;
    vec2 coord = vUv + uDt * vel;
    coord      = clamp(coord, 0.5 * uDyeTexelSize, 1.0 - 0.5 * uDyeTexelSize);
    fragColor  = bilerp(uSource, coord, uDyeTexelSize);
}
`;

/**
 * MacCormack/Selle combiner — second-order accurate advection.
 *
 * Inputs:
 *   uPhi        : original field φ_n (frozen)
 *   uPhiForward : φ_forward = advect(φ_n, +dt) (frozen)
 *   uPhiBack    : φ_back    = advect(φ_forward, -dt)
 *   uVelocity   : carrier velocity (frozen v_n for self-advection,
 *                                   projected v for dye)
 *
 * Output: φ_forward + 0.5*(φ_n - φ_back), clamped to the local bilinear
 * stencil min/max at the trace-back position (limiter — prevents the
 * second-order correction from creating new extrema).
 */
export const MACCORMACK_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uPhi;
uniform sampler2D uPhiForward;
uniform sampler2D uPhiBack;
uniform sampler2D uVelocity;
uniform vec2  uTexelSize;     // velocity texel
uniform vec2  uDyeTexelSize;  // source / phi texel
uniform float uDt;
uniform float uDissipation;
out vec4 fragColor;

vec4 bilerpVel(sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st  = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
    vec4 phi_n   = texture(uPhi,        vUv);
    vec4 phi_fwd = texture(uPhiForward, vUv);
    vec4 phi_bak = texture(uPhiBack,    vUv);

    // Second-order MacCormack correction
    vec4 corrected = phi_fwd + 0.5 * (phi_n - phi_bak);

    // Compute the four raw stencil texels at the trace-back position and use
    // them as a limiter (Selle 2008): clamp the correction to [min, max] of
    // the unfiltered neighbours. Reading raw texels (not the filtered
    // texture()) is essential — the limiter must bound to actual cell values.
    vec2 vel   = bilerpVel(uVelocity, vUv, uTexelSize).xy;
    vec2 coord = vUv - uDt * vel;
    coord      = clamp(coord, 0.5 * uDyeTexelSize, 1.0 - 0.5 * uDyeTexelSize);

    vec2 st  = coord / uDyeTexelSize - 0.5;
    vec2 iuv = floor(st);
    vec4 a = texture(uPhi, (iuv + vec2(0.5, 0.5)) * uDyeTexelSize);
    vec4 b = texture(uPhi, (iuv + vec2(1.5, 0.5)) * uDyeTexelSize);
    vec4 c = texture(uPhi, (iuv + vec2(0.5, 1.5)) * uDyeTexelSize);
    vec4 d = texture(uPhi, (iuv + vec2(1.5, 1.5)) * uDyeTexelSize);
    vec4 mn = min(min(a, b), min(c, d));
    vec4 mx = max(max(a, b), max(c, d));

    fragColor = uDissipation * clamp(corrected, mn, mx);
}
`;

/**
 * BFECC (Back and Forth Error Compensation and Correction) combiner.
 *
 * Shares passes 1 (forward advect) and 2 (reverse advect) with the
 * MacCormack scheme — so toggling between MacCormack and BFECC requires
 * no extra GPU work outside this final pass. Where MacCormack adds the
 * error correction *to the forward-advected field at the destination
 * pixel*, BFECC corrects the *source field* and re-advects it, which is
 * less dissipative for sharp dye fronts (Selle 2008, §4.2).
 *
 * The bilinear sample of (φ + 0.5(φ - φ_back)) at the trace-back
 * coordinate equals 1.5*bilerp(φ) - 0.5*bilerp(φ_back), so we never need
 * to materialise the corrected source field into a fourth FBO.
 *
 * Same Selle limiter as MacCormack — clamp the result to the four raw
 * neighbour values of φ at the trace-back position so the second-order
 * correction can never introduce a new extremum (overshoot guard).
 *
 * Inputs:
 *   uPhi      : original field φ_n (frozen)
 *   uPhiBack  : φ_back = advect(advect(φ_n, +dt), -dt)  (the BFECC
 *               error round-trip; written by passes 1+2)
 *   uVelocity : carrier velocity (projected v for dye)
 */
export const BFECC_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uPhi;
uniform sampler2D uPhiBack;
uniform sampler2D uVelocity;
uniform vec2  uTexelSize;
uniform vec2  uDyeTexelSize;
uniform float uDt;
uniform float uDissipation;
out vec4 fragColor;

vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st  = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
    // Velocity is sampled from the velocity grid (uTexelSize), but the
    // trace-back coord lives in the dye grid's UV space — so the clamp
    // bound below uses uDyeTexelSize, not uTexelSize. Asymmetric on
    // purpose: when SIM_RESOLUTION ≠ DYE_RESOLUTION (the default) the
    // two grids have different texel sizes.
    vec2 vel   = bilerp(uVelocity, vUv, uTexelSize).xy;
    vec2 coord = vUv - uDt * vel;
    coord      = clamp(coord, 0.5 * uDyeTexelSize, 1.0 - 0.5 * uDyeTexelSize);

    // Sample (phi + 0.5*(phi - phi_back)) bilinearly at the trace-back
    // position. Linearity of bilinear interp lets us combine the two
    // taps into a single weighted expression — no fourth FBO needed.
    vec4 phiSample     = bilerp(uPhi,     coord, uDyeTexelSize);
    vec4 phiBackSample = bilerp(uPhiBack, coord, uDyeTexelSize);
    vec4 corrected     = 1.5 * phiSample - 0.5 * phiBackSample;

    // Selle limiter on the raw (un-filtered) neighbour stencil of phi
    // at the trace-back position — bounds the correction to actual
    // cell values so we never invent dye that wasn't there.
    vec2 st  = coord / uDyeTexelSize - 0.5;
    vec2 iuv = floor(st);
    vec4 a = texture(uPhi, (iuv + vec2(0.5, 0.5)) * uDyeTexelSize);
    vec4 b = texture(uPhi, (iuv + vec2(1.5, 0.5)) * uDyeTexelSize);
    vec4 c = texture(uPhi, (iuv + vec2(0.5, 1.5)) * uDyeTexelSize);
    vec4 d = texture(uPhi, (iuv + vec2(1.5, 1.5)) * uDyeTexelSize);
    vec4 mn = min(min(a, b), min(c, d));
    vec4 mx = max(max(a, b), max(c, d));

    fragColor = uDissipation * clamp(corrected, mn, mx);
}
`;

/**
 * Free-slip velocity boundary condition (Stam / Harris GPU Gems 1, ch. 38).
 *
 * On the 1-texel boundary ring we synthesise a ghost-cell value from
 * the inner neighbour:
 *   - **free-slip** (uNoSlip = 0): write (-vn, vt) — normal component
 *     negated so its average with the inner cell is zero (no flux
 *     through the wall), tangential preserved (the fluid slides).
 *   - **no-slip**  (uNoSlip = 1): write -inner — both components
 *     negated so the average with the inner cell is the zero vector
 *     (the fluid sticks to the wall, viscous drag near the edges).
 *
 * Boundary detection uses integer texel coordinates from gl_FragCoord, which
 * is exact (no float-precision ambiguity). texelFetch reads point-sampled
 * values regardless of the texture's filter mode.
 */
export const BOUNDARY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uVelocity;
uniform ivec2     uSize;     // (width, height) of the velocity grid
uniform int       uNoSlip;   // 0 = free-slip (default), 1 = no-slip
out vec4 fragColor;

void main() {
    ivec2 p   = ivec2(gl_FragCoord.xy);
    int   xMax = uSize.x - 1;
    int   yMax = uSize.y - 1;

    bool left   = p.x == 0;
    bool right  = p.x == xMax;
    bool bottom = p.y == 0;
    bool top    = p.y == yMax;

    if (!(left || right || bottom || top)) {
        // Interior: pass-through.
        fragColor = texelFetch(uVelocity, p, 0);
        return;
    }

    // Read the inner neighbour (clamped to interior for corners).
    ivec2 inner = ivec2(
        clamp(p.x + (left ? 1 : (right  ? -1 : 0)), 0, xMax),
        clamp(p.y + (bottom ? 1 : (top  ? -1 : 0)), 0, yMax)
    );
    vec4 v = texelFetch(uVelocity, inner, 0);
    if (uNoSlip == 1) {
        // No-slip: both components negated so cell+ghost average to 0.
        v.xy = -v.xy;
    } else {
        // Free-slip: normal component negated, tangential preserved.
        if (left || right) v.x = -v.x;
        if (bottom || top) v.y = -v.y;
    }
    fragColor = v;
}
`;

/**
 * Implicit viscous diffusion — one Jacobi iteration.
 *
 * Solves (I - νΔt∇²) v_new = v_advected via
 *     v_new[c] = (b[c] + α (vL+vR+vT+vB)) / (1 + 4α)
 * with α = ν · Δt / h² (h is the grid cell size in UV units, i.e.
 * h = 1/N → 1/h² = N²; we fold N² into α so the slider feel is
 * resolution-independent).
 *
 * `uB` is the right-hand side (the advected velocity, must be immutable
 * across iterations). `uX` is the current iterate (ping-pong source).
 */
export const VISCOSITY_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uX;
uniform sampler2D uB;
uniform float uAlpha;   // ν · Δt · N² (dimensionless)
out vec4 fragColor;

// IMPORTANT: use texelFetch (point sampling at exact cell centres) instead of
// the bilinear texture() reads. The interpolated varyings vL/vR/vT/vB sit at
// pixel centres in theory, but tiny rounding slop on some GPUs produces a
// stable grid imprint after 20 Jacobi iterations — particularly visible at
// very low ν where each pass is essentially an identity copy. Point sampling
// removes this class of artefact entirely.
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 sz = textureSize(uX, 0);
    ivec2 pL = ivec2(max(p.x - 1, 0),         p.y);
    ivec2 pR = ivec2(min(p.x + 1, sz.x - 1),  p.y);
    ivec2 pB = ivec2(p.x, max(p.y - 1, 0));
    ivec2 pT = ivec2(p.x, min(p.y + 1, sz.y - 1));
    vec4 xL = texelFetch(uX, pL, 0);
    vec4 xR = texelFetch(uX, pR, 0);
    vec4 xT = texelFetch(uX, pT, 0);
    vec4 xB = texelFetch(uX, pB, 0);
    vec4 b  = texelFetch(uB, p,  0);
    fragColor = (b + uAlpha * (xL + xR + xT + xB)) / (1.0 + 4.0 * uAlpha);
}
`;

/** Compute curl (z-component of ∇×v) for vorticity confinement. */
// NOTE: precision *must* be highp here. mediump → fp16 on mobile, and the
// curl values feed directly into the vorticity gradient (5-point stencil)
// which then accumulates over many frames. fp16 truncation causes a visible
// static grid pattern / checkerboard at low viscosity.
export const CURL_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
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
 * Vorticity confinement (Fedkiw, Stam 2001) – injects angular momentum to
 * restore small-scale swirling that numerical diffusion would otherwise erase.
 *
 *   η = ∇|ω|              (gradient of curl magnitude)
 *   N = η / |η|           (normalised gradient)
 *   f = ε · ω · (N.y, -N.x)   (perpendicular, signed by ω)
 *
 * BUG FIX: The previous implementation built the gradient with axes swapped
 * (∂y component placed in x slot and vice-versa), which broke rotational
 * symmetry and produced a strong diagonal bias — visible at low viscosity as
 * a fractal-like / Julia-set-like striping. The corrected formula uses the
 * standard central-difference layout (∂x → x, ∂y → y).
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

    // 5-tap low-pass on the curl sample we confine against. Without this,
    // pure-Nyquist checkerboard modes survive into the forcing term and
    // get re-amplified frame after frame.
    float omega = (L + R + T + B + 4.0 * C) * 0.125;

    // Gradient of |curl| — central differences. ∂x in .x, ∂y in .y.
    vec2  eta    = 0.5 * vec2(abs(R) - abs(L), abs(T) - abs(B));
    float etaLen = length(eta);

    // Scale-aware gate: in regions where the local |curl| is essentially
    // numerical noise, refuse to normalise the gradient into a unit
    // vector and refuse to apply force. Without this gate, vorticity
    // confinement turns Nyquist noise into a stable grid pattern as soon
    // as viscosity stops damping it.
    float local  = max(abs(omega), max(max(abs(L), abs(R)), max(abs(T), abs(B))));
    float floorV = 0.15 * local + 1e-4;
    vec2  N      = eta / max(etaLen, floorV);
    float gate   = etaLen / (etaLen + floorV);

    // 2D perpendicular (rotated +90°), gated, scaled by smoothed curl.
    vec2 force = gate * uCurlStrength * omega * vec2(N.y, -N.x);

    vec2 vel = texture(uVelocity, vUv).xy;
    fragColor = vec4(vel + force * uDt, 0.0, 1.0);
}
`;

/** Compute velocity divergence ∇·v (central differences). */
// highp required: divergence feeds the pressure Poisson solve which iterates
// 20-30 times. Any fp16 quantisation here imprints as a stable grid pattern.
export const DIVERGENCE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
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
// highp required: 25 iterations of fp16 Jacobi accumulate quantisation noise
// that surfaces as a visible grid imprint at low viscosity. The cost on a
// 128² grid is negligible.
export const PRESSURE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
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
precision highp float;
precision highp sampler2D;
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
uniform sampler2D uObstacles;
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
        // Faux-3D dye shading. Treat dye luminance as a height field,
        // compute a screen-space normal from the local gradient, and
        // light it with a fixed virtual sun. Cosmetic only — does not
        // touch the simulation. Strength scales with local intensity
        // so flat dark regions don't grow phantom relief.
        vec2 px = 1.0 / vec2(textureSize(uTexture, 0));
        const vec3 W = vec3(0.299, 0.587, 0.114);
        float hL = dot(texture(uTexture, vUv - vec2(px.x, 0.0)).rgb, W);
        float hR = dot(texture(uTexture, vUv + vec2(px.x, 0.0)).rgb, W);
        float hD = dot(texture(uTexture, vUv - vec2(0.0, px.y)).rgb, W);
        float hU = dot(texture(uTexture, vUv + vec2(0.0, px.y)).rgb, W);
        float lumC   = dot(c, W);
        float relief = clamp(lumC * 8.0, 0.0, 4.0);
        vec3 n = normalize(vec3((hL - hR) * relief, (hD - hU) * relief, 1.0));
        vec3 L = normalize(vec3(0.45, 0.50, 0.85));
        float diffuse = max(0.0, dot(n, L)) * 0.55 + 0.55;
        vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
        float spec    = pow(max(0.0, dot(n, H)), 32.0) * 0.30;
        c = c * diffuse + vec3(spec);
    }

    c = toneMap(c * 1.2);

    // Obstacles render as dark glass tinted with a faint cyan rim. Sampling
    // is unconditional because the obstacle FBO is cleared to 0 — when no
    // obstacles are painted the effect is a no-op (0.0 mask everywhere).
    float obs = clamp(texture(uObstacles, vUv).r, 0.0, 1.0);
    if (obs > 0.001) {
        vec3 glass = vec3(0.04, 0.08, 0.12);
        // Soft inner glow: the dye colour bleeds slightly across the surface
        // so a moving fluid still hints at what's behind the obstacle.
        c = mix(c, glass + 0.15 * c, smoothstep(0.05, 0.55, obs));
    }

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
uniform float     uTime;       // seconds, drives micro-jitter

out float vLifetime;
out vec2  vVelocity;
out vec2  vVelDir;
out float vSeed;

uniform sampler2D uVelocity;

// Cheap deterministic hash — gives each particle a stable [0,1) seed
// derived from its index so its shimmer phase doesn't sync with others.
float hash11(uint n) {
    n = (n ^ 61u) ^ (n >> 16);
    n *= 9u;
    n = n ^ (n >> 4);
    n *= 0x27d4eb2du;
    n = n ^ (n >> 15);
    return float(n & 0x00FFFFFFu) / float(0x01000000u);
}

void main() {
    int  idx = gl_VertexID;
    int  px  = idx % uTexSize.x;
    int  py  = idx / uTexSize.x;
    vec4 p   = texelFetch(uPositions, ivec2(px, py), 0);

    vec2  pos      = p.xy;
    float lifetime = p.z;
    vLifetime      = lifetime;
    vSeed          = hash11(uint(idx));
    vec2 vel       = texture(uVelocity, pos).xy;
    vVelocity      = vel;
    float spd      = length(vel);
    vVelDir        = spd > 5e-4 ? vel / spd : vec2(0.0, 1.0);

    // UV [0,1] → NDC [-1,1]. The fluid display & splat both treat UV.y=1
    // as the top of the screen, so particles must follow the same convention
    // (no extra Y flip) to react consistently to the velocity field.
    vec2 clip   = pos * 2.0 - 1.0;

    // Micro-shimmer — a sub-pixel oscillation that suggests a living medium.
    // Per-particle phase from a cheap hash so neighbours don't wobble in sync.
    float phase = dot(pos, vec2(37.1, 19.3));
    clip += 0.0012 * vec2(sin(uTime * 11.3 + phase),
                          cos(uTime *  9.7 + phase));

    if (lifetime <= 0.0) {
        // Hide dormant particles off-screen instead of drawing them at (0,0).
        gl_Position  = vec4(2.0, 2.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        return;
    }

    gl_Position = vec4(clip, 0.0, 1.0);
    // Keep sprites near constant size: fast particles only get a tiny
    // boost, so motion reads through movement of the cloud rather than
    // through visually noisy per-particle inflation.
    gl_PointSize = uPointSize * (0.95 + 0.15 * clamp(spd * 0.25, 0.0, 1.0));
}
`;

/**
 * Particle render – FRAGMENT shader.
 *
 * Calm aquatic droplet:
 *   - soft circular Gaussian body + tighter inner core
 *   - deep ocean → cyan colour gradient driven by core falloff and speed
 *   - a single offset specular highlight (light from above-left)
 * No anisotropic stretch, no caustic ring, no fresnel — at small point
 * sizes those layers read as shader noise rather than water. The fluid
 * field already supplies all the motion language.
 */
export const PARTICLE_RENDER_FRAG = /* glsl */`#version 300 es
precision highp float;

in float vLifetime;
in vec2  vVelocity;
in vec2  vVelDir;
in float vSeed;

uniform vec3  uColor;     // accent tint (multiplied into the gradient)
uniform float uTime;      // seconds (kept for future use; currently unused)
uniform float uTintMix;   // 0 = pure aqua palette, 1 = blend with uColor

out vec4 fragColor;

void main() {
    vec2  d  = gl_PointCoord - 0.5;
    float r2 = dot(d, d);

    // Soft circular body + tighter core — a small water bead.
    float body = exp(-r2 * 18.0);
    float core = exp(-r2 * 42.0);

    // Single faux specular: light from above-left, narrow falloff.
    vec2  h    = d - vec2(-0.12, 0.14);
    float spec = exp(-dot(h, h) * 110.0) * 0.45;

    float speed = clamp(length(vVelocity) * 0.10, 0.0, 1.0);

    vec3  deep = vec3(0.02, 0.10, 0.26);
    vec3  cyan = vec3(0.18, 0.78, 0.95);
    vec3  base = mix(deep, cyan, 0.35 + 0.30 * core + 0.15 * speed);

    // Tint kept subtle so the aqua palette dominates.
    base = mix(base, base * max(uColor, vec3(0.45)), uTintMix * 0.25);

    vec3  rgb = base * (0.55 * body + 0.80 * core)
              + vec3(0.75, 0.93, 1.00) * spec;

    float alpha = clamp(0.55 * body + 0.35 * core + spec, 0.0, 0.85);

    if (alpha < 0.02) discard;
    // Premultiplied alpha — main.js uses (ONE, ONE_MINUS_SRC_ALPHA).
    fragColor = vec4(rgb * alpha, alpha);
}
`;

/* ══════════════════════════════════════════════════════════════════════
   BODY-FORCE / OBSTACLE SHADERS
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Uniform body force – adds a constant (uForce * uDt) to every velocity
 * texel. Used by the accelerometer-tilt input to drift the entire field
 * in the tilt direction (rather than splatting at the centre, which
 * looked like a drain). A truly uniform force is divergence-free, so
 * the next pressure projection has no work to do for it.
 *
 * Skips solid cells (obstacle mask) so a tilted device cannot push fluid
 * into a wall. Boundary BCs already handle the screen edges.
 */
export const BODY_FORCE_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacles;
uniform vec2  uForce;     // UV/s² (already scaled by gain)
uniform float uDt;
out vec4 fragColor;
void main() {
    vec2  v   = texture(uVelocity,  vUv).xy;
    float obs = texture(uObstacles, vUv).r;
    vec2  nv  = (obs > 0.5) ? vec2(0.0) : (v + uForce * uDt);
    fragColor = vec4(nv, 0.0, 1.0);
}
`;

/**
 * Obstacle mask paint – additive Gaussian splat written into the
 * obstacle ping-pong. uColor is set to (1,1,1) for paint and the FBO
 * is single-channel R8, so only .r matters at the consumer end. Reuses
 * the SPLAT_FRAG uniform layout but clamps to [0,1] (no overdrive).
 */
export const OBSTACLE_PAINT_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform float uValue;     // +1 to paint, -1 to erase
uniform vec2  uPoint;
uniform float uRadius;
out vec4 fragColor;
void main() {
    vec2 p = vUv - uPoint;
    p.x   *= uAspectRatio;
    float g = exp(-dot(p, p) / uRadius);
    float prev = texture(uTarget, vUv).r;
    float v    = clamp(prev + uValue * g, 0.0, 1.0);
    fragColor  = vec4(v, 0.0, 0.0, 1.0);
}
`;

/**
 * Velocity zero-out inside obstacles. A second-class boundary condition
 * (the proper way is to mask divergence + pressure too) but visually
 * sufficient for static, sparse obstacles: fluid grazes solids without
 * flowing through them. Run after gradient subtract; the projection
 * will smooth the resulting micro-divergence on the next frame.
 */
export const OBSTACLE_CLEAR_FRAG = /* glsl */`#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uObstacles;
out vec4 fragColor;
void main() {
    float obs = texture(uObstacles, vUv).r;
    vec2  v   = texture(uVelocity,  vUv).xy;
    if (obs > 0.5) v = vec2(0.0);
    fragColor = vec4(v, 0.0, 1.0);
}
`;
