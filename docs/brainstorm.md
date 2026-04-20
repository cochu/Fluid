# Brainstorm — what could come next for Fluid

> A snapshot of ideas captured at the end of the round of work that
> shipped BFECC, no-slip walls, faux-3D shading, WebM recording,
> a multi-pointer audit, a test harness, and bench/README polish.
>
> Two parts:
> 1. **Incremental** — fits inside the current architecture and
>    golden rules. Pick any of these, ship in a single commit.
> 2. **Disruptive** — would force breaking at least one golden
>    rule from `AGENTS.md`, or refounding the experience around a
>    different metaphor. Listed for honest discussion, not for
>    quiet implementation.

---

## 1. Incremental ideas (golden-rule-safe)

### 1.1 Headless CI test runner under `tools/`
A small Node script that launches Playwright (npm-installed in
the CI image only, never as a project dependency), opens
`tests/test.html`, scrapes the row colours, and exits non-zero on
red rows. Lives under `tools/ci-tests.mjs` so the user-facing
project remains build-step-free per golden rule #3. GitHub Actions
workflow that runs it on every push.

### 1.2 Bench JSON history viewer
A second page `bench/history.html` that accepts dropped JSON
files (the ones the bench Download JSON button emits) and renders
them as a small line chart per scenario. Lets reviewers eyeball
perf trends across PRs without reading numbers. Pure
client-side, uses `<canvas>` 2D — no chart library needed.

### 1.3 Variable-step time integration
Right now `dt = 1/60` is hard-coded into the step call. Reading
`performance.now()` between frames and feeding the real elapsed
ms into `sim.step(dt)` would make slow-motion (when the tab is
backgrounded then resumed) look correct rather than fast-forward.
Risk: shaders use uDt as a scalar; needs an audit of each
shader's stability under variable dt. Anouk persona file warns
about this.

### 1.4 Higher-order pressure solver
Replace 25 Jacobi iterations with a multigrid V-cycle (3 levels:
192 → 96 → 48 → 96 → 192). At equal residual the V-cycle is ~3×
cheaper on the SIM=192 default. Worth measuring with the bench
harness before committing — a multigrid implementation is ~150
lines of new shaders.

### 1.5 Touch-pressure splat force
Pointer Events expose `e.pressure` (0..1) on supported devices
(Apple Pencil, Surface Pen, some Android phones). Multiply
splat force by `lerp(0.5, 1.5, e.pressure)` so a hard tap
splashes harder than a glide. Backwards-compatible — devices
that report 0/0.5 default get the current behaviour.

### 1.6 Curl-shaped initial velocity for source/sink markers
When a source is placed, optionally seed a small vortex at its
position (curl pattern) so the emitted dye immediately spirals
rather than just being pushed. UI: long-press the source button
to choose between "jet" (current) and "vortex" emitters. Pairs
beautifully with the BFECC dye since the spiral filaments stay
sharp.

### 1.7 Gallery preset thumbnails
The named scene presets (Aurora, Ink, Lava, …) currently surface
as a single cycling button. A gallery modal that shows a
pre-rendered 64×64 thumbnail per preset would help users
discover them. The thumbnails could be generated offline by a
`tools/render-thumbnails.mjs` script that drives the bench
page with each preset and screenshots the canvas — committed as
PNGs alongside the preset definitions.

### 1.8 Settings export / import
Already have `snapshot()` for in-browser persistence and share
links. Add Download / Upload buttons in a settings panel that
emit/consume the same snapshot JSON, so users can hand-tune a
favourite configuration and share the file rather than the URL
(URLs have length limits; complex SOURCES arrays approach them).

### 1.9 Audio reactivity per-band visualisation
The mic FFT is computed every frame but only the bass band drives
splats. Drawing a tiny three-stack volume meter (bass / mid /
high in the existing palette accent colour) below the mic button
would make the audio responsiveness debuggable at a glance and
gives users feedback that the mic is actually working.

### 1.10 Particles inherit dye colour
ParticleSystem currently renders particles with a fixed
luminance. If each particle sampled the dye texture at its
position on render, the swarm would tint with the local fluid —
visually unifying the two layers. Cost: one extra texture tap
per particle in the render shader.

---

## 2. Disruptive ideas (would break a golden rule)

### 2.1 WebGPU port (breaks rule #3 only if it adds tooling)
WebGPU compute shaders would let the pressure solve run as a
single dispatch instead of 25 separate fragment passes, and
particles could be advected via a real compute pipeline rather
than a fragment-shader-into-FBO trick. The R&D doc
`docs/webgpu-rnd.md` already exists. Risk: WGSL is a different
shader language, so the port is roughly a full rewrite of
`Shaders.js`. Survives golden rule #3 only if the WebGPU code
ships as additional inline WGSL strings with the same "open
index.html" entry point.

