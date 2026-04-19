# AGENTS.md

> **Audience:** AI coding agents (Copilot CLI, Cursor, Aider, Claude Code, …).
> Humans should read [`README.md`](README.md) first. This file is a high-signal
> index — load **only the sub-docs you need** to keep your context window tight.

---

## 1. What this repo is — in 60 seconds

Fluid is a **mobile-first, real-time WebGL2 fluid simulation** running entirely
in the browser. **No build step, no bundler, no framework, no npm.** Open
`index.html` (or serve it with `python3 -m http.server 8080`) and it runs.

- ~3.7 k LOC of vanilla ES modules under [`src/`](src/).
- All shaders are inline GLSL ES 3.00 strings in [`src/fluid/Shaders.js`](src/fluid/Shaders.js).
- All runtime knobs live on the single mutable [`CONFIG`](src/config.js) object.
- All UI state is wired in [`src/ui/UI.js`](src/ui/UI.js) and surfaced in [`index.html`](index.html).
- A static perf harness lives at [`bench/bench.html`](bench/bench.html).

---

## 2. Golden rules (read every time)

These rules exist because the codebase has been bitten by them before. Breaking
one almost always re-introduces a known regression — see [`docs/agents/gotchas.md`](docs/agents/gotchas.md).

1. **Never put MacCormack on the velocity self-advection path.** It re-creates
   the zero-viscosity grid trame. Velocity always uses plain semi-Lagrangian
   `_advect`. `HIGH_QUALITY_ADVECTION` gates the **dye** path only.
2. **Don't reach across module boundaries.** UI never touches the simulation
   directly — it mutates `CONFIG` and emits callbacks. Keep it that way.
3. **Don't add a build step.** The project's value proposition is that it runs
   from a flat `index.html`. If you really need tooling, ship a script under
   [`tools/`](tools/) — never a `package.json` for users.
4. **Pre-multiply splat colors by `CONFIG.DYE_BRIGHTNESS`.** Use
   [`pickSplatColor`](src/input/Palettes.js) — don't roll your own.
5. **Always stamp the version on commits.** Run
   `bash tools/stamp-version.sh --amend` after every commit so
   [`src/version.js`](src/version.js) references its own SHA.
6. **Validate JS syntax before committing.** `node --check <file>` on every
   touched `.js`. There are no unit tests to catch typos.
7. **Comments only when they add information.** This repo has a deliberate
   style: explain *why* (or *what regression this fix prevents*), never *what*.
   See [`docs/agents/conventions.md`](docs/agents/conventions.md#comments).

---

## 3. Where to look — directory map

| Path | What lives there |
|------|------------------|
| `index.html`                       | Entry point, DOM scaffold, button list, SW registration |
| `manifest.webmanifest`, `sw.js`    | PWA install metadata + offline cache |
| `src/main.js`                      | App bootstrap, animation loop, adaptive quality, snapshot, visibility pause |
| `src/config.js`                    | Single mutable `CONFIG` object — every runtime tunable lives here |
| `src/version.js`                   | One-line build SHA, stamped by `tools/stamp-version.sh` |
| `src/fluid/FluidSimulation.js`     | Whole solver: splat, advect, divergence, jacobi pressure, vorticity, viscosity, render |
| `src/fluid/Shaders.js`             | All GLSL (~800 lines) — vertex + fragment programs |
| `src/particles/ParticleSystem.js`  | GPU-resident particle pos/vel ping-pong, point-sprite render |
| `src/input/InputHandler.js`        | Pointer Events → splats, rate-normalised |
| `src/input/Palettes.js`            | `COLOR_MODE` palettes, `pickSplatColor`, `paletteAccent` |
| `src/input/AccelerometerInput.js`  | Tilt-to-stir (off by default, iOS perm flow) |
| `src/audio/AudioReactivity.js`     | Mic FFT → bass/mids/highs splats with own palette |
| `src/ui/UI.js`                     | Buttons, sliders, tooltip system, snapshot, version tag, slider curves |
| `src/webgl/GLUtils.js`             | Context creation, format detection, FBO/program/blit helpers |
| `styles/main.css`                  | All CSS — single sheet |
| `bench/bench.html`                 | Standalone perf harness — open in a browser, prints frame stats |
| `tools/stamp-version.sh`           | Folds the short SHA + date into `src/version.js` |

---

## 4. Sub-documents — load on demand

Each sub-doc is self-contained. **Don't load all of them up-front.** Pick the
one(s) that match your task:

- **[`docs/agents/architecture.md`](docs/agents/architecture.md)** —
  module wiring, simulation step order, FBO inventory, render pipeline.
  *Load when:* changing the solver, adding a new pass, or touching `main.js`'s loop.
- **[`docs/agents/conventions.md`](docs/agents/conventions.md)** —
  naming, file layout, comment policy, slider/curve helpers, shader patterns.
  *Load when:* writing or reviewing code.
- **[`docs/agents/workflows.md`](docs/agents/workflows.md)** —
  local dev, perf measurement (`bench/`), version stamping, commit + push,
  iOS quirks, browser smoke tests.
  *Load when:* shipping a change end-to-end.
- **[`docs/agents/gotchas.md`](docs/agents/gotchas.md)** —
  known regressions and how previous agents stepped on them
  (zero-viscosity trame, vorticity gate, bloom threshold tuning, dead FBOs,
  tooltip data-tip refresh, etc.).
  *Load when:* anything in the simulation, bloom, particles, or UI starts
  behaving "weirdly" — read this **before** trying a fix.

---

## 5. Quick command cheatsheet

```bash
# Local dev (no build step)
python3 -m http.server 8080      # then open http://localhost:8080

# Perf harness
python3 -m http.server 8080      # then open http://localhost:8080/bench/bench.html

# Validate every touched JS file before committing
node --check src/path/to/File.js

# Standard commit + version-stamp + push (run from repo root)
git add -A
git commit -m "Subject in present tense

Body explaining what regression this prevents or behaviour it adds.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
bash tools/stamp-version.sh --amend
git push origin main
```

The Co-authored-by trailer is mandatory for AI-authored commits.

---

## 6. When in doubt

- The single source of truth for runtime behaviour is `CONFIG`. Grep there first.
- The single source of truth for *why something looks the way it does* is
  [`docs/agents/gotchas.md`](docs/agents/gotchas.md). Read it before "fixing"
  anything that isn't obviously wrong.
- The single source of truth for the build identifier visible in the UI is
  [`src/version.js`](src/version.js). Always re-stamp after committing.
