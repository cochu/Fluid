/**
 * main.js – Application entry point.
 *
 * Responsibilities:
 *   - Initialise WebGL2 context
 *   - Set up the fluid simulation, particle system, input handler, and UI
 *   - Run the main animation loop with adaptive resolution and tab-visibility
 *     pause/resume
 *   - Resize the canvas to match the device screen
 */

import { CONFIG }         from './config.js';
import { getWebGL2Context } from './webgl/GLUtils.js';
import { FluidSimulation }  from './fluid/FluidSimulation.js';
import { ParticleSystem }   from './particles/ParticleSystem.js';
import { InputHandler }     from './input/InputHandler.js';
import { UI }               from './ui/UI.js';
import { AudioReactivity }  from './audio/AudioReactivity.js';

// One-line WebGPU capability probe. The simulation still runs on WebGL2
// (a full WebGPU port is a separate, much larger effort), but logging the
// availability here gives us a hook for that future migration without
// changing any user-visible behaviour.
if ('gpu' in navigator) {
  navigator.gpu.requestAdapter()
    .then((adapter) => console.info('[Fluid] WebGPU adapter detected:', adapter && adapter.info ? adapter.info : '(present)'))
    .catch(() => { /* ignore – purely informational */ });
}

/* ──────────────────────────────────────────────────────────────────────
   1.  Canvas setup
   ────────────────────────────────────────────────────────────────────── */

const canvas  = document.getElementById('canvas');
const errorEl = document.getElementById('webgl-error');

