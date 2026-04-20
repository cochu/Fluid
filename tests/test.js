/**
 * test.js — zero-dependency in-browser test runner for Fluid.
 *
 * Goals:
 *  • Catch regressions in the modules that previous agents most
 *    often broke (golden rule #1 trame, persistence sanitisers,
 *    palette colour pre-multiplication, FBO lifecycle).
 *  • Run with no build step, no test framework, no Node tooling.
 *    Just open tests/test.html in any modern browser.
 *
 * Each test is an async function that throws on failure (or returns
 * a string for an expected `skip`). The runner collects results
 * into the table in test.html.
 *
 * Note: this is a *smoke* harness, not pixel-perfect golden imaging.
 * GPU floating-point varies between drivers; we assert structural
 * invariants (no NaN, energy bounded, dye non-zero where expected)
 * rather than exact pixel values.
 */

import { CONFIG }              from '../src/config.js';
import { pickSplatColor, paletteAccent, nextMode } from '../src/input/Palettes.js';
import { applyToConfig, snapshot, PERSISTED_CONFIG_KEYS, SCHEMA_VERSION } from '../src/persistence.js';
import { getWebGL2Context }    from '../src/webgl/GLUtils.js';
import { FluidSimulation }     from '../src/fluid/FluidSimulation.js';

const tests = [];
function test(suite, name, fn) { tests.push({ suite, name, fn }); }

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: CONFIG defaults                                                */
/* ────────────────────────────────────────────────────────────────────── */

test('config', 'CONFIG exposes expected runtime keys', () => {
  const required = [
    'SIM_RESOLUTION', 'DYE_RESOLUTION', 'DENSITY_DISSIPATION',
    'VELOCITY_DISSIPATION', 'PRESSURE_ITERATIONS', 'CURL', 'BLOOM',
    'PARTICLES', 'SPLAT_FORCE', 'COLOR_MODE', 'DYE_BRIGHTNESS',
    'HIGH_QUALITY_ADVECTION', 'DYE_ADVECTION', 'NO_SLIP_BOUNDARY',
    'SHADING', 'SOURCES',
  ];
  for (const k of required) {
    if (!(k in CONFIG)) throw new Error(`missing CONFIG key: ${k}`);
  }
});

test('config', 'DYE_ADVECTION default is one of the known schemes', () => {
  if (!['standard', 'maccormack', 'bfecc'].includes(CONFIG.DYE_ADVECTION)) {
    throw new Error(`unexpected DYE_ADVECTION default: ${CONFIG.DYE_ADVECTION}`);
  }
});

