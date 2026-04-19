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
