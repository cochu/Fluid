# Gotchas

Known landmines. Read **before** "fixing" anything weird.

Each entry: symptom → root cause → fix → why it matters.

---

## 1. Grid / trame at zero viscosity

- **Symptom:** A stable checkerboard pattern aligned with the simulation grid
  appears across the whole field, especially when `VISCOSITY === 0` AND the
  ≈ HQ-advect button is on.
- **Root cause:** MacCormack advection on the **velocity** field preserves
  Nyquist modes. The vorticity-confinement pass takes `grad(|curl|)`,
  normalises it (unit vector), and feeds it back — that turns numerical curl
  noise into a coherent checkerboard force. With ν = 0 nothing damps it.
- **Fix in place:**
  1. `FluidSimulation.step()` **always** uses plain `_advect` for velocity.
     `HIGH_QUALITY_ADVECTION` only gates the dye path.
  2. `VORTICITY_FRAG` (in `Shaders.js`) uses a 5-tap low-pass on the curl
     sample and a scale-aware gate so the force vanishes when the local curl
     is essentially noise.
- **What NOT to do:** Don't "improve" advection by switching velocity back to
  MacCormack, even if it looks like it sharpens detail. Don't remove the
  vorticity gate to "make swirls more pronounced".

---

## 2. Bloom toggle has no visible effect

- **Symptom:** Toggling ✺ does nothing visible.
- **Root cause:** `BLOOM_THRESHOLD` was tuned for full-brightness dye, but
  splats are pre-multiplied by `DYE_BRIGHTNESS = 0.15`. With threshold > 0.5,
  the bright-pass extracted nothing.
- **Current values** (don't drift back from these without a reason):

  ```
  DYE_BRIGHTNESS    = 0.15
  BLOOM_THRESHOLD   = 0.22   // overlapping splats peak ~0.2..0.5
  BLOOM_SOFT_KNEE   = 0.12   // tight knee = defined glow, not a wash
  BLOOM_INTENSITY   = 1.35   // makes the toggle obviously punchy
  ```

- **Particle highlights don't bloom** — particles render *after* the bloom
  pass that runs inside `fluid.render`. Acceptable trade-off; revisit only if
  particle size grows substantially.

---

## 3. Splat colour produces ugly pure-RGB or off-palette dye

- **Symptom:** A new splat code path produces over-bright or wrong-hue dye.
- **Cause:** Bypassing `pickSplatColor` and constructing `{r,g,b}` manually,
  forgetting to multiply by `CONFIG.DYE_BRIGHTNESS`, or ignoring
  `CONFIG.COLOR_MODE`.
- **Fix:** Always go through `pickSplatColor(CONFIG.COLOR_MODE, performance.now() * 0.001)`
  from `src/input/Palettes.js`. It handles brightness scaling and mode-specific
  hue ranges.
- **Audio reactivity is the one exception** — it has its own per-band hue
  formula in `AudioReactivity.js`. That's intentional (bass = warm, mids =
  cool, highs = white).

---

## 4. Tooltip text doesn't update after a state change

- **Symptom:** ◐ palette button cycles modes, but the tooltip on hover still
  shows the previous palette name.
- **Cause:** The tooltip system reads `el.dataset.tip || el.getAttribute('title')`
  on each show. **You must update `el.dataset.tip` (not `title`)** when state
  changes; updating `title` is unreliable because the tooltip code temporarily
  removes `title` to suppress the native browser tooltip.
- **Pattern:** see `_initButtons → btn-colorful` handler — set `dataset.tip`
  AND call `_flashTip(btn, label)` for instant visual confirmation.

---

## 5. iOS permission prompt never appears

- **Symptom:** Mic or tilt button does nothing on iOS Safari.
- **Cause:** Permission requests (`getUserMedia`,
  `DeviceMotionEvent.requestPermission`) must happen synchronously inside a
  user-gesture handler. Any `await` of an unrelated promise *before* the
  request breaks the gesture chain and the prompt is silently suppressed.
- **Fix template:** see `_bindAudioButton` and `_bindTiltButton` in `UI.js` —
  the inner `await this._cb.onToggle…` directly invokes the underlying
  permission API; nothing else `await`s in between.

---

## 6. `CONFIG.COLORFUL` is a legacy alias

- **Symptom:** Confused why both `COLORFUL` and `COLOR_MODE` exist.
- **Cause:** `COLORFUL` was the original boolean tint toggle. We replaced it
  with the multi-mode `COLOR_MODE`, but kept `COLORFUL` as a derived alias
  (`COLORFUL = COLOR_MODE !== 'mono'`) so any external script or snippet that
  reads `COLORFUL` still works.
- **For new code:** test `CONFIG.COLOR_MODE !== 'mono'`, never `COLORFUL`.

---

## 7. Force at slider 0 still feels too strong

- **Symptom:** "Even at minimum it pushes the fluid hard."
- **Cause:** Linear or low-power curves leave a too-large floor.
- **Current curve:** `5 + 4495 · u²` (`forceFromSlider` in `UI.js`).
  - slider 0 → 5 (essentially nothing)
  - slider 10 → 50, 20 → 185, 50 → 1129 (default), 100 → 4500.
