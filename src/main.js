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
import { AccelerometerInput } from './input/AccelerometerInput.js';
import { pickSplatColor }   from './input/Palettes.js';
import { BUILD_VERSION }    from './version.js';
import {
  bootstrap as bootPersistence,
  installAutoSave,
  buildShareUrl,
  clearStorage as clearPersistedStorage,
} from './persistence.js';

// Expose the build identifier early so the UI version tag (and any
// console snooping) can pick it up without an explicit import.
window.__FLUID_BUILD__ = BUILD_VERSION;

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

// Restore persisted settings BEFORE constructing the simulation so that
// PERF_MODE / SOURCES / palette etc. are already in CONFIG when the FBOs
// are sized. URL hash takes precedence over localStorage; both fail silent.
const persistBoot = bootPersistence();
if (CONFIG.PERF_MODE) {
  // Apply the same transforms the perf-mode toggle does, so a persisted
  // perf-mode user gets the smaller grid on first frame instead of paying
  // a full-resolution rebuild.
  CONFIG.SIM_RESOLUTION       = 64;
  CONFIG.DYE_RESOLUTION       = 256;
  CONFIG.PRESSURE_ITERATIONS  = 10;
  CONFIG.BLOOM_ITERATIONS     = 4;
}

let fluid     = new FluidSimulation(gl, ext, CONFIG);
let particles = new ParticleSystem(gl, ext, CONFIG);

/**
 * Tear down the current simulation pair and instantiate replacements.
 * If construction throws (shader compile fail / OOM / context lost),
 * we keep the engine paused with a console error rather than letting
 * the render loop step a destroyed object next frame.
 */
function rebuildSubsystems(reason) {
  try {
    fluid.destroy?.();
    particles.destroy?.();
  } catch (e) {
    console.warn('[Fluid] destroy() threw during rebuild:', e);
  }
  try {
    fluid     = new FluidSimulation(gl, ext, CONFIG);
    particles = new ParticleSystem(gl, ext, CONFIG);
    // Replay any painted obstacles onto the fresh FBO so adaptive
    // resolution / perf-mode toggles don't silently delete walls.
    if (typeof undoStack !== 'undefined' && undoStack.length) {
      replayObstacles();
    }
  } catch (e) {
    console.error(`[Fluid] Rebuild failed (${reason}); pausing.`, e);
    CONFIG.PAUSED = true;
  }
}

/* ──────────────────────────────────────────────────────────────────────
   4.  Input handling
   ────────────────────────────────────────────────────────────────────── */

const input = new InputHandler(canvas, handleSplat, CONFIG);

function handleSplat(x, y, dx, dy, color) {
  // Obstacle-paint mode: the move callback paints solid mass instead of
  // injecting fluid. We rely on the InputHandler's per-move events for
  // continuous painting along the drag path. Each painted dab is also
  // appended to the in-progress stroke object so adaptive-resolution
  // rebuilds can replay the obstacle field, AND the user can undo the
  // last drag as one logical unit.
  if (CONFIG.OBSTACLE_MODE) {
    const r    = CONFIG.OBSTACLE_PAINT_RADIUS;
    const sign = CONFIG.OBSTACLE_ERASE ? -1 : +1;
    fluid.paintObstacle(x, y, r, sign);
    if (currentStroke) {
      currentStroke.dabs.push({ x, y, r, sign });
    } else {
      // Fallback for the very first move event arriving before the
      // pointerdown listener (defensive): start a new stroke now so the
      // dab is still recorded for replay.
      currentStroke = { dabs: [{ x, y, r, sign }] };
    }
    return;
  }
  fluid.splat(x, y, dx, dy, color);
}

/** Stack of completed obstacle strokes. Each stroke is the dabs of one
 *  continuous pointer drag (paint or erase). Capped at UNDO_STACK_MAX;
 *  oldest strokes silently drop off the bottom. Replayed onto a freshly
 *  built fluid sim so obstacles survive resize / perf-mode toggles. */
const undoStack = [];
const UNDO_STACK_MAX = 64;

/** The drag currently being assembled (between pointerdown and
 *  pointerup). null when no drag is in progress. */
let currentStroke = null;

/** Number of active pointers currently down on the canvas in obstacle
 *  mode; the ↶ Undo button is disabled while this is > 0 so the user
 *  can't undo a half-drawn stroke that is still being recorded. */
let obstacleActivePointers = 0;