/** Resize the canvas's backing store to match the CSS/screen size. */
function resizeCanvas() {
  const dpr    = Math.min(window.devicePixelRatio || 1, 2); // cap at 2× for perf
  const w      = Math.round(canvas.clientWidth  * dpr);
  const h      = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

/* ──────────────────────────────────────────────────────────────────────
   2.  WebGL2 initialisation
   ────────────────────────────────────────────────────────────────────── */

const result = getWebGL2Context(canvas);
if (!result) {
  errorEl.classList.remove('hidden');
  throw new Error('WebGL2 not available');
}

const { gl, ext } = result;

// Disable depth testing (2-D only)
gl.disable(gl.DEPTH_TEST);
gl.disable(gl.CULL_FACE);

/* ──────────────────────────────────────────────────────────────────────
   3.  Subsystem initialisation
   ────────────────────────────────────────────────────────────────────── */

let fluid     = new FluidSimulation(gl, ext, CONFIG);
let particles = new ParticleSystem(gl, ext, CONFIG);

/* ──────────────────────────────────────────────────────────────────────
   4.  Input handling
   ────────────────────────────────────────────────────────────────────── */

const input = new InputHandler(canvas, handleSplat, CONFIG);

function handleSplat(x, y, dx, dy, color) {
  fluid.splat(x, y, dx, dy, color);
}

/* ──────────────────────────────────────────────────────────────────────
   5.  UI
   ────────────────────────────────────────────────────────────────────── */

const ui = new UI(CONFIG, {
  onReset() {
    fluid.reset();
  },
  onToggleParticles(on) {
    // Nothing extra needed – the render loop checks CONFIG.PARTICLES
  },
  onToggleBloom(on) {
    // Nothing extra needed
  },
  onToggleColorful(on) {
    // Nothing extra needed
  },
  onTogglePerfMode(perfMode) {
    // Recreate simulation FBOs at the new resolution
    fluid     = new FluidSimulation(gl, ext, CONFIG);
    particles = new ParticleSystem(gl, ext, CONFIG);
  },
  onForceChange(v) {
    // CONFIG already updated by UI
  },
  onParticleCountChange(v) {
    CONFIG.PARTICLE_COUNT = v;
    particles.resize(v);
  },
  onDissipationChange(v) {
    // CONFIG already updated by UI
  },
  onParticleDrop(x, y) {
    // Coalesce multiple events per frame into a single GPU pass
    pendingDrop = { x, y };
  },
  async onToggleAudio(want) {
    if (want) {
      try {
        await audio.start();
        return true;
      } catch (err) {
        // Surface the failure to the UI so it can show the denied state.
        throw err;
      }
    } else {
      audio.stop();
      return false;
    }
  },
});

/** Most recent particle drop request from the UI; consumed in animate(). */
let pendingDrop = null;

/* ──────────────────────────────────────────────────────────────────────
   5b. Audio reactivity (microphone-driven radial speaker waves)
   ────────────────────────────────────────────────────────────────────── */

const audio = new AudioReactivity(handleSplat, CONFIG);

/* ──────────────────────────────────────────────────────────────────────
   6.  Automatic random splats (seed the simulation on first load)
   ────────────────────────────────────────────────────────────────────── */

function randomSplat() {
  const x = Math.random();
  const y = Math.random();
  const angle = Math.random() * Math.PI * 2;
  const force = CONFIG.SPLAT_FORCE * (0.5 + Math.random());
  const dx = Math.cos(angle) * force;
  const dy = Math.sin(angle) * force;
  fluid.splat(x, y, dx, dy, {
    r: Math.random() * CONFIG.DYE_BRIGHTNESS,
    g: Math.random() * CONFIG.DYE_BRIGHTNESS,
    b: Math.random() * CONFIG.DYE_BRIGHTNESS,
  });
}

// Seed with a few initial splats
for (let i = 0; i < 5; i++) randomSplat();

/* ──────────────────────────────────────────────────────────────────────
   7.  Animation loop
   ────────────────────────────────────────────────────────────────────── */

let lastTime        = performance.now();
let frameCount      = 0;
let fpsAccum        = 0;
let fpsUpdateTimer  = 0;
let adaptiveTimer   = 0;

/** Exponential moving average of frame time (ms). */
let avgFrameTime = 16.7;

function animate(now) {
  requestAnimationFrame(animate);

  // Skip frames while the tab is hidden to save battery
  if (document.hidden) return;

  if (CONFIG.PAUSED) return;

  const dt = Math.min((now - lastTime) / 1000, 0.05); // cap at 50ms to avoid explosion
  lastTime = now;

  // ── Adaptive resolution ──────────────────────────────────────────
  const threshold = CONFIG.ADAPTIVE_RESOLUTION_THRESHOLD_MS;
  if (threshold > 0) {
    adaptiveTimer += dt;
    if (adaptiveTimer > CONFIG.ADAPTIVE_RESOLUTION_CHECK_INTERVAL) {
      adaptiveTimer = 0;
      if (avgFrameTime > threshold && CONFIG.SIM_RESOLUTION > 64) {
        CONFIG.SIM_RESOLUTION = Math.max(64, CONFIG.SIM_RESOLUTION >> 1);
        CONFIG.DYE_RESOLUTION = Math.max(128, CONFIG.DYE_RESOLUTION >> 1);
        fluid     = new FluidSimulation(gl, ext, CONFIG);
        particles = new ParticleSystem(gl, ext, CONFIG);
        console.log(`[Fluid] Auto-reduced resolution to ${CONFIG.SIM_RESOLUTION}`);
      }
    }
  }

  // ── Audio reactivity ──────────────────────────────────────────────
  // Cheap no-op when the mic toggle is off; otherwise emits a radial
  // burst of splats from the canvas centre on detected bass beats.
  audio.tick(now);

  // ── Fluid step ────────────────────────────────────────────────────
  fluid.step(dt);

  // ── Particle update ───────────────────────────────────────────────
  if (CONFIG.PARTICLES) {
    gl.disable(gl.BLEND);
    if (pendingDrop) {
      particles.spawnAt(pendingDrop.x, pendingDrop.y);
      pendingDrop = null;
    }
    particles.update(fluid.velocityTexture, dt);
  } else {
    pendingDrop = null;
  }

  // ── Render ────────────────────────────────────────────────────────
  resizeCanvas();

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Draw fluid dye
  gl.disable(gl.BLEND);
  fluid.render(null, canvas.width, canvas.height);

  // Draw particles on top with additive blending
  if (CONFIG.PARTICLES) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);   // additive – bright on dark bg
    particles.render(canvas.width, canvas.height, fluid.velocityTexture);
    gl.disable(gl.BLEND);
  }

  // ── FPS counter ────────────────────────────────────────────────────
  frameCount++;
  fpsAccum    += dt * 1000;
  fpsUpdateTimer += dt;

  if (fpsUpdateTimer >= 0.5) {
    const fps = frameCount / fpsUpdateTimer;
    avgFrameTime = fpsAccum / frameCount;
    ui.updateFPS(fps);
    frameCount     = 0;
    fpsAccum       = 0;
    fpsUpdateTimer = 0;
  }
}

requestAnimationFrame(animate);

/* ──────────────────────────────────────────────────────────────────────
   8.  Visibility API – pause when tab is hidden
   ────────────────────────────────────────────────────────────────────── */

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Reset lastTime so we don't get a huge dt after returning
    lastTime = performance.now();
  }
});
