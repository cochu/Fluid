/**
 * Recorder.js — animated WebM export of the live canvas.
 *
 * Wraps `canvas.captureStream()` + `MediaRecorder` into a one-call
 * API. The recording proceeds in the background while the simulation
 * keeps running at full speed; on stop, a Blob is assembled and
 * offered as a download via a hidden <a download> anchor (the same
 * trick `saveSnapshot()` uses for PNG).
 *
 * Codec selection is "best supported wins" against this priority
 * list — VP9 is the smallest at the same quality, VP8 is the most
 * widely playable, plain `video/webm` is the legacy fallback that
 * lets older Safari at least produce a file:
 *
 *     video/webm;codecs=vp9
 *     video/webm;codecs=vp8
 *     video/webm
 *
 * If MediaRecorder isn't available or none of the MIME types is
 * supported, `isSupported()` returns false and the UI hides the
 * button (see UI.js). This keeps the failure mode quiet on browsers
 * that simply can't record (some iOS Safari versions).
 *
 * Sizing: the WebM is sized at `canvas.width × canvas.height` —
 * the *backing-store* resolution after devicePixelRatio scaling, so
 * recordings of a Retina display are at native pixels.
 */

const MIME_PRIORITY = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** @returns {boolean} whether MediaRecorder + canvas.captureStream + at
 *  least one of the WebM MIME types is available in this browser. */
export function isSupported() {
  if (typeof MediaRecorder === 'undefined') return false;
  if (typeof HTMLCanvasElement === 'undefined' ||
      typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return MIME_PRIORITY.some(m => {
    try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; }
  });
}

function pickMime() {
  for (const m of MIME_PRIORITY) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) { /* noop */ }
  }
  return ''; // empty string lets the browser choose; download still works
}

export class Recorder {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object}  opts
   * @param {number}  [opts.fps=60]      capture frame rate
   * @param {number}  [opts.bitrate=8e6] target video bitrate (bits/s)
   */
  constructor(canvas, { fps = 60, bitrate = 8_000_000 } = {}) {
    this._canvas  = canvas;
    this._fps     = fps;
    this._bitrate = bitrate;
    this._recorder = null;
    this._chunks   = [];
    this._stream   = null;
    this._startedAt = 0;
  }

  get isRecording() {
    return !!this._recorder && this._recorder.state === 'recording';
  }

  /** Seconds elapsed since recording started, 0 if idle. */
  get elapsedSec() {
    if (!this.isRecording) return 0;
    return (performance.now() - this._startedAt) / 1000;
  }

  /**
   * Begin recording. Throws if MediaRecorder fails to instantiate
   * (the UI catches this and surfaces a tooltip).
   */
  start() {
    if (this.isRecording) return;
    if (!isSupported()) throw new Error('Recording not supported in this browser');

    this._stream = this._canvas.captureStream(this._fps);
    const mimeType = pickMime();
    const opts = { videoBitsPerSecond: this._bitrate };
    if (mimeType) opts.mimeType = mimeType;
    this._recorder = new MediaRecorder(this._stream, opts);
    this._chunks = [];
    this._mime   = mimeType || 'video/webm';
    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    this._recorder.onstop = () => {
      // Assemble + offer as a download. We tear the stream down here
      // (rather than on `stop()`) so the final dataavailable event
      // has a chance to land before the blob is sealed.
      const blob = new Blob(this._chunks, { type: this._mime });
      this._chunks = [];
      const stamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const a = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `fluid-${stamp}.webm`;
      document.body.appendChild(a);
      a.click();
      // Revoke after the click has had a chance to start the download.
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      // Drop the camera stream tracks so the browser stops capturing.
      if (this._stream) {
        for (const t of this._stream.getTracks()) t.stop();
        this._stream = null;
      }
      this._recorder = null;
    };
    // 1-second timeslice → if the user navigates away or the tab
    // crashes, we still get most of the recording rather than zero.
    this._recorder.start(1000);
    this._startedAt = performance.now();
  }

  /** Stop recording. Triggers the download via the recorder's
   *  `onstop` handler. Idempotent. */
  stop() {
    if (!this._recorder) return;
    if (this._recorder.state !== 'inactive') this._recorder.stop();
  }
}
