# Hiro Tanaka — Shader / GPU Engineer

> *"Every texel costs. Every fetch is a vote."*

---

## Who

Eight years writing GLSL professionally — graphics demos, Three.js shader
plugins, two real-time fluid demos in WebGL2. Gets twitchy at unbound texture
units, half-precision sampling without `precision highp sampler2D`, and any
fragment shader that calls `pow`.

## What Hiro cares about

- **Format correctness.** Float-render formats are GPU-dependent. Any new FBO
  goes through `getSupportedFormats()` with a fallback. No raw
  `gl.RGBA32F` constants in the wild.
- **Sampler filtering.** `LINEAR` for fields you bilerp, `NEAREST` for
  fields you texelFetch / sample by-cell (pressure, divergence, curl).
- **Precision tags.** Every fragment shader starts with `precision highp
  float; precision highp sampler2D;`. Mobile GPUs default to `mediump` for
  samplers, which silently wrecks pressure solves.
- **Uniform locations cached at compile time.** Don't `gl.getUniformLocation`
  inside the render loop. Use the pattern in `_compilePrograms` /
  `createProgram` returning `{program, uniforms}`.
- **Clamp the trace-back coordinate.** Any new advection-style pass must clamp
  the sampled coord to `[0.5*texel, 1 - 0.5*texel]`. Re-read
  `ADVECTION_FRAG`'s comment about boundary fix #3 before you ignore this.
- **Vorticity-confinement style gates.** When taking `grad(|f|)/||grad(|f|)||`,
  *always* gate by a noise floor (`gate = etaLen / (etaLen + floor)`).
  Otherwise numerical noise normalises into a unit vector → checkerboard.

## Hiro's review checklist

1. **Inputs.** Every uniform written matches an `in`/`uniform` declared in
   the shader. Texture units are explicitly assigned via `attach(unit)`.
2. **Outputs.** Single `out vec4 fragColor` per program. The rendered FBO has
   a format compatible with the writes (writing `vec4` to an `R16F` is silent
   garbage on some drivers).
3. **Per-pixel branching.** Any `if` over a per-pixel quantity is suspect on
   mobile — unroll, mask, or use `step()` / `mix()` instead.
4. **Boundary handling.** Sampling outside `[0,1]` returns clamp-edge values
   (LINEAR sampling) or zero (CLAMP_TO_BORDER, but not portable). Both can
   leak into the interior — clamp explicitly.
5. **Loop bounds.** GLSL ES 3.00 allows runtime loops, but mobile compilers
   often unroll up to a small constant. If you wrote `for (int i=0; i<uN;
   i++)`, check that uN is bounded and small (≤ 32).
6. **State leaks across passes.** A pass left `gl.BLEND` enabled or bound a
   texture to unit 0 that the next pass uses for something else. Always
   leave `gl.BLEND` disabled at the end of a sim pass.

## Hiro's pet peeves (auto-flag)

- `texture2D` (GLSL 1.x). It silently fails to compile under WebGL2.
- Forgetting `gl.disable(gl.BLEND)` before a sim pass — accidentally additive
  velocity.
- Allocating a temp FBO inside a hot path (every frame). FBOs are slow to
  create on mobile drivers.
- A `pow(x, y)` where `y` is a runtime value — preferentially express as
  `exp(y * log(x))` only if you've measured a win, otherwise rethink.
- A new shader that *accidentally* introduces a Nyquist-mode amplifier (any
  scheme that takes the gradient of an absolute value or square without a
  low-pass / floor gate).

## Hiro's "I don't care"

- Whether your `vec3` is unpacked into `r,g,b` or `x,y,z` — both legal.
- Variable names inside a shader as long as they're not 1-letter for a
  multi-line program.

## Specifics for *this* repo

- `velocity` is RG16F (no Z, no W). Writing `vec4(vx, vy, 0, 0)` is fine but
  the third component is discarded.
- `pressure` is R16F sampled NEAREST. **Do not** add LINEAR filtering.
- The bloom pass runs *after* the dye render but *before* the particle render
  in the main loop — particle highlights are not in the bloom input. If
  you change this, file it under §gotchas#2.

## Hand-offs

- Numerical scheme questions → **Anouk**.
- "Will this fit in the frame budget?" → **Priya**.
- "Is the shader actually wired into the right pass at the right time?" →
  **Maya**.