/** Re-paint the obstacle FBO from the entire undo stack. Called by the
 *  Undo button after popping the last stroke, and by rebuildSubsystems
 *  after a perf-mode toggle / adaptive downscale. */
function replayObstacles() {
  fluid.clearObstacles();
  for (let i = 0; i < undoStack.length; i++) {
    const dabs = undoStack[i].dabs;
    for (let j = 0; j < dabs.length; j++) {
      const d = dabs[j];
      fluid.paintObstacle(d.x, d.y, d.r, d.sign);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────
   4b.  Source-placement mode (capture-phase, intercepts InputHandler)
   ────────────────────────────────────────────────────────────────────── */

let sourceDragStart = null;
function pointerToUV(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x:     (e.clientX - rect.left) / rect.width,
    y: 1 - (e.clientY - rect.top)  / rect.height,
  };
}
canvas.addEventListener('pointerdown', (e) => {
  if (!CONFIG.SOURCE_MODE) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  sourceDragStart = pointerToUV(e);
}, true);
canvas.addEventListener('pointerup', (e) => {
  if (!CONFIG.SOURCE_MODE || !sourceDragStart) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const end = pointerToUV(e);
  const dx  = end.x - sourceDragStart.x;
  const dy  = end.y - sourceDragStart.y;
  const len = Math.hypot(dx, dy);
  // Default direction (upward) when the user just taps. Drag → vector.
  // Scale: a 0.2-UV drag yields a force comparable to a single splat.
  let vx, vy;
  if (len < 0.015) { vx = 0;          vy = 0.45; }
  else             { vx = dx * 4.5;   vy = dy * 4.5; }
  const color = pickSplatColor(CONFIG.COLOR_MODE || 'rainbow', performance.now() * 0.001);
  CONFIG.SOURCES.push({
    x: sourceDragStart.x, y: sourceDragStart.y,
    dx: vx, dy: vy, color, rate: 1,
  });
  ui.refreshSources?.();
  sourceDragStart = null;
}, true);
canvas.addEventListener('pointercancel', (e) => {
  if (!CONFIG.SOURCE_MODE) return;
  sourceDragStart = null;
}, true);

/* ──────────────────────────────────────────────────────────────────────
   4c.  Obstacle-stroke lifecycle (paint or erase, one drag = one stroke)
   --------------------------------------------------------------------
   These listeners fire BEFORE the InputHandler's because they are
   bound during construction order with the same canvas element; both
   are non-capturing so the InputHandler still gets the event. We use
   them only to bracket the drag — the actual dab recording happens
   inside `handleSplat()` which the InputHandler already routes per
   pointer move.
   ────────────────────────────────────────────────────────────────────── */

function obstacleDragStart(_e) {
  if (!CONFIG.OBSTACLE_MODE) return;
  obstacleActivePointers++;
  // Always start a fresh stroke object on each new pointer; if multiple
  // fingers are down we still funnel into one stroke (the dabs
  // interleave) — that matches the user's mental model of "one editing
  // session per drag" rather than "one stroke per finger".
  if (!currentStroke) {
    currentStroke = { dabs: [] };
  }
  // Disable undo while any pointer is down so the stack can't be
  // popped mid-drag.
  ui?.setUndoEnabled?.(false);
}

function obstacleDragEnd(_e) {
  if (!CONFIG.OBSTACLE_MODE) {
    // The pointer started in obstacle mode but the user toggled it off
    // mid-drag; commit nothing and reset.
    obstacleActivePointers = Math.max(0, obstacleActivePointers - 1);
    if (obstacleActivePointers === 0) currentStroke = null;
    return;
  }
  obstacleActivePointers = Math.max(0, obstacleActivePointers - 1);
  if (obstacleActivePointers > 0) return;       // multi-finger; wait for last
  if (!currentStroke) return;
  // Drop empty drags so accidental taps don't fill the stack.
  if (currentStroke.dabs.length > 0) {
    undoStack.push(currentStroke);
    if (undoStack.length > UNDO_STACK_MAX) {
      undoStack.splice(0, undoStack.length - UNDO_STACK_MAX);
    }
  }
  currentStroke = null;
  ui?.setUndoEnabled?.(undoStack.length > 0);
}

canvas.addEventListener('pointerdown',  obstacleDragStart);
canvas.addEventListener('pointerup',    obstacleDragEnd);
canvas.addEventListener('pointercancel',obstacleDragEnd);

/* ──────────────────────────────────────────────────────────────────────
   5.  UI
   ────────────────────────────────────────────────────────────────────── */

const ui = new UI(CONFIG, {
  onReset() {
    fluid.reset();
    fluid.clearObstacles();
    undoStack.length = 0;
    currentStroke    = null;
    ui?.setUndoEnabled?.(false);
    CONFIG.SOURCES.length  = 0;
    ui?.refreshSources?.();
  },
  onToggleParticles(on) {},
  onToggleBloom(on) {},
  onToggleColorful(on) {},
  onTogglePerfMode(perfMode) {
    rebuildSubsystems('perf-mode toggle');
  },
  onForceChange(v) {},
  onDissipationChange(v) {},
  onParticleDrop(x, y) {
    pendingDrop = { x, y };
  },
  onPauseChange(_paused) { /* render loop checks CONFIG.PAUSED */ },
  onSnapshot() {
    saveSnapshot();
  },
  async onToggleAudio(want) {
    if (want) {
      try { await audio.start(); return true; }
      catch (err) { throw err; }
    }
    audio.stop();
    return false;
  },
  async onToggleTilt(want) {
    if (want) {
      try { await tilt.start(); return true; }
      catch (err) { throw err; }
    }
    tilt.stop();
    return false;
  },
  onColorModeChange(_mode) { /* nothing to rebuild — splat callers re-read CONFIG */ },
  onClearObstacles() {
    fluid.clearObstacles();
    undoStack.length = 0;
    currentStroke    = null;
    ui?.setUndoEnabled?.(false);
  },
  onObstacleUndo() {
    // Disabled while a drag is in progress to prevent undoing a
    // half-recorded stroke.
    if (obstacleActivePointers > 0) return;
    if (undoStack.length === 0) return;
    undoStack.pop();
    replayObstacles();
    ui?.setUndoEnabled?.(undoStack.length > 0);
  },
  onClearPersisted() {
    clearPersistedStorage();
  },
  onShare() {
    return buildShareUrl();
  },
  onConfigMutated(_reason) {
    // Mutation paths that bypass the panel-level delegated listener
    // (source removed via SVG overlay, preset applied, etc.) need to
    // re-arm the debounced save explicitly.
    persistAutoSave?.requestSave();
  },
  onPresetChange(_id) { /* visual feedback already handled by UI; no rebuild needed */ },
});

// Re-fire 'input' events on any slider whose DOM value was restored at
// boot so the existing UI handlers re-derive engineering CONFIG values
// via the canonical curve mappings (avoids a stored-vs-derived skew).
for (const id of persistBoot.sliderIds) {
  document.getElementById(id)?.dispatchEvent(new Event('input', { bubbles: true }));
}

// Replay any persisted SOURCES into the UI overlay so handles render.
if (Array.isArray(CONFIG.SOURCES) && CONFIG.SOURCES.length) {
  ui.refreshSources?.();
}

// Install the auto-save watcher AFTER the UI is built so all wired
// handlers run on the bubble phase first; we then snapshot the
// post-mutation CONFIG. When the boot source is a URL hash, suppress
// the very first debounced save (~0.7 s) so visiting a shared link
// doesn't permanently overwrite the recipient's local snapshot.
const persistSuppressUntil = persistBoot.source === 'hash'
  ? performance.now() + 700
  : 0;
const persistAutoSave = installAutoSave({
  panelEl: document.getElementById('ui-panel'),
  gate:    () => performance.now() < persistSuppressUntil,
});

/** Most recent particle drop request from the UI; consumed in animate(). */
let pendingDrop = null;

/* ──────────────────────────────────────────────────────────────────────
   5b. Snapshot export — render one frame off-loop and save as PNG.
   --------------------------------------------------------------------
   The animation loop clears between frames, so we have to take the
   snapshot *immediately* after a normal frame finishes. We do that by
   setting a flag; the loop reads it after rendering and snapshots.
   ────────────────────────────────────────────────────────────────────── */

let snapshotPending = false;
function saveSnapshot() { snapshotPending = true; }

function doSnapshot() {
  // Force the GPU to finish drawing this frame before reading the canvas,
  // otherwise canvas.toBlob may execute on a cleared back-buffer (next
  // RAF) and produce a blank PNG. gl.finish() is heavy but acceptable on
  // a one-off user action like snapshot.
  gl.finish();
  // Use canvas.toBlob (async, lower memory than toDataURL).
  const v = ui.version || 'dev';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `fluid-${v}-${ts}.png`;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.flashSnapshot();
  }, 'image/png');
}

