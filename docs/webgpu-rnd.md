# WebGPU port — R&D notes

> Status: **research / not started**. WebGL2 remains the supported runtime.
> This file is a holding pen for design notes so the eventual port doesn't
> start from a blank page.

---

## Why this hasn't shipped yet

Fluid's value proposition is the **flat `index.html`** that runs on any modern
phone over a static host. WebGPU buys us:

- Compute shaders → real reductions, prefix sums, in-place pressure smoothers.
- Bind groups & explicit barriers → a tighter inner loop than the per-pass
  `_blit` we currently dispatch.
- Pipeline state objects → fewer shader compiles per frame on switch.

But it would also cost:

- A second renderer codebase (we'd want to keep WebGL2 as a fallback — Firefox
  shipped WebGPU only on Linux/macOS at the time of writing, and Safari's
  enabled-by-default rollout is still partial).
- The `runtime probe → pick backend → instantiate sim` plumbing in `main.js`
  has to handle async adapter requests; today we hand the constructor a `gl`
  context synchronously.
- A second copy of every shader, in WGSL.

Today's WebGL2 path is comfortably under the 16 ms budget on Pixel-8-class
GPUs (see `bench/`), so the marginal user benefit of a port is moderate.
We'll revisit when:

1. WebGPU is on by default in Firefox stable on all platforms, AND
2. Safari ships compute pipelines without a flag.

---

## Migration sketch (when we do it)

### Step 0 — Capability probe
Already in `main.js`:

```js
if ('gpu' in navigator) {
  navigator.gpu.requestAdapter().then((adapter) => /* log */);
}
```

Extend to actually pick the backend:

```js
const backend = await pickBackend({ preferWebGPU: true });
const sim = backend === 'webgpu' ? new FluidGPU(...) : new FluidSimulation(gl, ...);
```

### Step 1 — Module split
Rename `src/fluid/FluidSimulation.js` to `src/fluid/FluidWebGL.js` and
introduce a sibling `src/fluid/FluidWebGPU.js` exposing the same public API
(`step`, `splat`, `paintObstacle`, `clearObstacles`, `applyBodyForce`,
`render`, `velocityTexture`, `dyeTexture`, `destroy`). `main.js` calls the
abstract surface; the rest of the code remains agnostic.

### Step 2 — Shader translation
`src/fluid/Shaders.js` becomes `Shaders.glsl.js`; add `Shaders.wgsl.js`. Keep
the GLSL versions canonical for now — they document the algorithms with the
codebase's existing comments. WGSL ports should track the GLSL line-by-line
so a math fix in one is mechanically applied to the other.

The pressure Jacobi loop is the single best candidate for a compute shader:
25 iterations per frame, all texel-local, perfect for a workgroup-shared
ping-pong. Everything else can stay on the render pipeline initially.

### Step 3 — FBO → texture views
WebGPU has no FBO; render-to-texture is a `GPUTextureView` bound as a colour
attachment in a render pass descriptor. The `createDoubleFBO` /
`createFBO` helpers in `webgl/GLUtils.js` need WebGPU mirrors with the same
`{ read, write, swap, attach }` ergonomics so the simulation code doesn't
care which backend it's running on.

### Step 4 — Service worker
`sw.js` currently caches the JS sources by exact URL. The cache list will
need to grow to include the WGSL shader module file (or we keep WGSL inline
in JS like we do for GLSL) and the new backend module.

---

## Open questions

- **Adaptive resolution path.** The current code calls `rebuildSubsystems()`
  which destroys + recreates the WebGL state. WebGPU is much heavier on
  pipeline-creation cost — we may need a "shrink the texture, keep the
  pipelines" path instead.
- **fp16 fallbacks.** WebGPU exposes `f16` only on adapters that support the
  `shader-f16` feature. We can't unconditionally rely on it for the velocity
  / pressure FBOs the way we lean on RGBA16F today — needs a fallback path.
- **Particle render.** WebGL2's `gl_VertexID` lookup against a position
  texture maps cleanly to a WebGPU vertex buffer + storage texture sample.
  No new ideas needed here.
- **Bench harness.** `bench/bench.html` would need a backend toggle and the
  results table would need a new column. The persona-review process still
  applies — Priya will want before/after numbers per backend.

---

## What this file is NOT

It is not a commitment that we will ship WebGPU on any timeline. It is also
not a design document — when we actually start, we'll write a proper one in
`docs/agents/architecture.md` (or split it out) and follow the BMAD-Fluid
loop persona by persona.