### 2.2 SPH (Smoothed Particle Hydrodynamics) instead of Eulerian grid
A particle-based fluid (a million SPH points) would be a complete
re-foundation. No grid means no MacCormack/BFECC question and no
trame regression possible — golden rule #1 would become moot. Look
and feel would shift from "ink in water" to "splash" / "wave" —
arguably a different product. Worth a fork named `Fluid-SPH`
rather than a branch of this repo.

### 2.3 Multi-fluid (two immiscible dyes)
Two dye fields that don't mix — driven by a level-set tracking
the interface between them. Visually like oil and water. Needs a
new pass and roughly doubles the dye memory footprint. Pairs
naturally with the no-slip boundary; the interface tension
becomes a visible feature.

### 2.4 Volumetric / true 3D
Step from 2D to a thin 3D slab (e.g. 192×192×16). Renders as
ray-marched volume from the front with the existing dye colour as
density. Cost: SIM cells go from 36864 to 589824 — ~16× heavier.
Mobile would not survive. Could be a desktop-only "deep" mode
gated by `(navigator.hardwareConcurrency >= 8)` with a clear
warning.

### 2.5 Drop the "no build step" rule
Vite + TypeScript + a real test framework + tree-shaken modules
would make the codebase easier to refactor and would catch
classes of bug at compile time that currently only surface as
runtime exceptions. **Cost:** the project loses its
"flat-index.html, runs anywhere, including Codespaces with no
prep" proposition — the very thing AGENTS.md golden rule #3
exists to protect. If we ever take this route, do it as a
separate repo (`Fluid-pro`) with the static repo kept as the
"reference implementation" so users can still inspect a
single-file build.

### 2.6 Server-side persistence + multiplayer
Two browsers connected to the same Fluid canvas via WebRTC,
each pushing splats that the other sees in real time. Breaks
the project's "no backend" promise unless a STUN-only signalling
trick can be made to work (theoretically possible with QR-code
exchange of session descriptions, but UX-fragile). Would
absolutely need to ship as a feature flag, default off.

### 2.7 Generative agent inhabits the canvas
Background "fluid agent" that splats on its own according to a
trained policy (e.g. tries to maximise screen-space curl, or
follows aesthetic preferences). Would need either a tiny
TF.js model (~MB scale, ships with the page) or a remote API.
The wallpaper mode is already a sketch of this — a more
ambitious version might learn the user's tap rhythm and improvise
in matching style.

---

## 3. Hypotheses worth testing first

Before committing to any of the above, three specific
measurements would re-shape the priority list:

- **Where does the bench say time goes?** Current scenarios
  report mean / p95 frame time but not a per-pass breakdown. A
  GPU-side timestamp query around each step pass (`gl.beginQuery
  /endQuery`) would tell us whether multigrid (1.4) is worth it,
  or whether bloom dominates.

- **What does the trame canary look like in numbers?** The
  current test asserts "≤20 bright pixels". Plotting the count
  over 600 idle frames as a tiny chart would surface low-level
  oscillations long before they're visually obvious — turning
  the canary into a regression *trend* instead of a regression
  alarm.

- **How often do users actually open the panel?** A tiny
  client-side counter (no telemetry — just rendered into the
  panel itself) would tell us whether the controls table belongs
  in the README or whether the on-page tooltips already cover
  90% of usage. If the latter, several of the disruptive ideas
  above (gallery, settings export) move down the list because the
  audience for them is narrower than assumed.

---

## 4. Decision protocol

For any item picked from this brainstorm:

1. **Open a single-blocC PR**, scoped tight enough that one
   reviewer can read the diff in 10 minutes.
2. **If the change touches the simulation or the velocity loop**,
   re-read `docs/agents/gotchas.md` first and add a row to the
   `tests/test.js` sim suite that would have caught the regression
   the change is most at risk of introducing.
3. **If the change adds a CONFIG key**, add it to
   `PERSISTED_CONFIG_KEYS` in the same commit and add a
   roundtrip assertion to the persistence test suite.
4. **If the change adds a UI button**, register it in
   `_syncStates()` so a persisted state surfaces correctly at
   boot.
5. **Stamp the commit** with `bash tools/stamp-version.sh
   --amend` and use the standard commit-body shape (subject in
   present tense + paragraphs explaining the *why* + the
   `~~~ on fluids ~~~` poem block + the `Co-authored-by:
   Copilot` trailer).

That protocol is what kept the most recent ten-blocC delivery
clean; it should keep the next round clean too.
