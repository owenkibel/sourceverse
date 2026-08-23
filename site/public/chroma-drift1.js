/**
 * Chroma Drift — drop-in stereo spectrogram player.
 * Finds every <audio> tag and inserts a pitch-colored waterfall spectrogram.
 * Left channel on the left, right on the right; time falls downward.
 * Same-origin audio required (Web Audio cannot analyse cross-origin files).
 *
 * Usage (Astro layout):
 *   <script src="/chroma-drift.js" type="module"></script>
 */
(() => {
  if (typeof window === "undefined") return;
  if (window.__chromaDriftVersion === 2) return;
  if (window.__chromaDriftVersion) {
    document.querySelectorAll("[data-chroma-player]").forEach((el) => el.remove());
    document.querySelectorAll(".cd-audio-host").forEach((el) =>
      el.classList.remove("cd-audio-host"),
    );
  }
  window.__chromaDriftVersion = 2;
  window.__chromaDriftBooted = true;

  const NOTE_MIN = 36;
  const NOTE_MAX = 96;
  const N_NOTES = NOTE_MAX - NOTE_MIN + 1;
  const FFT_SIZE = 4096;
  const HOP = 512;
  const WINDOW_SEC = 9;
  const PLAYHEAD = 0.22;
  const NOTE_PX = 6;
  const GAP_PX = 6;

  const CHROMA = [
    [255, 52, 90],
    [255, 112, 28],
    [255, 204, 32],
    [186, 242, 28],
    [40, 236, 120],
    [0, 230, 196],
    [0, 204, 255],
    [56, 148, 255],
    [124, 96, 255],
    [196, 78, 255],
    [255, 56, 214],
    [255, 72, 148],
  ];

  const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

  const CSS = `
.cd-player{margin:1.75rem 0 0;background:#08080a;border-radius:16px 16px 0 0;box-shadow:0 0 0 1px rgba(255,255,255,.08);overflow:hidden;color:#ecece8}
.cd-chrome{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px 6px;font:500 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:rgba(236,236,232,.48)}
.cd-legend{display:flex;flex-wrap:wrap;gap:6px 8px;justify-content:flex-end}
.cd-chip{display:inline-flex;align-items:center;gap:4px;letter-spacing:.04em;text-transform:none;font-weight:500;color:rgba(236,236,232,.55)}
.cd-swatch{width:7px;height:7px;border-radius:1px;display:inline-block}
.cd-stage{position:relative;height:400px;background:#050506;touch-action:none}
@media (max-width:640px){.cd-stage{height:300px}.cd-legend{display:none}}
.cd-stage canvas{display:block;width:100%;height:100%;cursor:ns-resize;mask-image:linear-gradient(180deg,#000 0%,#000 88%,transparent 100%)}
.cd-playhead{position:absolute;left:0;right:0;top:22%;width:auto;height:1px;background:rgba(236,236,232,.88);box-shadow:0 0 14px 2px rgba(236,236,232,.28);pointer-events:none}
.cd-seam{position:absolute;top:0;bottom:0;left:50%;width:1px;height:auto;background:rgba(236,236,232,.14);pointer-events:none}
.cd-lr{position:absolute;top:50%;font:600 10px/1 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;pointer-events:none;transform:translateY(-50%)}
.cd-lr-l{left:10px;color:#3dffb0}
.cd-lr-r{right:10px;left:auto;bottom:auto;color:#3db0ff}
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
          spec: renderSpec(analysed.lFrames, analysed.rFrames),
          hopTime: analysed.hopTime,
          nFrames: analysed.nFrames,
        };
      });
      analysisTail = job.catch(() => {});
      specCache.set(url, job);
    }
    return specCache.get(url);
  }

  function prefetchAll(root = document) {
    root.querySelectorAll?.("audio").forEach((audio) => {
      const url = audioUrl(audio);
      if (url) analyzeUrl(url);
    });
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

  function makeNoteMap(sr) {
    const maps = [];
    for (let midi = NOTE_MIN; midi <= NOTE_MAX; midi++) {
      const f0 = 440 * 2 ** ((midi - 69) / 12);
      const fLo = 440 * 2 ** ((midi - 0.5 - 69) / 12);
      const fHi = 440 * 2 ** ((midi + 0.5 - 69) / 12);
      maps.push({
        midi,
        f0,
        b0: (fLo / sr) * FFT_SIZE,
        b1: (fHi / sr) * FFT_SIZE,
        bc: (f0 / sr) * FFT_SIZE,
      });
    }
    return maps;
  }

  function noteMags(spectrum, maps, out) {
    for (let n = 0; n < maps.length; n++) {
      const { b0, b1, bc, f0 } = maps[n];
      const i0 = Math.max(1, b0 | 0);
      const i1 = Math.min(spectrum.length - 1, Math.ceil(b1));
      let e = 0;
      let w = 0;
      const halfW = Math.max(0.6, (b1 - b0) * 0.5);
      for (let i = i0; i <= i1; i++) {
        const t = 1 - Math.abs(i - bc) / halfW;
        if (t > 0) {
          e += spectrum[i] * t;
          w += t;
        }
      }
      const mag = (w > 0 ? e / w : 0) * Math.sqrt(f0 / 220);
      const db = 20 * Math.log10(mag + 1e-12);
      const norm = Math.min(1, Math.max(0, (db + 78) / 62));
      out[n] = norm ** 1.35;
    }
  }

  function sampleNote(notes, off, midi) {
    const x = midi - NOTE_MIN;
    if (x <= 0) return notes[off];
    if (x >= N_NOTES - 1) return notes[off + N_NOTES - 1];
    const i = x | 0;
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return notes[off + i] * (1 - s) + notes[off + i + 1] * s;
  }

  function fillPitchSpan(p, strideW, y, notes, off, x0, x1, highAtOuter) {
    const span = Math.max(1, x1 - x0);
    for (let x = x0; x < x1; x++) {
      const t = (x - x0) / span;
      const midi = highAtOuter
        ? NOTE_MAX - t * (NOTE_MAX - NOTE_MIN)
        : NOTE_MIN + t * (NOTE_MAX - NOTE_MIN);
      const v = sampleNote(notes, off, midi);
      if (v < 0.016) continue;
      const nearest = Math.round(Math.min(N_NOTES - 1, Math.max(0, midi - NOTE_MIN)));
      const col = CHROMA[(NOTE_MIN + nearest) % 12];
      const hot = v * v * v;
      const i = (y * strideW + x) << 2;
      p[i] = Math.min(255, col[0] * v + 255 * hot);
      p[i + 1] = Math.min(255, col[1] * v + 255 * hot);
      p[i + 2] = Math.min(255, col[2] * v + 255 * hot);
      p[i + 3] = Math.min(255, v * 1.4 * 255);
    }
  }

  function renderSpec(lFrames, rFrames) {
    const nFrames = (lFrames.length / N_NOTES) | 0;
    const halfW = N_NOTES * NOTE_PX;
    const w = halfW * 2 + GAP_PX;
    const h = Math.max(1, nFrames);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: true });
    const img = ctx.createImageData(w, h);
    const p = img.data;
    for (let y = 0; y < nFrames; y++) {
      const off = y * N_NOTES;
      fillPitchSpan(p, w, y, lFrames, off, 0, halfW, true);
      fillPitchSpan(p, w, y, rFrames, off, halfW + GAP_PX, w, false);
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
    const lFrames = new Float32Array(nFrames * N_NOTES);
    const rFrames = new Float32Array(nFrames * N_NOTES);
    const fft = makeFFT(FFT_SIZE);
    const maps = makeNoteMap(sr);
    const tmp = new Float32Array(N_NOTES);
    const offset = -(FFT_SIZE >> 1);

    for (let f = 0; f < nFrames; f++) {
      const pos = f * HOP + offset;
      noteMags(fft.run(left, pos), maps, tmp);
      lFrames.set(tmp, f * N_NOTES);
      noteMags(fft.run(right, pos), maps, tmp);
      rFrames.set(tmp, f * N_NOTES);
      if ((f & 127) === 127) {
        onProgress?.(f / nFrames);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return { lFrames, rFrames, sr, hopTime: HOP / sr, nFrames };
  }

  function getCtx() {
    if (!sharedCtx) sharedCtx = new AudioContext();
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
      analyserL.smoothingTimeConstant = 0.42;
      analyserR.smoothingTimeConstant = 0.42;
      analyserL.minDecibels = -88;
      analyserR.minDecibels = -88;
      analyserL.maxDecibels = -24;
      analyserR.maxDecibels = -24;
      src.connect(split);
      src.connect(ctx.destination);
      split.connect(analyserL, 0);
      split.connect(analyserR, 1);
      const specL = new Float32Array(analyserL.frequencyBinCount);
      const specR = new Float32Array(analyserR.frequencyBinCount);
      const magL = new Float32Array(analyserL.frequencyBinCount);
      const magR = new Float32Array(analyserR.frequencyBinCount);
      const maps = makeNoteMap(ctx.sampleRate);
      state.live = {
        analyserL,
        analyserR,
        specL,
        specR,
        magL,
        magR,
        maps,
        notesL: new Float32Array(N_NOTES),
        notesR: new Float32Array(N_NOTES),
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

  function drawOverlay(ctx, w, h) {
    ctx.save();
    ctx.font = "600 10px IBM Plex Sans, system-ui, sans-serif";
    ctx.fillStyle = "rgba(236,236,232,0.4)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labels = [36, 48, 60, 72, 84, 96];
    const half = w / 2;
    const gap = 4;
    const usable = half - gap;
    for (const midi of labels) {
      const t = (midi - NOTE_MIN) / (NOTE_MAX - NOTE_MIN);
      const name = "C" + (Math.round(midi / 12) - 1);
      ctx.fillText(name, usable * (1 - t), 8);
      ctx.fillText(name, half + gap + usable * t, 8);
    }
    ctx.restore();
  }

  function scrollAndDraw(g, w, h, playY, notesL, notesR) {
    try {
      const img = g.getImageData(0, 0, w, h);
      const buf = new Uint32Array(img.data.buffer);
      for (let y = h - 1; y > playY; y--) {
        buf.copyWithin(y * w, (y - 1) * w, y * w);
      }
      const clear = 0xff050605;
      const row = playY * w;
      for (let x = 0; x < w; x++) buf[row + x] = clear;
      const p = img.data;
      const half = (w / 2) | 0;
      const gap = 4;
      fillPitchSpan(p, w, playY, notesL, 0, 0, half - (gap >> 1), true);
      fillPitchSpan(p, w, playY, notesR, 0, half + (gap >> 1), w, false);
      g.putImageData(img, 0, 0);
    } catch {
      /* tainted canvas — ignore */
    }
  }

  function enhance(audio) {
    if (!(audio instanceof HTMLAudioElement)) return;
    if (audio.closest("[data-chroma-skip]")) return;

    const host =
      audio.parentElement?.tagName === "P" && audio.parentElement.childElementCount <= 2
        ? audio.parentElement
        : audio;
    const prevWrap = host.previousElementSibling;
    if (prevWrap?.hasAttribute("data-chroma-player")) prevWrap.remove();

    const prev = players.get(audio);
    if (prev?.player?.isConnected) return;

    injectCss();
    audio.crossOrigin = audio.crossOrigin || "anonymous";

    const player = document.createElement("div");
    player.className = "cd-player";
    player.setAttribute("data-chroma-player", "1");

    const chrome = document.createElement("div");
    chrome.className = "cd-chrome";
    const brand = document.createElement("span");
    brand.textContent = "Chroma Drift · stereo waterfall";
    const legend = document.createElement("div");
    legend.className = "cd-legend";
    legend.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 12; i++) {
      const chip = document.createElement("span");
      chip.className = "cd-chip";
      const sw = document.createElement("span");
      sw.className = "cd-swatch";
      sw.style.background = `rgb(${CHROMA[i].join(",")})`;
      chip.append(sw, document.createTextNode(NAMES[i]));
      legend.appendChild(chip);
    }
    chrome.append(brand, legend);

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
    status.textContent = "reading";
    stage.append(canvas, playhead, seam, tagL, tagR, status);
    player.append(chrome, stage);

    host.parentNode.insertBefore(player, host);
    host.classList.add("cd-audio-host");

    const ctx2d = canvas.getContext("2d", { alpha: false });
    const state = {
      player,
      canvas,
      ctx: ctx2d,
      spec: null,
      hopTime: HOP / 44100,
      nFrames: 0,
      raf: 0,
      live: null,
      status,
    };
    players.set(audio, state);

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
      const didResize = resize();
      const w = canvas.width;
      const h = canvas.height;
      const g = state.ctx;
      const t = audio.currentTime || 0;

      if (state.spec) {
        g.fillStyle = "#050506";
        g.fillRect(0, 0, w, h);
        const srcH = WINDOW_SEC / state.hopTime;
        const srcCenter = t / state.hopTime;
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
        if (sy + sh > state.spec.height) {
          const extra = sy + sh - state.spec.height;
          sh -= extra;
          dh -= (extra / srcH) * h;
        }
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        if (sh > 0.5 && dh > 0.5) {
          g.drawImage(state.spec, 0, sy, state.spec.width, sh, 0, dy, w, dh);
        }
        g.restore();
        drawOverlay(g, w, h);
      } else if (state.live && !audio.paused) {
        if (didResize) {
          g.fillStyle = "#050506";
          g.fillRect(0, 0, w, h);
        }
        const live = state.live;
        live.analyserL.getFloatFrequencyData(live.specL);
        live.analyserR.getFloatFrequencyData(live.specR);
        noteMags(freqDbToMag(live.specL, live.magL), live.maps, live.notesL);
        noteMags(freqDbToMag(live.specR, live.magR), live.maps, live.notesR);
        const playY = (h * PLAYHEAD) | 0;
        scrollAndDraw(g, w, h, playY, live.notesL, live.notesR);
      } else {
        g.fillStyle = "#050506";
        g.fillRect(0, 0, w, h);
        drawOverlay(g, w, h);
      }
    }

    function loop() {
      paint();
      if (!audio.paused && !audio.ended) state.raf = requestAnimationFrame(loop);
      else state.raf = 0;
    }

    function seekFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const dt = (PLAYHEAD - y / rect.height) * WINDOW_SEC;
      const dur = audio.duration;
      if (!Number.isFinite(dur)) return;
      audio.currentTime = Math.min(dur, Math.max(0, (audio.currentTime || 0) + dt));
      paint();
    }

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons) seekFromEvent(e);
    });

    audio.addEventListener("play", () => {
      getCtx().resume?.();
      if (!state.spec) attachLive(audio, state);
      if (!state.raf) loop();
    });
    audio.addEventListener("pause", () => paint());
    audio.addEventListener("seeked", () => paint());
    audio.addEventListener("timeupdate", () => {
      if (audio.paused) paint();
    });

    const ro = new ResizeObserver(() => paint());
    ro.observe(stage);
    paint();

    const url = audioUrl(audio);
    const job = analyzeUrl(url);
    if (!job) {
      status.textContent = "live";
      return;
    }
    job
      .then((analysed) => {
        if (!player.isConnected) return;
        state.hopTime = analysed.hopTime;
        state.nFrames = analysed.nFrames;
        state.spec = analysed.spec;
        status.textContent = "";
        paint();
      })
      .catch((err) => {
        status.textContent = "live";
        console.warn("[chroma-drift]", err);
      });
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
    document.addEventListener("astro:page-load", () => {
      prefetchAll(document);
      enhanceAll(document);
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

  prefetchAll(document);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => prefetchAll(document));
  }
  scheduleEnhance();

  window.ChromaDrift = { enhance, enhanceAll };
})();