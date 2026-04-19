# Conventions

Style + structural rules. Load when writing or reviewing code.

---

## 1. JavaScript

- **ES Modules only.** Import paths are explicit (`./foo.js`) — the project
  ships unbundled and is loaded by the browser, so omitting the `.js` will
  silently 404.
- **No build step, no transpiler.** Stay within syntax that ships unflagged in
  modern Chrome / Safari / Firefox (top-level `await` is fine; decorators are
  not).
- **No external runtime dependencies.** Add a vendored helper rather than a
  package.
- **Classes are private by convention** with a leading `_`. There is no
  TypeScript or `#private` syntax — keep it consistent.
- **One class per file**, named after the file (`UI.js` exports `class UI`).

---

## 2. Naming

| Kind                        | Style                         |
|-----------------------------|-------------------------------|
| `CONFIG` keys (tunables)    | `SCREAMING_SNAKE_CASE`        |
| Class names                 | `PascalCase`                  |
| Public methods              | `camelCase` (`step`, `splat`) |
| Private methods / fields    | `_camelCase`                  |
| Module-local helpers        | `camelCase`                   |
| Shader uniforms (GLSL)      | `uPascalCase` (`uVelocity`)   |
| Shader varyings             | `vCamel` (`vUv`, `vSeed`)     |

`CONFIG` is the contract between UI and engine — never invent a parallel
state object. If you need a new tunable, add it there with a doc-comment.

---

## 3. Comments

This is a no-noise codebase. Specifically:

- **No `// log a message` style comments.** If the code is obvious, leave
  it alone.
- **DO comment** when the code embodies a non-obvious decision, a workaround,
  a regression-prevention measure, or a magic number. Cite the *why*, ideally
  the *symptom* it fixes.
- Doc-comments on public methods (`/** … */`) when arguments or return
  semantics aren't self-evident.
- Section banners (`/* ── Title ─ */`) are used between logical groupings in
  long files (`UI.js`, `FluidSimulation.js`). Match the existing style.

Example of a *good* comment in this repo (from `Shaders.js`):

```glsl
// 5-tap low-pass on the curl sample to kill pure-Nyquist modes that
// otherwise feed back through the vorticity-confinement gradient and
// produce a stable checkerboard at zero viscosity.
```

Example of a *bad* comment we've removed:

```js
// loop over particles
for (let i = 0; i < n; i++) { ... }
```

---

## 4. Sliders & curves (UI.js)

All sliders are `0..100` in the DOM. The mapping to engineering units lives
in pure functions at the top of `UI.js` (`forceFromSlider`, `viscosityFromSlider`,
`persistenceFromSlider`). When tuning ranges:

- **Document the perceived feel** at three points (e.g. 0 / 50 / 100), not
  just the math.
- **Pick a curve that matches perception** — quadratic / power for force
  (perceptually log-ish), cubic for viscosity (long flat region near 0),
  smoothstep for persistence (avoid abrupt fade transition).
- Bound the output. The slider must reach a sensible min and a confident max
  on **both** ends — there is no "off-the-end" behaviour to fall back on.

---

## 5. Shader code (`src/fluid/Shaders.js`)

- Everything is GLSL ES 3.00 (`#version 300 es`) inline strings.
- Precision: `highp` for floats, `highp` for integers.
- Convention: a single `out vec4 fragColor;` per fragment program; vertex
  programs use `out` for varyings.
- Texture sampling: `texture(uFoo, vUv)` — never `texture2D` (that's GLSL 1).
- Gather neighbour samples through helpers when possible (texelFetch is fine
  for integer-coordinate access; otherwise stick to `texture()` with `uTexelSize`).
- Keep uniforms grouped by logical block at the top of the program for easy
  diffing.

---

## 6. Error handling & defensive UI

- Wrap permission requests (mic, motion) so a denial leaves the engine in a
  defined state — set the relevant `CONFIG.*_REACTIVE` to false, surface the
  error via the tooltip (`data-tip`) and add the `audio-denied` class for
  visual indication. See `_bindAudioButton` and `_bindTiltButton` for the
  template.
- Subsystem rebuilds (`rebuildSubsystems`) wrap construction in try/catch and
  pause the engine on failure — never let `animate()` step a destroyed object.
- Every public class with GPU resources implements `destroy()`. `main.js`
  calls it before re-creating the instance.

---

## 7. Tests

There is no Jest / Mocha suite. The two real validation surfaces are:

1. **`node --check`** — must pass on every modified JS file before commit.
2. **`bench/bench.html`** — open in a browser to verify the change doesn't
   blow up frame time. See `workflows.md` for how to interpret it.

If you add a unit-style test, prefer a tiny standalone HTML harness under
`bench/` (or a sibling `tests/` folder) that exercises the function and prints
to `document.body`. Don't introduce a test runner.
