# Fluid

A real-time interactive fluid simulation running in the browser with WebGL2.  
Inspired by the Navier-Stokes equations — touch it, paint with it, play with it.

---

## Vision

Fluid is a **mobile-first WebGL2 fluid simulation** that lets you interact with a fluid in real time using fingers on a touchscreen or a mouse on desktop.

- **Touch the screen** to push and swirl the fluid.  
- **Particles** are advected naturally by the flow — watch them follow the currents.  
- **Minimal UI** — just the simulation, nothing in the way.  
- Targets **60 FPS on high-end mobile** (tested on Pixel 8 Pro / Chrome).  
- Automatic quality reduction when the device struggles.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | Vanilla JavaScript (ES Modules) | No build step needed, easy to extend |
| Rendering | WebGL2 | Float textures, `gl_VertexID`, fast enough on mobile |
| Shaders | GLSL ES 3.00 inline strings | No extra tooling required |
| Input | Pointer Events API | Unified mouse + multi-touch |
| Deployment | Any static host | No backend required |

No npm, no bundler, no framework — a plain `index.html` you can open in a browser.

---

## Installation & Local Development

```bash
# Clone the repository
git clone https://github.com/cochu/Fluid.git
cd Fluid

# Serve the files with any static server
# Option 1 – Python (built-in)
python3 -m http.server 8080

# Option 2 – Node.js (npx, no install)
npx serve .

# Option 3 – VS Code Live Server extension
# Just open index.html and click "Go Live"
```

Open `http://localhost:8080` in Chrome.

> **Note:** The file must be served over HTTP/HTTPS (not `file://`) because ES modules require a server context.

---

## Deployment (Static Hosting)

The entire project is a static site — no build step needed.

### GitHub Pages
1. Push to `main`.  
2. Go to **Settings → Pages → Source → main branch / root**.  
3. Your simulation lives at `https://<username>.github.io/Fluid/`.

### Vercel / Netlify
- Import the repository.  
- Leave build command **empty**.  
- Set publish directory to `.` (repository root).  
- Deploy.

---

## Architecture

```
Fluid/
├── index.html                  Entry point, canvas, UI skeleton
├── styles/
│   └── main.css                Full-screen layout, panel, buttons
└── src/
    ├── config.js               All runtime parameters (live object)
    ├── main.js                 Animation loop, subsystem wiring
    ├── webgl/
    │   └── GLUtils.js          Context creation, FBO/texture helpers
    ├── fluid/
    │   ├── Shaders.js          All GLSL sources (vertex + fragment)
    │   └── FluidSimulation.js  Navier-Stokes solver (GPU)
    ├── particles/
    │   └── ParticleSystem.js   GPU particle advection + rendering
    ├── input/
    │   └── InputHandler.js     Pointer Events → splat calls
    └── ui/
        └── UI.js               DOM wiring for controls
```

### Data flow each frame

```
InputHandler ──splat()──► FluidSimulation.step()
                              │  1. vorticity confinement
                              │  2. velocity self-advection
                              │  3. divergence
                              │  4. pressure Jacobi solve  (×N)
                              │  5. gradient subtraction
                              │  6. dye advection
                              ▼
ParticleSystem.update()    ← velocity texture
ParticleSystem.render()
FluidSimulation.render()   → canvas (+ optional bloom)
```

### Simulation overview

The fluid is modelled on an Eulerian grid using the incompressible Navier-Stokes equations:

1. **Advection** — semi-Lagrangian (back-trace along velocity).  
2. **Diffusion** — implicit (absorbed into dissipation for visual purposes).  
3. **Pressure projection** — iterative Jacobi solver (20–25 iterations/frame).  
4. **Vorticity confinement** — reinjects angular momentum to restore fine swirls.

Two ping-pong FBOs are used per quantity (velocity, dye, pressure) so that we can read from one while writing to the other without a GPU stall.

### Particle system

Up to 10 000 GPU particles are stored as a floating-point texture `(x, y, lifetime, 0)`.  
An update fragment shader advects each particle through the velocity field and decrements its lifetime. Expired particles respawn at random positions.  
The render pass uses `gl_VertexID` (WebGL2) to look up each particle's position from the texture — no CPU readback required.

---

## Controls

| Control | Action |
|---|---|
| **↺** | Reset simulation |
| **✦** | Toggle GPU particles |
| **💧** | Drop particles — press and drag this button onto the canvas to pour particles at the pointer |
| **✺** | Toggle bloom post-process |
| **◐** | Toggle colorful auto-hue mode |
| **Force** slider | Splat force magnitude |
| **Particles** slider | Particle count (500 – 10 000) |
| **Dissipation** slider | How quickly dye & velocity fade |
| **⚡** | Performance mode (halves resolution) |

---

## Performance Notes

| Device class | Expected FPS | Notes |
|---|---|---|
| Pixel 8 Pro (Chrome) | ~60 FPS | Default settings |
| Mid-range Android | ~40-60 FPS | Use ⚡ performance mode |
| Desktop Chrome | 60+ FPS | |

- `devicePixelRatio` is capped at **2×** to avoid overdraw on 3× screens.  
- Simulation grid (`SIM_RESOLUTION`) is separate from dye grid (`DYE_RESOLUTION`).  
- **Adaptive resolution**: if average frame time exceeds 22 ms the simulation automatically halves its grid resolution.  
- The animation loop pauses when the tab is in the background (Page Visibility API).

---

## Benchmarking

A self-contained benchmark page lives at `bench/bench.html`. It runs four
deterministic scenarios (high-quality vs. perf mode, ν=0 vs. ν=0.05) with a
seeded splat sequence, then reports mean / p95 frame time and the divergence
L2 residual after the pressure solve.

```bash
python3 -m http.server 8080
# then open
http://localhost:8080/bench/bench.html
# Append ?auto=1 to start the full run automatically; the result is also
# exposed on window.__BENCH_RESULT__ for headless drivers.
```

Use it to compare branches before/after tweaks to the solver, precision
settings, or Jacobi iteration count.

---

## Recent fixes

- **Vorticity confinement axes**: `VORTICITY_FRAG` was reading the gradient of
  `|ω|` with x/y swapped, which broke rotational symmetry and biased the
  reinjected force along diagonals — particularly visible at ν≈0 as a
  fractal-like drift. Now fixed.
- **High precision pressure pipeline**: `CURL`, `DIVERGENCE`, `PRESSURE` and
  `GRADIENT_SUBTRACT` shaders now declare `highp` for floats and samplers.
  On mobile GPUs `mediump` collapsed to fp16, and 25 Jacobi iterations on
  fp16 imprinted a stable grid pattern when there was no diffusion to mask
  it.
- **Pointer-rate-independent splats**: the input handler now scales the
  per-event force by `16.667ms / Δt`, so 120/240 Hz pointers no longer push
  several times harder than 60 Hz mice. The `Force` slider keeps its
  60 Hz semantics.

---

## Roadmap

- [ ] **Obstacles** — add static shapes that deflect the fluid  
- [ ] **Audio-reactive** — drive splat force from microphone input  
- [ ] **Dye save/export** — screenshot or gif export  
- [ ] **WebGPU** migration for even better mobile throughput  
- [ ] **PWA** manifest + offline support  
- [ ] **Color presets** — pastel, monochrome, fire, aurora themes  
- [ ] **Viscosity control** — diffusion iterations exposed in the UI  
