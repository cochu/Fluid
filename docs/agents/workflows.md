# Workflows

End-to-end procedures for shipping a change. Load when committing.

---

## 1. Local development

```bash
# Any static server. The simulation requires WebGL2 + ES modules,
# so file:// will NOT work (modules are subject to CORS).
python3 -m http.server 8080
# open http://localhost:8080
```

Useful URL params and tricks:

- The PWA service worker is registered only on `https://`, `localhost`, or
  `127.0.0.1`. On other hosts you'll get the warning in the console — that's
  intentional.
- Open the dev console: `window.__FLUID_BUILD__` shows the loaded build id.
- `CONFIG` is reachable from the console only if you import it; tweak via the
  UI buttons / sliders or by stepping into the `ui` instance.

---

## 2. Perf measurement

`bench/bench.html` is a self-contained harness:

```bash
python3 -m http.server 8080
# open http://localhost:8080/bench/bench.html
```

It instantiates the same simulation against a fixed sequence of synthetic
splats and prints rolling frame-time stats (avg / p95 / p99 ms) plus FPS to
the page. Use it for **before/after** comparisons:

1. Note the bench numbers on `main` before your change.
2. Apply the change, re-run, eyeball the same metrics.
3. Worry if p95 drifts more than ~15% in either direction.

When optimising, aim for: **avg ≤ 16 ms, p95 ≤ 22 ms** at default config on a
mid-tier machine. Below those, `ADAPTIVE_RESOLUTION_THRESHOLD_MS` (22 ms) will
kick in and the user starts losing visual quality.

---

## 3. Browser smoke test

Anything that touches rendering or input deserves an eyeball check before
push. Mental checklist:

- Default page loads, splats appear on click/touch, no console errors.
- ◐ palette button cycles through all 7 modes; tooltip flashes the name.
- ✦ particles toggle on/off without flicker.
- 💧 drop button: tap = central confetti + tooltip; drag = dye trail.
- ✺ bloom toggle is *visibly* different.
- ≈ HQ-advect toggle: at viscosity 0 it must NOT introduce a checkerboard.
- ⏸ pause + spacebar pause both work; overlay shows.
- 📷 snapshot downloads a PNG named `fluid-<sha>-<ts>.png`.
- 🎤 mic toggle: prompts permission once, light-up on speech.
- 🧭 tilt toggle (mobile only): tilt → fluid drifts, shake → off-centre stir.

---

## 4. Version stamping (mandatory after every commit)

```bash
git commit -m "..."                    # normal commit
bash tools/stamp-version.sh --amend    # folds short SHA + UTC date into
                                       # src/version.js, amends HEAD
git push origin main
```

The version tag in the bottom corner of the UI (`Fluid · <sha>-<date>`) is the
only way users (and you, when triaging bug reports) can tell *which build is
loaded*. Skipping the stamp leaves the UI showing a stale SHA and pollutes
session-store search.

---

## 5. Commit messages

- **Subject** in present tense, imperative mood, no period, ≤ 72 chars.
- **Body** explains *why* — what regression this prevents, what behaviour
  this adds. Wrap at ~72 chars.
- **Trailer** mandatory for AI-authored commits:

  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

Good example:

```
Drop dead velTmpFwd/velTmpBak FBOs (unused since velocity is plain SL)

Velocity self-advection no longer takes the MacCormack path, so the
two RG16F velocity tmp framebuffers are pure dead allocations. Saves
roughly simW*simH*8 bytes of VRAM (~256 KB at 256x256, doubled on
RGBA fallback paths) and one less FBO to track in destroy().

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## 6. iOS / mobile-specific notes

- **Microphone (`AudioReactivity`) and motion (`AccelerometerInput`)** both
  require a user gesture for permission on iOS Safari. Both UI buttons request
  permission *inside* the click handler — preserve that chain. Don't wrap the
  request in a `setTimeout` or `await` of an unrelated promise; the gesture
  flag will have lapsed and the prompt will be silently denied.
- **`viewport-fit=cover`** + `theme-color=#000000` are set in `index.html` so
  the app feels native on iOS standalone install. Don't change these without a
  reason.
- **DPR cap = 2** in `main.js::resizeCanvas`. Higher DPR on phones makes the
  GPU cost explode for marginal visual gain — leave it.

---

## 7. Adding a new tunable

1. Add the field with a `/** … */` doc-comment in `src/config.js`.
2. If user-controllable, add a button or slider in `index.html` and wire it
   in `src/ui/UI.js::_initButtons` / `_initSliders`. Use the existing
   `_bind` / `_toggle` / `_flashTip` helpers.
3. Make sure the consumer reads `this._config.X` (not a snapshot at construct
   time) so runtime UI changes take effect immediately.
4. Surface the default in `_syncStates` so the button class reflects the
   initial state.

---

## 8. Adding a new render pass / FBO

1. Allocate in `_setupFBOs()` of the owning class.
2. Add the name to the `singles`/`doubles` arrays in `destroy()`.
3. Compile the program once in `_initPrograms()` and cache the uniform
   locations.
4. Call from `step()` between the existing passes — read
   `architecture.md#3-simulation-step` for the canonical order.

---

## 9. The BMAD-Fluid persona review (mandatory for non-trivial change)

Read [`method.md`](method.md) for the full description. Quick form:

1. **Pre-flight** — invoke a rubber-duck loaded with each relevant persona
   MD (`personas/*.md`) plus a one-paragraph description of the planned
   change. Capture findings, decide which to adopt, note rejections.
2. **Implement** — code, `node --check`, browser smoke-test.
3. **Diff review** — invoke the same personas with the actual diff. Iterate.
4. **Compose the commit** — use the template in §10 below (the poem is
   mandatory).

Picker matrix lives in [`method.md#6-quick-persona-picker`](method.md#6-quick-persona-picker).

---

## 10. Commit message template (with mandatory fluid poem)

```
<imperative subject — 50 chars or less>

<wrap-at-72 body explaining what changed, why, and which persona pass(es)
covered it. Reference gotchas you specifically checked.>

~~~ on fluids ~~~
A short verse about flow / pressure / dye / light through water.
Three to six lines. Free verse or any structured form.
Concrete imagery — no commits, no code, no AI metaphors.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

The poem is checked at PR review time. A missing or off-topic poem blocks
merge.