/* ──────────────────────────────────────────────────────────────────────
   5b. Audio reactivity (microphone-driven radial speaker waves)
   ────────────────────────────────────────────────────────────────────── */

const audio = new AudioReactivity(handleSplat, CONFIG);
const tilt  = new AccelerometerInput(handleSplat, CONFIG);

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
  const color = pickSplatColor(CONFIG.COLOR_MODE || 'rainbow', performance.now() * 0.001);
  fluid.splat(x, y, dx, dy, color);
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

/** Wallpaper-mode auto-splat accumulator (ms). Reset on each emission.
 *  Lives in the animate-loop scope so pause / hidden-tab gate it for
 *  free (animate() returns early in those states — no separate timer
 *  to leak; gotcha #11). */
let wallpaperAccumMs = 0;

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
        rebuildSubsystems('adaptive downscale');
        console.log(`[Fluid] Auto-reduced resolution to ${CONFIG.SIM_RESOLUTION}`);
      }
    }
  }

  // ── Audio reactivity ──────────────────────────────────────────────
  // Cheap no-op when the mic toggle is off; otherwise emits a radial
  // burst of splats from the canvas centre on detected bass beats.
  audio.tick(now);
  tilt.tick(now);

  // ── Tilt body force ───────────────────────────────────────────────
  // The tilt module exposes a UV/s² vector; apply it as a uniform force
  // over the whole velocity grid. No-op (zero cost) when tilt is off,
  // mid-calibration, or below the deadzone.
  if (tilt.enabled && tilt.calibrated) {
    fluid.applyBodyForce(tilt.bodyForceX, tilt.bodyForceY, dt);
  }

  // ── Permanent sources ─────────────────────────────────────────────
  // Each source emits a steady stream of dye + velocity. Per-frame
  // amplitude is scaled by dt so total injection per second is
  // resolution-independent.
  const sources = CONFIG.SOURCES;
  if (sources && sources.length) {
    // Modest steady stream: at 60 fps and rate=1 a default source adds
    // ~0.06 dye/s and ~9 velocity-units/s — readable as a continuous
    // jet without saturating the dissipation budget.
    const colorScale = dt * 3.5;
    const velScale   = dt * 15;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const r = s.rate ?? 1;
      const c = {
        r: s.color.r * colorScale * r,
        g: s.color.g * colorScale * r,
        b: s.color.b * colorScale * r,
      };
      fluid.splat(s.x, s.y, s.dx * velScale * r, s.dy * velScale * r, c);
    }
  }

  // ── Wallpaper-mode auto-splat ─────────────────────────────────────
  // Soft random splat at a configurable cadence so the canvas keeps
  // breathing in screensaver mode. Naturally gated by pause and
  // tab-hide because animate() already returned early in those states
  // (gotcha #11). Force is scaled down so the cadence reads as
  // ambient, not aggressive pokes.
  if (CONFIG.WALLPAPER_MODE) {
    wallpaperAccumMs += dt * 1000;
    const interval = CONFIG.WALLPAPER_AUTOSPLAT_INTERVAL_MS;
    if (interval > 0 && wallpaperAccumMs >= interval) {
      wallpaperAccumMs = 0;
      const x = Math.random();
      const y = Math.random();
      const angle = Math.random() * Math.PI * 2;
      const force = CONFIG.SPLAT_FORCE * (CONFIG.WALLPAPER_AUTOSPLAT_FORCE_SCALE || 0.4);
      const dx = Math.cos(angle) * force;
      const dy = Math.sin(angle) * force;
      const color = pickSplatColor(CONFIG.COLOR_MODE || 'rainbow', performance.now() * 0.001);
      fluid.splat(x, y, dx, dy, color);
    }
  } else if (wallpaperAccumMs !== 0) {
    wallpaperAccumMs = 0;
  }

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
    // Particle frag outputs premultiplied rgba (rgb already includes
    // alpha). (ONE, ONE_MINUS_SRC_ALPHA) layers softly over the dye
    // without the over-saturation pure additive produced.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    particles.render(canvas.width, canvas.height, fluid.velocityTexture);
    gl.disable(gl.BLEND);
  }

  // Take snapshot right after rendering this frame, before the next
  // requestAnimationFrame would otherwise clear the canvas.
  if (snapshotPending) {
    snapshotPending = false;
    doSnapshot();
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
