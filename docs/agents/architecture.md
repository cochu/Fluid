# Architecture

High-level wiring of how a frame goes from a touch event to a pixel on screen.
Load this when changing the solver, adding a pass, or editing `main.js`'s loop.

---

## 1. Module graph

```
                          ┌──────────────┐
                          │  index.html  │  (DOM scaffold + SW registration)
                          └──────┬───────┘
                                 │ <script type="module">
                                 ▼
                          ┌──────────────┐
                          │   main.js    │  bootstrap + RAF loop
                          └─┬──┬───┬──┬──┘
              ┌─────────────┘  │   │  └─────────────┐
              ▼                ▼   ▼                ▼
     ┌────────────────┐ ┌──────────┐ ┌────────────┐ ┌────────────────┐
     │FluidSimulation │ │ Particle │ │   UI.js    │ │ AudioReactivity│
     │  + Shaders.js  │ │  System  │ │            │ │ Accelerometer  │
     └───────┬────────┘ └─────┬────┘ └────┬───────┘ │ InputHandler   │
             │                │           │         └───────┬────────┘
             ▼                ▼           ▼                 │
       ┌──────────────────────────────────────┐             │
       │           webgl/GLUtils.js           │ ◄───────────┘
       │ (context, formats, FBO, program, blit)│
       └──────────────────────────────────────┘
```

- `UI` only ever **mutates `CONFIG`** and **emits callbacks**.
- All "input" sources (pointer, audio, accelerometer) funnel into the same
  `handleSplat(x, y, dx, dy, color)` in `main.js` → `fluid.splat(...)`.
- `main.js` owns the only RAF loop. Sub-systems expose `step`, `update`, `tick`.

---

## 2. Per-frame loop (`main.js::animate`)

In strict order:

1. `requestAnimationFrame(animate)` — schedule next frame first (so an exception
   later still keeps the loop alive on resume).
2. Bail if `document.hidden` or `CONFIG.PAUSED`.
3. Compute `dt = min((now - lastTime)/1000, 0.05)` — capped to avoid the
   post-resume explosion.
4. **Adaptive resolution** — every `ADAPTIVE_RESOLUTION_CHECK_INTERVAL` seconds,
   if `avgFrameTime > ADAPTIVE_RESOLUTION_THRESHOLD_MS` and we're above 64 sim,
   halve `SIM_RESOLUTION` / `DYE_RESOLUTION` and call `rebuildSubsystems()`.
5. `audio.tick(now)` then `tilt.tick(now)` — both are cheap no-ops when off.
6. `fluid.step(dt)` — the simulation pass (see §3 below).
7. `particles.update(fluid.velocityTexture, dt)` — only when `CONFIG.PARTICLES`.
8. Resize canvas backing store to current DPR.
9. Clear default framebuffer to black, render fluid (no blend).
10. Render particles on top with `(ONE, ONE_MINUS_SRC_ALPHA)` (premultiplied).
11. If `snapshotPending`, `gl.finish()` + `canvas.toBlob()` → download.
12. Update FPS counter every 0.5 s.

Important: **particles render after the fluid but before the bloom pass that
ran inside `fluid.render`** — that means particle highlights do not bloom.
This is a known trade-off (cheaper, simpler ordering); it's flagged in
`gotchas.md`.

---

## 3. Simulation step (`FluidSimulation.step(dt)`)

Standard stable-fluids pipeline (Stam 1999), with optional MacCormack and
implicit viscous diffusion:

```
   _advect(velocity)                  ← always plain SL (NOT MacCormack)
   _applyVorticity(dt)                ← gated curl confinement
   if VISCOSITY > 0:
     _diffuseVelocity()               ← N Jacobi iterations, implicit
   _computeDivergence()
   _clearPressure()
   for PRESSURE_ITERATIONS:
     _pressureSolve()                 ← Jacobi
   _subtractGradient()                ← project velocity to divergence-free
   if HIGH_QUALITY_ADVECTION:
     _advectMacCormack(dye)           ← dye only
   else:
     _advect(dye)
```

Why velocity is always plain SL: MacCormack on velocity preserves Nyquist
modes; the vorticity-confinement gradient then amplifies them into a stable
checkerboard — visible whenever viscosity ≈ 0. Fix is in `gotchas.md`.

---

## 4. Framebuffers (FBO inventory)

Owned by `FluidSimulation` (rebuilt by `_setupFBOs()` and freed by `destroy()`):

| FBO              | Format     | Size              | Purpose                  |
|------------------|------------|-------------------|--------------------------|
| `velocity`       | RG16F (×2) | SIM × SIM         | Ping-pong velocity field |
| `dye`            | RGBA16F (×2)| DYE × DYE        | Ping-pong colour field   |
| `pressure`       | R16F (×2)  | SIM × SIM         | Ping-pong pressure       |
| `divergence`     | R16F       | SIM × SIM         | One-shot divergence      |
| `curl`           | R16F       | SIM × SIM         | One-shot curl            |
| `dyeTmpFwd/Bak`  | RGBA16F    | DYE × DYE         | MacCormack temporaries (dye only) |
| `viscB`          | RG16F      | SIM × SIM         | Right-hand side for viscous Jacobi |
| `bloomFBO/Temp`  | RGBA16F    | BLOOM_RES         | Bloom downsample/upsample |

All allocated through `createFBO` / `createDoubleFBO` in `webgl/GLUtils.js`.
Format fallbacks (RGBA8 if half-float not renderable) are handled there.

`ParticleSystem` owns its own pos/vel double-FBOs at sqrt(PARTICLE_COUNT)².

---

## 5. Input pipeline

```
                ┌─────────────┐
                │ PointerEvents│
                └──────┬───────┘
   ┌────────┐         ▼               ┌────────────┐
   │ btn-…  │   InputHandler.js       │AudioReact. │
   │ sliders│ → pickSplatColor() ─┐   │ + bands    │
   └───┬────┘                     │   └─────┬──────┘
       ▼                          ▼         ▼
   UI.js → CONFIG mutations    handleSplat(x,y,dx,dy,color)
                                    │
                                    ▼
                              fluid.splat(...)
                                    │
                                    ▼
                              SPLAT_FRAG (Gaussian)
```

`AccelerometerInput.tick()` and shake handler also call `handleSplat`.
Everyone goes through the same single splat shader — there are no
"special" splats; only colour and force vary.
