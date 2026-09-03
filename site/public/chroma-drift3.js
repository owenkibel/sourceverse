/**
 * Chroma Drift — High-Performance Stereo Spectrogram Player (Astro Optimized)
 * Finds every <audio> tag. Spectrogram starts off; toggle vertical / horizontal.
 * Same-origin audio required (Web Audio cannot analyse cross-origin files).
 *
 * Usage (Astro layout):
 *   <script src="/chroma-drift.js" type="module"></script>
 */
(() => {
  if (typeof window === "undefined") return;
  if (window.__chromaDriftVersion === 4) return;
  if (window.__chromaDriftVersion) {
    document.querySelectorAll("[data-chroma-player]").forEach((el) => el.remove());
    document.querySelectorAll(".cd-audio-host").forEach((el) =>
      el.classList.remove("cd-audio-host"),
    );
  }
  window.__chromaDriftVersion = 4;
  window.__chromaDriftBooted = true;

  const NOTE_MIN = 36;
  const NOTE_MAX = 96;
  const BINS_PER_SEMI = 8;
  const N_BINS = (NOTE_MAX - NOTE_MIN) * BINS_PER_SEMI + 1;
  const FFT_SIZE = 4096;
  const HOP = 512;
  const PLAYHEAD = 0.22;
  const GAP_PX = 4;
  const WINDOW_MIN = 2;
  const WINDOW_MAX = 16;
  const WINDOW_DEFAULT = 5;

  const LAYOUT_OFF = 0;
  const LAYOUT_VERT = 1;
  const LAYOUT_HORIZ = 2;

  // Richer, perceptually balanced 12-tone pitch-class chromatic palette
  const CHROMA = [
    [255, 48, 88],   // C  (Vivid Crimson)
    [255, 105, 24],  // C# (Bright Coral/Orange)
    [255, 200, 28],  // D  (Amber Gold)
    [178, 245, 24],  // D# (Lime Chartreuse)
    [36, 240, 116],  // E  (Emerald)
    [0, 235, 198],   // F  (Turquoise)
    [0, 208, 255],   // F# (Electric Sky)
    [54, 144, 255],  // G  (Cobalt Blue)
    [128, 92, 255],  // G# (Violet)
    [202, 74, 255],  // A  (Electric Purple)
    [255, 50, 218],  // A# (Fuchsia Magenta)
    [255, 68, 144],  // B  (Deep Rose)
  ];
  const COL_L = [61, 255, 176]; // Mint Left
  const COL_R = [61, 176, 255]; // Azure Right

  const CSS = `
.cd-player{margin:1.75rem 0 0;background:#08080a;border-radius:16px 16px 0 0;box-shadow:0 0 0 1px rgba(255,255,255,.08);overflow:hidden;color:#ecece8}
.cd-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px 14px;padding:8px 12px;flex-wrap:wrap;font:500 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:rgba(236,236,232,.48)}
.cd-brand{letter-spacing:.12em}
.cd-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.cd-seg{display:inline-flex;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);overflow:hidden}
.cd-seg button,.cd-pan{appearance:none;border:0;background:transparent;color:rgba(236,236,232,.5);font:500 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;padding:0 10px;height:32px;cursor:pointer}
.cd-seg button[aria-pressed="true"],.cd-pan[aria-pressed="true"]{background:rgba(236,236,232,.12);color:#ecece8}
.cd-pan{border-radius:8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.cd-speed{display:none;align-items:center;gap:8px;color:rgba(236,236,232,.5)}
.cd-player.cd-on .cd-speed{display:inline-flex}
.cd-player:not(.cd-on) .cd-pan{display:none}
.cd-speed input[type=range]{width:96px;accent-color:#d8d4cc;height:32px}
.cd-speed-val{min-width:2.4em;font-variant-numeric:tabular-nums;letter-spacing:.06em}
.cd-stage{display:none;position:relative;background:#050506;touch-action:none}
.cd-player.cd-vert .cd-stage{display:block;height:520px}
.cd-player.cd-horiz .cd-stage{display:block;height:300px}
@media (max-width:640px){
  .cd-player.cd-vert .cd-stage{height:360px}
  .cd-player.cd-horiz .cd-stage{height:220px}
  .cd-brand{display:none}
}
.cd-stage canvas{display:block;width:100%;height:100%}
.cd-player.cd-vert .cd-stage canvas{cursor:ns-resize;mask-image:linear-gradient(180deg,#000 0%,#000 88%,transparent 100%)}
.cd-player.cd-horiz .cd-stage canvas{cursor:ew-resize;mask-image:linear-gradient(90deg,transparent 0%,#000 8%,#000 100%)}
.cd-playhead{position:absolute;background:rgba(236,236,232,.88);box-shadow:0 0 14px 2px rgba(236,236,232,.28);pointer-events:none}
.cd-player.cd-vert .cd-playhead{left:0;right:0;top:22%;height:1px;width:auto}
.cd-player.cd-horiz .cd-playhead{top:0;bottom:0;left:22%;width:1px;height:auto}
.cd-seam{position:absolute;background:rgba(236,236,232,.14);pointer-events:none}
.cd-player.cd-vert .cd-seam{top:0;bottom:0;left:50%;width:1px;height:auto}
.cd-player.cd-horiz .cd-seam{left:0;right:0;top:50%;height:1px;width:auto}
.cd-lr{position:absolute;font:600 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;pointer-events:none}
.cd-player.cd-vert .cd-lr{top:50%;transform:translateY(-50%)}
.cd-player.cd-vert .cd-lr-l{left:10px;color:#3dffb0}
.cd-player.cd-vert .cd-lr-r{right:10px;color:#3db0ff}
.cd-player.cd-horiz .cd-lr{left:10px}
.cd-player.cd-horiz .cd-lr-l{top:10px;color:#3dffb0}
.cd-player.cd-horiz .cd-lr-r{bottom:10px;color:#3db0ff}
.cd-status{position:absolute;right:12px;bottom:8px;font:500 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:rgba(236,236,232,.38);pointer-events:none}
.cd-audio-host{margin:0 0 2rem;background:#08080a;border-radius:0 0 16px 16px;box-shadow:0 0 0 1px rgba(255,255,255,.08);padding:4px 10px 10px;color-scheme:dark}
.cd-audio-host audio{width:100%;display:block;height:40px;accent-color:#d8d4cc}
`;

  const players = new WeakMap();
  let sharedCtx = null;
  const specCache = new Map();
  let analysisTail = Promise.resolve();

  function analyzeUrl(url) {
    if (!url) return null;
    if (!specCache.has(url)) {
      const job = analysisTail.then(async () => {
        const buf = await decodeFile(url);
        const analysed = await analyzeBuffer(buf);
        return {
          chroma: renderPair(analysed.lFrames, analysed.rFrames, false),
          pan: renderPair(analysed.lFrames, analysed.rFrames, true),
          hopTime: analysed.hopTime,
          nFrames: analysed.nFrames,
        };
      });
      analysisTail = job.catch(() => {});
      specCache.set(url, job);
    }
    return specCache.get(url);
  }

  function injectCss() {
    let el = document.querySelector("style[data-chroma-drift]");
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-chroma-drift", "1");
      document.head.appendChild(el);
    }
    el.textContent = CSS;
  }

  function audioUrl(audio) {
    if (audio.currentSrc) return audio.currentSrc;
    const source = audio.querySelector("source");
    if (source?.src) return source.src;
    return audio.src;
  }

  function makeFFT(n) {
    const logN = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let y = 0;
      for (let k = 0; k < logN; k++) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      rev[i] = y;
    }
    const half = n >> 1;
    const cos = new Float32Array(half);
    const sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / n;
      cos[i] = Math.cos(a);
      sin[i] = Math.sin(a);
    }
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const mag = new Float32Array(half);
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const inv = 2 / n;

    return {
      mag,
      run(input, offset) {
        for (let i = 0; i < n; i++) {
          const j = rev[i];
          const idx = offset + i;
          re[j] = (idx >= 0 && idx < input.length ? input[idx] : 0) * win[i];
          im[j] = 0;
        }
        for (let size = 2; size <= n; size <<= 1) {
          const halfS = size >> 1;
          const step = n / size;
          for (let i = 0; i < n; i += size) {
            let k = 0;
            for (let j = 0; j < halfS; j++) {
              const tRe = cos[k] * re[i + j + halfS] - sin[k] * im[i + j + halfS];
              const tIm = cos[k] * im[i + j + halfS] + sin[k] * re[i + j + halfS];
              re[i + j + halfS] = re[i + j] - tRe;
              im[i + j + halfS] = im[i + j] - tIm;
              re[i + j] += tRe;
              im[i + j] += tIm;
              k += step;
            }
          }
        }
        for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]) * inv;
        return mag;
      },
    };
  }

  function sampleSpectrum(spectrum, sr, freq) {
    const b = (freq / sr) * FFT_SIZE;
    if (b < 1 || b >= spectrum.length - 2) return 0;
    const i = b | 0;
    const f = b - i;
    const m0 = spectrum[i - 1] || 0;
    const m1 = spectrum[i];
    const m2 = spectrum[i + 1];
    const m3 = spectrum[i + 2] || 0;
    return Math.max(
      0,
      m1 +
        0.5 *
          f *
          (m2 - m0 + f * (2 * m0 - 5 * m1 + 4 * m2 - m3 + f * (3 * (m1 - m2) + m3 - m0))),
    );
  }

  function noteMagsDense(spectrum, sr, out) {
    for (let b = 0; b < N_BINS; b++) {
      const midi = NOTE_MIN + b / BINS_PER_SEMI;
      const f0 = 440 * 2 ** ((midi - 69) / 12);
      const mag = sampleSpectrum(spectrum, sr, f0) * Math.sqrt(f0 / 220);
      const db = 20 * Math.log10(mag + 1e-12);
      // Enhanced dynamic thresholding curve
      out[b] = Math.min(1, Math.max(0, (db + 76) / 60)) ** 1.1;
    }
  }

  function writePix(p, w, x, y, col, v) {
    if (v < 0.015) return;
    // Hot incandescent core for vocal and melodic peaks
    const hot = v * v * v;
    const i = (y * w + x) << 2;
    p[i]     = Math.min(255, col[0] * v + 255 * hot);
    p[i + 1] = Math.min(255, col[1] * v + 255 * hot);
    p[i + 2] = Math.min(255, col[2] * v + 255 * hot);
    p[i + 3] = Math.min(255, v * 1.55 * 255);
  }

  function chromaOfBin(b) {
    const midi = NOTE_MIN + b / BINS_PER_SEMI;
    return CHROMA[((Math.round(midi) % 12) + 12) % 12];
  }

  function renderPair(lFrames, rFrames, pan) {
    const nFrames = (lFrames.length / N_BINS) | 0;
    const halfW = N_BINS;
    const w = halfW * 2 + GAP_PX;
    const h = Math.max(1, nFrames);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: true });
    const img = ctx.createImageData(w, h);
    const p = img.data;
    for (let y = 0; y < nFrames; y++) {
      const off = y * N_BINS;
      for (let b = 0; b < N_BINS; b++) {
        const l = lFrames[off + b];
        const r = rFrames[off + b];
        const xL = halfW - 1 - b;
        const xR = halfW + GAP_PX + b;
        if (pan) {
          const d = l - r;
          writePix(p, w, xL, y, COL_L, d > 0 ? d : 0);
          writePix(p, w, xR, y, COL_R, d < 0 ? -d : 0);
        } else {
          writePix(p, w, xL, y, chromaOfBin(b), l);
          writePix(p, w, xR, y, chromaOfBin(b), r);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function decodeFile(url) {
    const ctx = getCtx();
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch " + res.status);
    const ab = await res.arrayBuffer();
    return await ctx.decodeAudioData(ab.slice(0));
  }

  async function analyzeBuffer(audioBuffer, onProgress) {
    const sr = audioBuffer.sampleRate;
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    const nFrames = Math.max(1, Math.ceil(left.length / HOP));
    const lFrames = new Float32Array(nFrames * N_BINS);
    const rFrames = new Float32Array(nFrames * N_BINS);
    const fft = makeFFT(FFT_SIZE);
    const tmp = new Float32Array(N_BINS);
    const offset = -(FFT_SIZE >> 1);

    for (let f = 0; f < nFrames; f++) {
      const pos = f * HOP + offset;
      noteMagsDense(fft.run(left, pos), sr, tmp);
      lFrames.set(tmp, f * N_BINS);
      noteMagsDense(fft.run(right, pos), sr, tmp);
      rFrames.set(tmp, f * N_BINS);
      if ((f & 63) === 63) {
        onProgress?.(f / nFrames);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return { lFrames, rFrames, sr, hopTime: HOP / sr, nFrames };
  }

  function getCtx() {
    if (!sharedCtx) sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    return sharedCtx;
  }

  function attachLive(audio, state) {
    if (state.live) return state.live;
    try {
      const ctx = getCtx();
      const src = ctx.createMediaElementSource(audio);
      const split = ctx.createChannelSplitter(2);
      const analyserL = ctx.createAnalyser();
      const analyserR = ctx.createAnalyser();
      analyserL.fftSize = FFT_SIZE;
      analyserR.fftSize = FFT_SIZE;
      analyserL.smoothingTimeConstant = 0.38;
      analyserR.smoothingTimeConstant = 0.38;
      analyserL.minDecibels = -88;
      analyserR.minDecibels = -88;
      analyserL.maxDecibels = -24;
      analyserR.maxDecibels = -24;
      src.connect(split);
      src.connect(ctx.destination);
      split.connect(analyserL, 0);
      split.connect(analyserR, 1);
      state.live = {
        analyserL,
        analyserR,
        specL: new Float32Array(analyserL.frequencyBinCount),
        specR: new Float32Array(analyserR.frequencyBinCount),
        magL: new Float32Array(analyserL.frequencyBinCount),
        magR: new Float32Array(analyserR.frequencyBinCount),
        notesL: new Float32Array(N_BINS),
        notesR: new Float32Array(N_BINS),
      };
      return state.live;
    } catch {
      return null;
    }
  }

  function freqDbToMag(db, out) {
    for (let i = 0; i < db.length; i++) out[i] = 10 ** (db[i] / 20);
    return out;
  }

  function drawOverlay(ctx, w, h, layout) {
    ctx.save();
    ctx.font = "600 10px IBM Plex Sans, system-ui, sans-serif";
    ctx.fillStyle = "rgba(236,236,232,0.4)";
    const labels = [36, 48, 60, 72, 84, 96];
    const half = layout === LAYOUT_HORIZ ? h / 2 : w / 2;
    const gap = 4;
    const usable = half - gap;
    if (layout === LAYOUT_HORIZ) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const midi of labels) {
        const t = (midi - NOTE_MIN) / (NOTE_MAX - NOTE_MIN);
        const name = "C" + (Math.round(midi / 12) - 1);
        ctx.fillText(name, 10, usable * (1 - t));
        ctx.fillText(name, 10, half + gap + usable * t);
      }
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const midi of labels) {
        const t = (midi - NOTE_MIN) / (NOTE_MAX - NOTE_MIN);
        const name = "C" + (Math.round(midi / 12) - 1);
        ctx.fillText(name, usable * (1 - t), 8);
        ctx.fillText(name, half + gap + usable * t, 8);
      }
    }
    ctx.restore();
  }

  function blitVertical(g, spec, w, h, t, hopTime, windowSec) {
    const srcH = windowSec / hopTime;
    const srcCenter = t / hopTime;
    let sy = srcCenter - (1 - PLAYHEAD) * srcH;
    let sh = srcH;
    g.save();
    g.translate(0, h);
    g.scale(1, -1);
    let dy = 0;
    let dh = h;
    if (sy < 0) {
      const cut = -sy;
      dy += (cut / srcH) * h;
      dh -= (cut / srcH) * h;
      sh -= cut;
      sy = 0;
    }
    if (sy + sh > spec.height) {
      const extra = sy + sh - spec.height;
      sh -= extra;
      dh -= (extra / srcH) * h;
    }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    if (sh > 0.5 && dh > 0.5) {
      g.drawImage(spec, 0, sy, spec.width, sh, 0, dy, w, dh);
    }
    g.restore();
  }

  function blitHorizontal(g, spec, w, h, t, hopTime, windowSec) {
    const srcH = windowSec / hopTime;
    const srcCenter = t / hopTime;
    let sy = srcCenter - PLAYHEAD * srcH;
    let sh = srcH;
    let dx = 0;
    let dw = w;
    if (sy < 0) {
      const cut = -sy;
      dx = (cut / srcH) * w;
      dw = w - dx;
      sh -= cut;
      sy = 0;
    }
    if (sy + sh > spec.height) {
      sh = spec.height - sy;
      dw = (sh / srcH) * w;
    }
    if (sh < 0.5 || dw < 0.5) return;
    g.save();
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.setTransform(0, h / spec.width, dw / sh, 0, dx - (sy * dw) / sh, 0);
    g.drawImage(spec, 0, 0);
    g.restore();
  }

  function scrollLive(g, w, h, layout, pan, notesL, notesR) {
    try {
      const img = g.getImageData(0, 0, w, h);
      const buf = new Uint32Array(img.data.buffer);
      const p = img.data;
      const clear = 0xff050605;
      if (layout === LAYOUT_VERT) {
        const playY = (h * PLAYHEAD) | 0;
        for (let y = h - 1; y > playY; y--) buf.copyWithin(y * w, (y - 1) * w, y * w);
        for (let x = 0; x < w; x++) buf[playY * w + x] = clear;
        paintLiveRow(p, w, playY, 0, w, true, pan, notesL, notesR);
      } else {
        const playX = (w * PLAYHEAD) | 0;
        for (let y = 0; y < h; y++) {
          const row = y * w;
          buf.copyWithin(row, row + 1, row + playX);
          buf[row + playX - 1] = clear;
        }
        paintLiveRow(p, w, 0, playX - 1, h, false, pan, notesL, notesR);
      }
      g.putImageData(img, 0, 0);
    } catch {
      /* ignore */
    }
  }

  function paintLiveRow(p, strideW, yOrStart, xOrPlay, span, vertical, pan, notesL, notesR) {
    const half = span / 2;
    const usable = span / 2 - 2;
    for (let b = 0; b < N_BINS; b++) {
      const t = b / (N_BINS - 1);
      const l = notesL[b];
      const r = notesR[b];
      if (vertical) {
        const xL = (usable * (1 - t)) | 0;
        const xR = (half + 2 + usable * t) | 0;
        if (pan) {
          const d = l - r;
          writePix(p, strideW, xL, yOrStart, COL_L, d > 0 ? d : 0);
          writePix(p, strideW, xR, yOrStart, COL_R, d < 0 ? -d : 0);
        } else {
          writePix(p, strideW, xL, yOrStart, chromaOfBin(b), l);
          writePix(p, strideW, xR, yOrStart, chromaOfBin(b), r);
        }
      } else {
        const yL = (usable * (1 - t)) | 0;
        const yR = (half + 2 + usable * t) | 0;
        const x = xOrPlay;
        if (pan) {
          const d = l - r;
          writePix(p, strideW, x, yL, COL_L, d > 0 ? d : 0);
          writePix(p, strideW, x, yR, COL_R, d < 0 ? -d : 0);
        } else {
          writePix(p, strideW, x, yL, chromaOfBin(b), l);
          writePix(p, strideW, x, yR, chromaOfBin(b), r);
        }
      }
    }
  }

  function enhance(audio) {
    if (!(audio instanceof HTMLAudioElement)) return;
    if (audio.closest("[data-chroma-skip]")) return;
    const prev = players.get(audio);
    if (prev?.player?.isConnected) return;

    const host =
      audio.parentElement?.tagName === "P" && audio.parentElement.childElementCount <= 2
        ? audio.parentElement
        : audio;
    const prevWrap = host.previousElementSibling;
    if (prevWrap?.hasAttribute("data-chroma-player")) prevWrap.remove();

    injectCss();
    audio.crossOrigin = audio.crossOrigin || "anonymous";

    const player = document.createElement("div");
    player.className = "cd-player cd-off";
    player.setAttribute("data-chroma-player", "1");

    const toolbar = document.createElement("div");
    toolbar.className = "cd-toolbar";
    const brand = document.createElement("span");
    brand.className = "cd-brand";
    brand.textContent = "Chroma Drift";

    const controls = document.createElement("div");
    controls.className = "cd-controls";

    const seg = document.createElement("div");
    seg.className = "cd-seg";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Spectrogram layout");
    const layoutBtns = [
      ["Off", LAYOUT_OFF],
      ["Vertical", LAYOUT_VERT],
      ["Horizontal", LAYOUT_HORIZ],
    ].map(([label, id]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", id === LAYOUT_OFF ? "true" : "false");
      b.dataset.layout = String(id);
      seg.appendChild(b);
      return b;
    });

    const panBtn = document.createElement("button");
    panBtn.type = "button";
    panBtn.className = "cd-pan";
    panBtn.textContent = "L − R";
    panBtn.setAttribute("aria-pressed", "false");
    panBtn.title = "Subtractive pan: mint = left, azure = right, center cancels";

    const speed = document.createElement("label");
    speed.className = "cd-speed";
    const speedName = document.createElement("span");
    speedName.textContent = "Window";
    const speedInput = document.createElement("input");
    speedInput.type = "range";
    speedInput.min = String(WINDOW_MIN);
    speedInput.max = String(WINDOW_MAX);
    speedInput.step = "0.1";
    speedInput.value = String(WINDOW_DEFAULT);
    speedInput.setAttribute("aria-label", "Visible time window");
    const speedVal = document.createElement("span");
    speedVal.className = "cd-speed-val";
    speedVal.textContent = `${WINDOW_DEFAULT.toFixed(1)}s`;
    speed.append(speedName, speedInput, speedVal);

    controls.append(seg, panBtn, speed);
    toolbar.append(brand, controls);

    const stage = document.createElement("div");
    stage.className = "cd-stage";
    const canvas = document.createElement("canvas");
    const playhead = document.createElement("div");
    playhead.className = "cd-playhead";
    const seam = document.createElement("div");
    seam.className = "cd-seam";
    const tagL = document.createElement("div");
    tagL.className = "cd-lr cd-lr-l";
    tagL.textContent = "L";
    const tagR = document.createElement("div");
    tagR.className = "cd-lr cd-lr-r";
    tagR.textContent = "R";
    const status = document.createElement("div");
    status.className = "cd-status";
    stage.append(canvas, playhead, seam, tagL, tagR, status);
    player.append(toolbar, stage);

    host.parentNode.insertBefore(player, host);
    host.classList.add("cd-audio-host");

    // FIXED: willReadFrequently set to true to eliminate browser readback overhead
    const ctx2d = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    
    const state = {
      player,
      canvas,
      ctx: ctx2d,
      chroma: null,
      panSpec: null,
      hopTime: HOP / 44100,
      nFrames: 0,
      raf: 0,
      live: null,
      status,
      layout: LAYOUT_OFF,
      pan: false,
      windowSec: WINDOW_DEFAULT,
    };
    players.set(audio, state);

    function syncLayoutButtons() {
      layoutBtns.forEach((b) => {
        b.setAttribute("aria-pressed", Number(b.dataset.layout) === state.layout ? "true" : "false");
      });
      player.classList.toggle("cd-on", state.layout !== LAYOUT_OFF);
      player.classList.toggle("cd-off", state.layout === LAYOUT_OFF);
      player.classList.toggle("cd-vert", state.layout === LAYOUT_VERT);
      player.classList.toggle("cd-horiz", state.layout === LAYOUT_HORIZ);
      panBtn.setAttribute("aria-pressed", state.pan ? "true" : "false");
    }

    function ensureAnalyzed() {
      if (state.chroma || state.pending) return;
      const url = audioUrl(audio);
      const job = analyzeUrl(url);
      if (!job) {
        status.textContent = "live";
        return;
      }
      state.pending = true;
      status.textContent = "reading";
      job
        .then((analysed) => {
          state.pending = false;
          if (!player.isConnected) return;
          state.hopTime = analysed.hopTime;
          state.nFrames = analysed.nFrames;
          state.chroma = analysed.chroma;
          state.panSpec = analysed.pan;
          status.textContent = "";
          paint();
        })
        .catch((err) => {
          state.pending = false;
          status.textContent = "live";
          console.warn("[chroma-drift]", err);
        });
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(2, Math.round(rect.width * dpr));
      const h = Math.max(2, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        return true;
      }
      return false;
    }

    function paint() {
      if (state.layout === LAYOUT_OFF) return;
      const didResize = resize();
      const w = canvas.width;
      const h = canvas.height;
      if (w < 4 || h < 4) return;
      const g = state.ctx;
      const t = audio.currentTime || 0;
      const spec = state.pan ? state.panSpec : state.chroma;

      if (spec) {
        g.fillStyle = "#050506";
        g.fillRect(0, 0, w, h);
        if (state.layout === LAYOUT_VERT) blitVertical(g, spec, w, h, t, state.hopTime, state.windowSec);
        else blitHorizontal(g, spec, w, h, t, state.hopTime, state.windowSec);
        drawOverlay(g, w, h, state.layout);
      } else if (state.live && !audio.paused) {
        if (didResize) {
          g.fillStyle = "#050506";
          g.fillRect(0, 0, w, h);
        }
        const live = state.live;
        live.analyserL.getFloatFrequencyData(live.specL);
        live.analyserR.getFloatFrequencyData(live.specR);
        const sr = getCtx().sampleRate;
        noteMagsDense(freqDbToMag(live.specL, live.magL), sr, live.notesL);
        noteMagsDense(freqDbToMag(live.specR, live.magR), sr, live.notesR);
        scrollLive(g, w, h, state.layout, state.pan, live.notesL, live.notesR);
      } else {
        g.fillStyle = "#050506";
        g.fillRect(0, 0, w, h);
        drawOverlay(g, w, h, state.layout);
      }
    }

    function loop() {
      paint();
      if (state.layout !== LAYOUT_OFF && !audio.paused && !audio.ended) {
        state.raf = requestAnimationFrame(loop);
      } else state.raf = 0;
    }

    function seekFromEvent(e) {
      if (state.layout === LAYOUT_OFF) return;
      const rect = canvas.getBoundingClientRect();
      const dt =
        state.layout === LAYOUT_VERT
          ? (PLAYHEAD - (e.clientY - rect.top) / rect.height) * state.windowSec
          : ((e.clientX - rect.left) / rect.width - PLAYHEAD) * state.windowSec;
      const dur = audio.duration;
      if (!Number.isFinite(dur)) return;
      audio.currentTime = Math.min(dur, Math.max(0, (audio.currentTime || 0) + dt));
      paint();
    }

    layoutBtns.forEach((b) => {
      b.addEventListener("click", () => {
        state.layout = Number(b.dataset.layout);
        syncLayoutButtons();
        if (state.layout !== LAYOUT_OFF) {
          ensureAnalyzed();
          if (!audio.paused && !state.raf) loop();
        }
        requestAnimationFrame(paint);
      });
    });

    panBtn.addEventListener("click", () => {
      state.pan = !state.pan;
      syncLayoutButtons();
      paint();
    });

    speedInput.addEventListener("input", () => {
      state.windowSec = Number(speedInput.value);
      speedVal.textContent = `${state.windowSec.toFixed(1)}s`;
      paint();
    });

    // Mobile & Desktop Safe AudioContext unlock and seek listener
    canvas.addEventListener("pointerdown", (e) => {
      if (sharedCtx && sharedCtx.state === "suspended") {
        sharedCtx.resume().catch(() => {});
      }
      canvas.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons) seekFromEvent(e);
    });

    audio.addEventListener("play", () => {
      if (sharedCtx && sharedCtx.state === "suspended") {
        sharedCtx.resume().catch(() => {});
      }
      if (state.layout !== LAYOUT_OFF && !state.chroma) attachLive(audio, state);
      if (state.layout !== LAYOUT_OFF && !state.raf) loop();
    });

    audio.addEventListener("pause", () => paint());
    audio.addEventListener("seeked", () => paint());
    audio.addEventListener("timeupdate", () => {
      if (audio.paused) paint();
    });

    const ro = new ResizeObserver(() => paint());
    ro.observe(stage);
    syncLayoutButtons();
  }

  function enhanceAll(root = document) {
    injectCss();
    root.querySelectorAll?.("audio").forEach(enhance);
    if (root instanceof HTMLAudioElement) enhance(root);
  }

  function observe() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n instanceof HTMLAudioElement) enhance(n);
          else enhanceAll(n);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    
    // Astro View Transitions lifecycle hooks
    document.addEventListener("astro:page-load", () => enhanceAll(document));
    document.addEventListener("astro:before-swap", () => {
      document.querySelectorAll("audio").forEach((el) => {
        const st = players.get(el);
        if (st && st.raf) {
          cancelAnimationFrame(st.raf);
          st.raf = 0;
        }
      });
    });
  }

  function scheduleEnhance() {
    const run = () => {
      enhanceAll(document);
      observe();
    };
    const afterHydrate = () => {
      requestAnimationFrame(() => setTimeout(run, 0));
    };
    if (document.readyState === "complete") afterHydrate();
    else window.addEventListener("load", afterHydrate);
  }

  scheduleEnhance();
  window.ChromaDrift = { enhance, enhanceAll };
})();