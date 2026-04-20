/**
 * MidiInput.js – Web MIDI → splat + live CONFIG mutation.
 *
 * Sister module to AudioReactivity. MIDI is event-driven, not stream-
 * polled, so the lifecycle is simpler — but we keep the same public
 * shape (`start()`, `stop()`, `isActive`, `tick(now)`) so `main.js` can
 * treat audio and MIDI as interchangeable input sources.
 *
 * Behaviour
 * ---------
 *   Note On  (0x9N, vel > 0): emit one splat. The note number drives a
 *     chromatic-spiral position (pitch class → angle, octave → radius)
 *     so a returning note always lands at the same spot — useful for
 *     muscle-memory in a live jam (Anouk's call). Velocity scales the
 *     force; direction is randomised per event.
 *   Note On  (vel == 0): treated as Note Off, ignored.
 *   Note Off (0x8N):           ignored.
 *   Control Change (0xBN):     looked up in CONFIG.MIDI_CC_MAP, the
 *     value is remapped per-target and assigned live to CONFIG. Default
 *     map ships modwheel → SPLAT_FORCE and CC74 → CURL.
 *
 * Failure modes are explicit:
 *   - `requestMIDIAccess` missing (Safari ≤ 17.4)  → throws "Web MIDI not supported"
 *   - Permission denied                            → throws "MIDI permission denied"
 *   - No inputs attached                           → no error; statechange
 *     hot-attaches devices when the user plugs one in.
 *
 * Hot-plug guard: ChromeOS occasionally double-fires the 'connected'
 * statechange for the same port, which without a guard would bind two
 * `onmidimessage` listeners and emit each splat twice. We track bound
 * port ids in a Set.
 *
 * Permission gating: requestMIDIAccess must be called from inside a
 * synchronous user-gesture chain. The UI button click handler awaits
 * us directly with no intermediate awaits — gotcha #5.
 */

import { pickSplatColor } from './Palettes.js';

export class MidiInput {
  /**
   * @param {(x:number,y:number,dx:number,dy:number,c:{r:number,g:number,b:number})=>void} splatFn
   *        Same signature as `FluidSimulation.splat`.
   * @param {import('../config.js').CONFIG} config Shared live config object.
   */
  constructor(splatFn, config) {
    this._splat   = splatFn;
    this._config  = config;
    this._access  = null;            // MIDIAccess
    /** Port ids whose `midimessage` we have already bound, so the
     *  statechange listener doesn't double-bind on duplicate
     *  'connected' events. */
    this._boundPorts = new Set();
    /** Bound versions of the message / state handlers so we can
     *  remove them in stop(). */
    this._onMessage = (e) => this._handleMessage(e);
    this._onState   = (e) => this._handleStateChange(e);
  }

  /** Whether MIDI capture is currently active. */
  get isActive() {
    return this._access !== null;
  }