test('config', 'SOURCES default is an array', () => {
  if (!Array.isArray(CONFIG.SOURCES)) throw new Error('SOURCES must be an array');
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: Palettes                                                       */
/* ────────────────────────────────────────────────────────────────────── */

test('palettes', 'pickSplatColor returns finite RGB pre-multiplied by DYE_BRIGHTNESS', () => {
  for (const mode of ['rainbow', 'cycle', 'ocean', 'sunset', 'magma', 'forest', 'mono']) {
    const c = pickSplatColor(mode, 1.234);
    for (const ch of ['r', 'g', 'b']) {
      if (!Number.isFinite(c[ch])) throw new Error(`${mode}.${ch} not finite: ${c[ch]}`);
      if (c[ch] < 0) throw new Error(`${mode}.${ch} negative: ${c[ch]}`);
      // DYE_BRIGHTNESS is the upper bound; slight HSV jitter in pickSplatColor
      // can push slightly above, so allow a ~6% margin.
      if (c[ch] > CONFIG.DYE_BRIGHTNESS * 1.07) {
        throw new Error(`${mode}.${ch}=${c[ch]} exceeds DYE_BRIGHTNESS*1.07`);
      }
    }
  }
});

test('palettes', 'paletteAccent returns a finite unit-ish colour', () => {
  for (const mode of ['rainbow', 'cycle', 'ocean', 'sunset', 'magma', 'forest', 'mono']) {
    const c = paletteAccent(mode, 1);
    if (!Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) {
      throw new Error(`${mode} accent NaN`);
    }
  }
});

test('palettes', 'nextMode cycles the seven palette modes in order', () => {
  const modes = ['rainbow', 'cycle', 'ocean', 'sunset', 'magma', 'forest', 'mono'];
  let m = modes[0];
  const visited = [m];
  for (let i = 0; i < modes.length; i++) { m = nextMode(m); visited.push(m); }
  // After modes.length steps we should have come full circle: 8 visits,
  // first and last identical, middle six covering the remaining modes.
  if (visited.length !== modes.length + 1) throw new Error('wrong visit count');
  if (visited[visited.length - 1] !== visited[0]) {
    throw new Error(`cycle did not close: started ${visited[0]}, ended ${visited[visited.length - 1]}`);
  }
  // The set of distinct entries must equal the set of declared modes.
  const seen = new Set(visited);
  for (const expected of modes) {
    if (!seen.has(expected)) throw new Error(`mode missing from cycle: ${expected}`);
  }
  if (seen.size !== modes.length) throw new Error(`unexpected extra modes: ${[...seen].filter(x => !modes.includes(x))}`);
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: Persistence                                                    */
/* ────────────────────────────────────────────────────────────────────── */

test('persistence', 'roundtrip preserves persisted CONFIG keys', () => {
  const before = { ...CONFIG };
  CONFIG.DYE_ADVECTION    = 'bfecc';
  CONFIG.NO_SLIP_BOUNDARY = true;
  CONFIG.SHADING          = true;
  const snap = snapshot();
  // Mutate, then re-apply.
  CONFIG.DYE_ADVECTION    = 'standard';
  CONFIG.NO_SLIP_BOUNDARY = false;
  CONFIG.SHADING          = false;
  applyToConfig(snap);
  if (CONFIG.DYE_ADVECTION !== 'bfecc')      throw new Error('DYE_ADVECTION not restored');
  if (CONFIG.NO_SLIP_BOUNDARY !== true)      throw new Error('NO_SLIP_BOUNDARY not restored');
  if (CONFIG.SHADING !== true)               throw new Error('SHADING not restored');
  // Restore.
  Object.assign(CONFIG, before);
});

test('persistence', 'rejects tampered DYE_ADVECTION values', () => {
  const before = CONFIG.DYE_ADVECTION;
  applyToConfig({ v: SCHEMA_VERSION, cfg: { DYE_ADVECTION: 'evil' }, sliders: {} });
  if (CONFIG.DYE_ADVECTION !== before) {
    throw new Error(`enum guard let through: ${CONFIG.DYE_ADVECTION}`);
  }
});

test('persistence', 'PERSISTED_CONFIG_KEYS includes recent additions', () => {
  for (const k of ['DYE_ADVECTION', 'NO_SLIP_BOUNDARY', 'SHADING']) {
    if (!PERSISTED_CONFIG_KEYS.includes(k)) {
      throw new Error(`PERSISTED_CONFIG_KEYS missing ${k}`);
    }
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: Source/sink force gauge                                        */
/* ────────────────────────────────────────────────────────────────────── */

import {
  forceGradient, dragLengthToT, sinkRateToT, tToSinkRate,
  sourceMagnitudeToT, SINK_RATE_MIN, SINK_RATE_MAX, DRAG_T_FULL_FRACTION,
  UI,
} from '../src/ui/UI.js';

test('sources', 'forceGradient hits expected stops', () => {
  const cool = forceGradient(0);
  const mid  = forceGradient(0.5);
  const warm = forceGradient(1);
  if (cool !== 'rgb(80, 140, 255)') throw new Error(`cool stop wrong: ${cool}`);
  if (mid  !== 'rgb(80, 230, 180)') throw new Error(`mid stop wrong: ${mid}`);
  if (warm !== 'rgb(255, 110, 80)') throw new Error(`warm stop wrong: ${warm}`);
  // Out-of-range inputs must clamp, not blow up.
  if (forceGradient(-1) !== cool) throw new Error('negative t should clamp to 0');
  if (forceGradient( 9) !== warm) throw new Error('overflow t should clamp to 1');
});

test('sources', 'dragLengthToT saturates at DRAG_T_FULL_FRACTION of min(W,H)', () => {
  const w = 1600, h = 800; // landscape, min = 800
  const knee = h * DRAG_T_FULL_FRACTION;
  if (Math.abs(dragLengthToT(0, w, h)) > 1e-9) throw new Error('zero drag should map to 0');
  const half = dragLengthToT(knee * 0.5, w, h);
  if (Math.abs(half - 0.5) > 1e-6) throw new Error(`half drag should map to 0.5, got ${half}`);
  if (dragLengthToT(knee, w, h) !== 1)        throw new Error('knee drag should map to exactly 1');
  if (dragLengthToT(knee * 4, w, h) !== 1)    throw new Error('over-knee drag should saturate at 1');
});

test('sources', 'sinkRateToT and tToSinkRate are inverses across the range', () => {
  for (let i = 0; i <= 10; i++) {
    const t  = i / 10;
    const r  = tToSinkRate(t);
    const t2 = sinkRateToT(r);
    if (Math.abs(t - t2) > 1e-9) throw new Error(`roundtrip drift at t=${t}: got ${t2}`);
  }
  if (tToSinkRate(0)  !== SINK_RATE_MIN) throw new Error('t=0 should give SINK_RATE_MIN');
  if (tToSinkRate(1)  !== SINK_RATE_MAX) throw new Error('t=1 should give SINK_RATE_MAX');
  // Legacy rate=1 should land in cool half (between MIN and mid-range).
  const tLegacy = sinkRateToT(1);
  if (!(tLegacy > 0 && tLegacy < 0.5)) throw new Error(`legacy rate=1 should map to cool half, got ${tLegacy}`);
});

test('sources', 'sourceMagnitudeToT clamps at zero and saturates at the full-scale anchor', () => {
  if (sourceMagnitudeToT(-3) !== 0) throw new Error('negative magnitude must clamp to 0');
  if (sourceMagnitudeToT(0)  !== 0) throw new Error('zero magnitude must yield 0');
  if (sourceMagnitudeToT(99) !== 1) throw new Error('huge magnitude must saturate at 1');
});

test('sources', '_renderSources arrow direction is in screen space (aspect-ratio-correct)', () => {
  // Build a minimal DOM scaffold that UI._renderSources expects.
  const canvas = document.createElement('div');
  canvas.id = 'canvas';
  // Deliberately non-square so a UV-space normalisation would tilt the arrow.
  Object.defineProperty(canvas, 'clientWidth',  { value: 1600 });
  Object.defineProperty(canvas, 'clientHeight', { value: 400  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'sources-overlay';
  document.body.appendChild(canvas);
  document.body.appendChild(svg);

  // Build a minimal UI without running its full constructor (which
  // expects every button/slider in index.html). We only need
  // _renderSources, which uses _config and _svgOverlay.
  const ui = Object.create(UI.prototype);
  ui._config = {
    SOURCES: [
      // Source at centre, dragged exactly 45° down-right in *screen*
      // pixels. With w==1600, h==400 a UV displacement (0.1, -0.1)
      // covers (160, 40) px ≈ +14° from horizontal — clearly NOT 45°,
      // which proves we must not normalise in UV.
      // To get a screen-space 45° down-right vector we set
      // dx_uv = 0.1, dy_uv = -0.4 → screen = (160, 160).
      { x: 0.5, y: 0.5, dx: 0.1, dy: -0.4, color: { r: 1, g: 1, b: 1 }, rate: 1 },
    ],
  };
  ui._previewState = null;
  ui._svgOverlay = svg;
  ui._cb = {};
  ui._renderSources();

  const line = svg.querySelector('g.src line');
  if (!line) throw new Error('no arrow line rendered');
  const x1 = parseFloat(line.getAttribute('x1'));
  const y1 = parseFloat(line.getAttribute('y1'));
  const x2 = parseFloat(line.getAttribute('x2'));
  const y2 = parseFloat(line.getAttribute('y2'));
  // Arrow centre starts at (800, 200). The drawn vector must point
  // 45° down-right (dx_screen > 0, dy_screen > 0, |dx| ≈ |dy|).
  const vx = x2 - x1;
  const vy = y2 - y1;
  if (!(vx > 0 && vy > 0)) throw new Error(`arrow should point down-right, got (${vx}, ${vy})`);
  const angle = Math.atan2(vy, vx) * 180 / Math.PI;
  // Angle should be within a couple of degrees of 45°. The OLD UV-space
  // normaliser would produce ~76°, which would fail this test.
  if (Math.abs(angle - 45) > 3) {
    throw new Error(`arrow angle should be ~45°, got ${angle.toFixed(1)}°`);
  }

  // Cleanup so subsequent tests don't see the stale DOM nodes.
  canvas.remove(); svg.remove();
});

test('sources', '_previewSVG renders sink ring without a directional arrow', () => {
  const ui = Object.create(UI.prototype);
  const html = ui._previewSVG(
    { kind: 'sink', startUV: { x: 0.5, y: 0.5 }, currentUV: { x: 0.7, y: 0.3 } },
    1000, 1000,
  );
  if (!/circle /.test(html)) throw new Error('sink preview should contain a circle');
  if (/marker-end/.test(html))   throw new Error('sink preview must not draw a directional arrow');
  if (!/text /.test(html))       throw new Error('sink preview should contain the numeric badge');
});

test('sources', '_previewSVG renders source preview with arrow + badge', () => {
  const ui = Object.create(UI.prototype);
  const html = ui._previewSVG(
    { kind: 'source', startUV: { x: 0.5, y: 0.5 }, currentUV: { x: 0.6, y: 0.4 } },
    1000, 1000,
  );
  if (!/marker-end/.test(html)) throw new Error('source preview should draw an arrow');
  if (!/text /.test(html))      throw new Error('source preview should contain the numeric badge');
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: Simulation smoke (real WebGL2)                                 */
/* ────────────────────────────────────────────────────────────────────── */

function makeSimContext() {
  const canvas = document.getElementById('sim-canvas');
  const ctx = getWebGL2Context(canvas);
  if (!ctx) return { skip: 'WebGL2 unavailable in this browser' };
  return { canvas, ...ctx };
}

test('sim', 'FluidSimulation instantiates and runs 30 steps without throwing', async () => {
  const c = makeSimContext();
  if (c.skip) return c.skip;
  const cfg = { ...CONFIG, SIM_RESOLUTION: 64, DYE_RESOLUTION: 128 };
  const sim = new FluidSimulation(c.gl, c.ext, cfg);
  // Inject one centre splat and step several times.
  sim.splat(0.5, 0.5, 0.0, 0.5, { r: 0.6, g: 0.4, b: 0.2 });
  for (let i = 0; i < 30; i++) sim.step(1 / 60);
  sim.render(null, c.canvas.width, c.canvas.height);
  sim.destroy();
});

test('sim', 'after splat + steps, canvas has non-zero pixels', async () => {
  const c = makeSimContext();
  if (c.skip) return c.skip;
  const cfg = { ...CONFIG, SIM_RESOLUTION: 64, DYE_RESOLUTION: 128, BLOOM: false };
  const sim = new FluidSimulation(c.gl, c.ext, cfg);
  sim.splat(0.5, 0.5, 0.0, 0.4, { r: 0.8, g: 0.3, b: 0.1 });
  for (let i = 0; i < 20; i++) sim.step(1 / 60);
  sim.render(null, c.canvas.width, c.canvas.height);
  const w = c.canvas.width, h = c.canvas.height;
  const px = new Uint8Array(w * h * 4);
  c.gl.readPixels(0, 0, w, h, c.gl.RGBA, c.gl.UNSIGNED_BYTE, px);
  let nonZero = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] + px[i + 1] + px[i + 2] > 8) nonZero++;
  }
  sim.destroy();
  if (nonZero < 50) throw new Error(`only ${nonZero} non-zero pixels after splat`);
});

test('sim', 'idle simulation stays bounded (no NaN, no trame blow-up)', async () => {
  // Golden rule #1 canary: with no splats, velocity must not develop
  // a divergent grid pattern. We assert that after 60 idle steps the
  // canvas is uniformly dark — any high-frequency self-excited pattern
  // would show up as bright pixels.
  const c = makeSimContext();
  if (c.skip) return c.skip;
  const cfg = { ...CONFIG, SIM_RESOLUTION: 64, DYE_RESOLUTION: 128, BLOOM: false };
  const sim = new FluidSimulation(c.gl, c.ext, cfg);
  sim.reset();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  sim.render(null, c.canvas.width, c.canvas.height);
  const w = c.canvas.width, h = c.canvas.height;
  const px = new Uint8Array(w * h * 4);
  c.gl.readPixels(0, 0, w, h, c.gl.RGBA, c.gl.UNSIGNED_BYTE, px);
  let bright = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] + px[i + 1] + px[i + 2] > 30) bright++;
  }
  sim.destroy();
  if (bright > 20) throw new Error(`${bright} bright pixels in idle frame — possible trame regression`);
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Suite: Boot canary                                                    */
/* ────────────────────────────────────────────────────────────────────── */

/*
 * Why this exists: PR #8 (`fix(boot): hoist recorder above UI to break the
 * TDZ that froze main.js`) shipped because nothing in the harness ever
 * *evaluated* `src/main.js`. A `const` referenced inside the eager UI
 * options literal before its own declaration threw a `ReferenceError` at
 * module top-level — the canvas froze, the buttons painted dead. The
 * config / palette / sim suites all import their leaves directly and
 * never touch the bootstrap module, so the failure was invisible to them.
 *
 * This test loads the real `index.html` inside an isolated iframe (via
 * `srcdoc` + `<base href>`), captures any uncaught script error or
 * unhandled rejection that fires during boot, and asserts the list is
 * empty. It catches TDZ regressions, missing imports, malformed module
 * URLs, and any other top-level runtime explosion in a single check.
 *
 * Notes:
 *  - We use srcdoc so the iframe's location is `about:srcdoc`, which
 *    sidesteps the service-worker registration guard in index.html
 *    (it only registers under https/localhost/127.0.0.1). No SW state
 *    leaks into the test harness origin.
 *  - We only capture `error` and `unhandledrejection`, not console.error,
 *    because main.js legitimately logs warnings on unsupported features
 *    (recorder, MIDI permissions, etc.) and we don't want those to
 *    flap the test.
 */

test('boot', 'index.html boots without uncaught script errors', async () => {
  const baseHref  = new URL('..', document.baseURI).href;
  const indexHtml = await fetch('../index.html').then(r => r.text());
  const guard = `
    <base href="${baseHref}">
    <script>
      window.__bootErrors = [];
      window.addEventListener('error', function (e) {
        if (e.error || e.message) {
          window.__bootErrors.push(
            'error: ' + (e.message || String(e.error)) +
            (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')
          );
        }
      });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        window.__bootErrors.push('unhandled rejection: ' + ((r && r.message) || String(r)));
      });
    </script>`;
  // Inject the base + guard as the very first children of <head> so they
  // run before any module script is fetched or evaluated.
  const patched = indexHtml.replace(/<head[^>]*>/i, m => m + guard);

  const iframe = document.createElement('iframe');
  iframe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:320px;height:240px;border:0;visibility:hidden;';
  iframe.srcdoc = patched;
  document.body.appendChild(iframe);

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('iframe load timeout (4s)')), 4000);
      iframe.addEventListener('load', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    // Module graphs continue to evaluate after the iframe `load` event;
    // give ~1.5 s of wall clock so a late-throwing top-level statement
    // still surfaces before we read the error array.
    await new Promise(r => setTimeout(r, 1500));
    const errs = iframe.contentWindow.__bootErrors || [];
    if (errs.length > 0) {
      throw new Error(
        'boot produced ' + errs.length + ' error(s):\n  - ' + errs.join('\n  - ')
      );
    }
  } finally {
    iframe.remove();
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/*  Runner                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

const tbody = document.getElementById('results');
const summary = document.getElementById('summary');

let passed = 0, failed = 0, skipped = 0;
for (const t of tests) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="suite">${t.suite}</td><td class="name">${t.name}</td><td class="status">…</td><td class="detail"></td>`;
  tbody.appendChild(tr);
  try {
    const result = await t.fn();
    if (typeof result === 'string') {
      skipped++;
      tr.querySelector('.status').textContent = 'SKIP';
      tr.querySelector('.status').classList.add('skip');
      tr.querySelector('.detail').textContent = result;
    } else {
      passed++;
      tr.querySelector('.status').textContent = 'PASS';
      tr.querySelector('.status').classList.add('pass');
    }
  } catch (err) {
    failed++;
    tr.querySelector('.status').textContent = 'FAIL';
    tr.querySelector('.status').classList.add('fail');
    tr.querySelector('.detail').textContent = err && err.message ? err.message : String(err);
    console.error(`[test] ${t.suite} · ${t.name}`, err);
  }
  // Yield to the event loop so the row paints before the next test runs.
  await new Promise(r => setTimeout(r, 0));
}
summary.textContent = `${passed} passed · ${failed} failed · ${skipped} skipped (of ${tests.length})`;
summary.classList.add(failed === 0 ? 'pass' : 'fail');