- If asked to lower again, prefer dropping the constant (the `5`) and/or
  raising the exponent (`u²` → `u^2.4`) — keep the max in the same ballpark
  so the slider remains useful.

---

## 8. Adaptive resolution kicks in unexpectedly

- **Symptom:** SIM resolution halves while the user wasn't doing anything
  unusual.
- **Cause:** `ADAPTIVE_RESOLUTION_THRESHOLD_MS = 22 ms` (~45 FPS). If
  `avgFrameTime` crosses it for any reason (a slow tab, a one-shot GC pause
  during the 2-second window) we downsize.
- **Levers:**
  - Set `CONFIG.ADAPTIVE_RESOLUTION_THRESHOLD_MS = 0` to disable.
  - Increase `ADAPTIVE_RESOLUTION_CHECK_INTERVAL` to require a longer steady-
    state of bad frames.

---

## 9. Dead FBOs / leaked GL resources after a perf-mode toggle

- **Symptom:** Memory creeps up after repeated perf-mode toggles or adaptive
  downscales.
- **Cause:** `rebuildSubsystems()` calls `destroy()` on the old instances; if
  a new FBO was added without listing it in the `singles`/`doubles` arrays,
  it leaks.
- **Fix:** every new FBO **must** appear in the corresponding `destroy()`
  array. Likewise every program. There is no GC for GL handles.

---

## 10. Particles drift toward upper-left forever

- **Symptom:** Particles stop following the fluid and migrate uniformly.
- **Cause:** Velocity texture filtering — sampling outside `[0,1]` returns
  zeros (clamp-to-edge or repeat shouldn't matter, but a NaN seed in the pos
  texture will propagate forever).
- **Fix:** wrap any new spawn / reset path that writes positions to clamp
  outputs to `[0, 1]`. Check `PARTICLE_SPAWN_FRAG` for the existing pattern.

---

## 11. Wallpaper-mode auto-splat keeps ticking when paused / hidden

- **Symptom:** Toggling pause (or hiding the tab) while wallpaper mode is on
  leads to a burst of splats on un-pause / re-focus, or to silent ticking
  that wastes CPU.
- **Cause:** Implementing the cadence with `setInterval` and only gating it
  at toggle time. The interval keeps firing the handler in the background;
  even with a `CONFIG.PAUSED` check inside the handler, the elapsed-since-
  last-emission timer drifts and produces visible bursts when the gate
  opens again.
- **Fix:** drive the cadence from a per-frame accumulator inside `animate()`.
  `animate()` already returns early under `CONFIG.PAUSED` and
  `document.hidden`, so both pause and tab-hide naturally suppress the
  splat *and* freeze the accumulator at its current value — the next
  active frame resumes from where it left off. No separate timer to leak,
  no backlog. See `wallpaperAccumMs` in `src/main.js`.

---

## 12. Adaptive resolution mis-fires after a tab visibility change

- **Symptom:** Returning to the tab after several minutes triggers an
  immediate adaptive downscale even though the canvas now renders at a
  comfortable rate.
- **Cause:** The hysteresis counters (`downscaleConsecutive`,
  `upscaleConsecutive`) and the EMA `avgFrameTime` straddle the hidden
  interval. The samples taken right before the tab was hidden may have
  been bad (the OS started throttling background rAF callbacks); the
  next active sample inherits that history and the consecutive-window
  threshold is satisfied immediately.
- **Fix:** in the `visibilitychange` handler, when `!document.hidden`,
  reset `downscaleConsecutive` and `upscaleConsecutive` to 0 and push
  `adaptiveCooldownUntil` out by one downscale cool-down so the next
  decision waits for a fresh window of samples. `lastTime` is already
  reset there for the same reason.

---

## 13. TDZ in `main.js` boot — frozen canvas, no input wired

- **Symptom:** The HTML/CSS shell paints (buttons, gradient background,
  version tag), but the canvas never animates and pointer events do
  nothing. Console shows
  `ReferenceError: Cannot access 'X' before initialization`
  pointing into `src/main.js`.
- **Root cause:** A new top-level `const`/`let` was added **after** the
  `new UI(CONFIG, { … })` call but is referenced **eagerly** inside the
  options literal — typically as a property short-hand value like
  `recordingSupported: !!recorder,`. The literal is evaluated at the
  call site, before the binding is initialised, which throws a TDZ
  ReferenceError that aborts the whole module. Method-shorthand keys
  (`onSnapshot() { … }`) are lazy and not affected; **bare expression
  values are eager and are**.
- **Fix in place:** PR #8 hoisted `const recorder = …` (and the
  cautionary comment in `src/main.js`) above `new UI(...)`. Same
  hoisting rule applies to any future binding referenced in that
  literal.
- **What NOT to do:** Don't paper over by switching the eager value to
  a getter (`get recordingSupported() { return !!recorder; }`); the UI
  caches the value at construction and the runtime feature flag would
  silently lie. Just declare the binding before the call.
- **Regression net:** the `boot` suite in `tests/test.js` loads
  `index.html` inside an isolated iframe and asserts no uncaught script
  errors fire during boot. **Run it on every PR that touches `main.js`
  or any of its imports.** It is the only test in the harness that
  actually evaluates the bootstrap module.