  /**
   * Request MIDI access and bind every input port. Safe to call multiple
   * times — subsequent calls are no-ops while already active.
   *
   * @returns {Promise<void>} resolves once access is granted and bound.
   */
  async start() {
    if (this.isActive) return;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      throw new Error('Web MIDI not supported on this browser');
    }
    let access;
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      if (err?.name === 'SecurityError' || err?.name === 'NotAllowedError') {
        throw new Error('MIDI permission denied');
      }
      throw err;
    }
    this._access = access;
    // Bind every currently-connected input.
    for (const input of access.inputs.values()) {
      this._bindPort(input);
    }
    // And listen for hot-plugged devices.
    access.addEventListener('statechange', this._onState);
  }

  /** Drop all MIDI listeners and the MIDIAccess. */
  stop() {
    if (!this._access) return;
    try {
      this._access.removeEventListener('statechange', this._onState);
    } catch (_) { /* noop */ }
    for (const input of this._access.inputs.values()) {
      try { input.removeEventListener('midimessage', this._onMessage); }
      catch (_) { /* noop */ }
    }
    this._boundPorts.clear();
    this._access = null;
  }

  /**
   * Tick. MIDI is event-driven so this is a no-op, but exposing it keeps
   * `main.js`'s loop uniform with audio / tilt.
   */
  tick(_nowMs) { /* intentionally empty */ }

  /* ──────────────────────────────────────────────────────────────────
     Internals
     ────────────────────────────────────────────────────────────────── */

  _bindPort(port) {
    if (!port || port.type !== 'input' || this._boundPorts.has(port.id)) return;
    port.addEventListener('midimessage', this._onMessage);
    this._boundPorts.add(port.id);
  }

  _handleStateChange(e) {
    const port = e?.port;
    if (!port || port.type !== 'input') return;
    if (port.state === 'connected') {
      this._bindPort(port);
    } else if (port.state === 'disconnected') {
      this._boundPorts.delete(port.id);
    }
  }

  _handleMessage(e) {
    const cfg = this._config;
    if (!cfg.MIDI_REACTIVE) return;
    const data = e?.data;
    if (!data || data.length < 2) return;

    const status   = data[0];
    const cmd      = status & 0xF0;
    const channel  = status & 0x0F;
    if (cfg.MIDI_CHANNEL_FILTER >= 0 && channel !== cfg.MIDI_CHANNEL_FILTER) return;

    if (cmd === 0x90 && data[2] > 0) {
      // Note On with non-zero velocity.
      this._handleNoteOn(data[1], data[2], performance.now());
    } else if (cmd === 0xB0) {
      // Control Change.
      this._handleControlChange(data[1], data[2]);
    }
    // 0x80 (Note Off), 0x90 vel=0, 0xA0 (poly aftertouch), 0xC0 (program
    // change), 0xD0 (channel aftertouch), 0xE0 (pitch bend) and system
    // messages 0xF0+ are intentionally ignored in v1.
  }

  _handleNoteOn(note, velocity, nowMs) {
    const cfg = this._config;
    // Chromatic spiral: pitch class drives angle, octave drives radius.
    // C0 lives near the rim; C8 near the centre. The normalisation keeps
    // the burst comfortably inside the canvas (0.10..0.45 of the
    // shorter side).
    const pitchClass = note % 12;
    const octave     = Math.max(0, Math.min(8, Math.floor(note / 12)));
    const angle      = (pitchClass / 12) * Math.PI * 2;
    const radius     = 0.10 + (1 - octave / 8) * 0.35;
    const x = 0.5 + Math.cos(angle) * radius;
    const y = 0.5 + Math.sin(angle) * radius;

    // Velocity → magnitude. Squared so the dynamic range feels musical.
    const v   = velocity / 127;
    const mag = cfg.SPLAT_FORCE * v * v * (cfg.MIDI_NOTE_GAIN ?? 1);

    // Random direction per event — the fluid will shear it anyway and
    // forcing "pitch up = up" would bias the canvas asymmetrically.
    const dirAngle = Math.random() * Math.PI * 2;
    const dx = Math.cos(dirAngle) * mag;
    const dy = Math.sin(dirAngle) * mag;

    // Colour through the canonical palette helper (golden rule #4); a
    // small note-derived offset on `t` makes consecutive pitches drift
    // through the active palette, but in mono mode it stays mono.
    // 1/1280 s per semitone ≈ 9 ms per octave — subtle enough to keep
    // the same note recognisable, large enough to colour-shift chords.
    const t     = (nowMs / 1000) + (note / 1280);
    const color = pickSplatColor(cfg.COLOR_MODE || 'rainbow', t);

    this._splat(x, y, dx, dy, color);
  }

  _handleControlChange(cc, value) {
    const cfg = this._config;
    const map = cfg.MIDI_CC_MAP;
    if (!map) return;
    const target = map[cc];
    if (!target) return;
    const u = value / 127;
    switch (target) {
      case 'SPLAT_FORCE':
        // Quadratic, matching the rough feel of the UI Force slider
        // (the slider ships its own curve in UI.js but we don't import
        // it here to keep the input layer slim).
        cfg.SPLAT_FORCE = 5 + (4500 - 5) * u * u;
        break;
      case 'CURL':
        // Linear 0..40 covers the useful vorticity-confinement range.
        cfg.CURL = 40 * u;
        break;
      case 'DENSITY_DISSIPATION': {
        // Smoothstep 0.92..0.999 mirrors the Persistence slider.
        const s = u * u * (3 - 2 * u);
        cfg.DENSITY_DISSIPATION  = 0.92 + (0.999 - 0.92) * s;
        cfg.VELOCITY_DISSIPATION = cfg.DENSITY_DISSIPATION;
        break;
      }
      case 'VISCOSITY':
        cfg.VISCOSITY = 0.05 * u * u * u;
        break;
      default:
        // Unknown target name — silently ignore so devtools experiments
        // with `CONFIG.MIDI_CC_MAP[42] = 'NEW_KEY'` don't crash.
        break;
    }
  }
}
