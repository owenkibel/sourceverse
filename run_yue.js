// run_yue.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";
const WORKFLOWS_DIR = "./workflows";

const DEFAULT_TEXT_TO_MUSIC_DURATION = 165;
const MAX_SAFE_VRAM_DURATION = 175;
const DEFAULT_YUE_CFG_SCALE = 1.8;
const DEFAULT_YUE_COVER_CFG_SCALE = 2.25; // Sweet spot: high sung-lyric adherence without 2.5+ harshness
const DEFAULT_DUCK_LEVEL = 0.32;          // Continuous harmonic bed (~-10 dB) when Kokoro interleaving is explicitly enabled
const DEFAULT_TTS_GAIN = 0.85;

// Warm, singing-forward vocal profiles (intentionally avoiding "classical" / "crystalline" cues that cause 20th-c. chromatic drift or glare)
const VOCAL_PROFILES = [
  {
    name: "Bass-Baritone",
    gender: "male",
    stylePrompt: "deep warm bass-baritone male lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, rich intimate resonance"
  },
  {
    name: "Mezzo-Soprano",
    gender: "female",
    stylePrompt: "warm rich contralto and mezzo-soprano female lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, intimate early music ballad tone"
  },
  {
    name: "Lyric Tenor",
    gender: "male",
    stylePrompt: "warm lyric tenor male lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, graceful acoustic ballad articulation"
  },
  {
    name: "Dramatic Soprano",
    gender: "female",
    stylePrompt: "warm expressive soprano female lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, lush resonant chamber tone"
  }
];

function dedupeStyleTags(styleStr) {
  const seen = new Set();
  return styleStr
    .split(',')
    .map(t => t.trim())
    .filter(t => {
      if (!t) return false;
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}

function isValidAbc(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  return (/^X:\s*\d+/m.test(trimmed) || trimmed.includes('K:') || trimmed.includes('M:') || trimmed.includes('|'));
}

function sanitizeLyrics(lyrics, { stripLeadingIntro = false, ensureIntroForCover = false } = {}) {
  if (!lyrics || !lyrics.trim()) return "[Instrumental]";
  let cleaned = lyrics
    .replace(/\\n/g, '\n')
    .replace(
      /\s*(\[(?:Intro|Verse[^\]]*|Chorus[^\]]*|Bridge[^\]]*|Outro[^\]]*|Instrumental[^\]]*|Hook[^\]]*)\])\s*/gi,
      '\n\n$1\n'
    )
    .replace(/[ \t]*[|/][ \t]*/g, '\n')
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (!t || t.startsWith('[')) return t;
      // Split long prose lines into shorter singable phrases (~6-10 syllables)
      if (t.length > 64) {
        return t
          .replace(/([.;!?—])\s+(?=[A-Za-z"'])/g, '$1\n')
          .replace(/,\s+(?=[A-Za-z"'])/g, ',\n');
      }
      return t;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (stripLeadingIntro) {
    // Only strip leading [Intro] when vocals literally start at t=0 (e.g. --speech-first or pure Kokoro cover)
    cleaned = cleaned.replace(/^\s*\[(intro|instrumental)[^\]]*\]\s*/i, '').trim();
  }

  if (!cleaned.includes('[')) {
    cleaned = `[Verse 1]\n${cleaned}`;
  }

  if (ensureIntroForCover && !/^\s*\[intro[^\]]*\]/i.test(cleaned)) {
    // Keep a brief musical pickup so YuE2 locks onto key & meter before singing enters on [Verse 1]
    cleaned = `[Intro]\n\n${cleaned}`;
  }

  return cleaned;
}

function probeAudioDurationSec(filePath, fallbackSec) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const parsed = Math.round(parseFloat(out));
    if (parsed && parsed > 2) {
      return Math.min(parsed, MAX_SAFE_VRAM_DURATION);
    }
  } catch (_) {}
  return fallbackSec;
}

function patchWorkflow(
  workflow,
  { style, lyrics, duration, seed, stagedRefAudio = null, cfgScale = DEFAULT_YUE_CFG_SCALE, samplerCfg = null }
) {
  let patchedStyle = false;
  let patchedLyrics = false;
  let patchedAudio = false;
  let abcGeneratorId = null;

  for (const nodeId of Object.keys(workflow)) {
    const node = workflow[nodeId];
    if (!node || !node.inputs) continue;

    if (node.class_type === 'YuE2GenerateABC' || node.class_type === 'SheetSage2AudioToABC') {
      abcGeneratorId = nodeId;
    }

    if ('seed' in node.inputs) node.inputs.seed = seed;
    if ('style' in node.inputs) { node.inputs.style = style; patchedStyle = true; }
    if ('lyrics' in node.inputs) { node.inputs.lyrics = lyrics; patchedLyrics = true; }
    if ('max_duration' in node.inputs) node.inputs.max_duration = duration;
    if ('duration' in node.inputs && typeof node.inputs.duration === 'number') {
      node.inputs.duration = duration;
    }

    // Node 33:25 (YuE2GenerateMusic): controls Stage-1 semantic lyric & vocal style adherence
    if (node.class_type === 'YuE2GenerateMusic' && 'cfg_scale' in node.inputs) {
      node.inputs.cfg_scale = cfgScale;
      console.log(`🎛️  Set YuE2GenerateMusic.cfg_scale = ${cfgScale}`);
    }

    // Node 33:8 (KSampler): keep Stage-2 acoustic diffusion cfg at workflow default (1.0) unless explicitly overridden
    if (node.class_type === 'KSampler' && samplerCfg !== null && 'cfg' in node.inputs) {
      node.inputs.cfg = samplerCfg;
      console.log(`🎛️  Set KSampler.cfg = ${samplerCfg}`);
    }

    if (stagedRefAudio && (node.class_type === 'LoadAudio' || 'audio' in node.inputs)) {
      if (typeof node.inputs.audio === 'string') {
        node.inputs.audio = stagedRefAudio;
        patchedAudio = true;
      }
    }
  }

  if (abcGeneratorId) {
    workflow["999999"] = {
      inputs: {
        source: [abcGeneratorId, 0]
      },
      class_type: "PreviewAny"
    };
  }

  return { workflow, patchedStyle, patchedLyrics, patchedAudio };
}

async function main() {
  let conformedRefPath = null;
  let stagedFilename = null;

  try {
    console.log("--- Starting YuE2 3B Generation ---");
    const args = process.argv.slice(2);

    const getArg = (flag) => {
      const idx = args.findIndex(a => a === flag);
      return idx !== -1 ? args[idx + 1] : null;
    };

    const stateFilePath = getArg('--state-file') || 'yue_state.json';
    const tags = getArg('--tags') || "Celtic Folk, Folk";
    const rawLyrics = getArg('--lyrics') || "";
    const requestedDuration = parseInt(getArg('--duration') || '128', 10);

    const refAudioPath = getArg('--ref-audio');
    const ttsAudioPath = getArg('--tts-audio');
    const stanzaFilesArg = getArg('--stanza-files');

    let stanzaPaths = [];
    if (stanzaFilesArg) {
      try {
        const parsed = JSON.parse(stanzaFilesArg);
        if (Array.isArray(parsed)) stanzaPaths = parsed.filter(p => p && fs.existsSync(p));
      } catch (_) {
        stanzaPaths = stanzaFilesArg.split(',').map(s => s.trim()).filter(p => p && fs.existsSync(p));
      }
    }

    const ttsMode = (getArg('--tts-mode') || 'loop').toLowerCase(); // 'loop' | 'once'
    const speechFirst = args.includes('--speech-first');
    const earlyMusicFlag = args.includes('--early-music');
    const refPocket = args.includes('--ref-pocket');

    const duckLevelArg = getArg('--duck-level');
    const ttsGainArg = getArg('--tts-gain');
    const duckLevel = duckLevelArg !== null ? Math.max(0.0, Math.min(1.0, parseFloat(duckLevelArg))) : DEFAULT_DUCK_LEVEL;
    const ttsGain = ttsGainArg !== null ? Math.max(0.1, Math.min(1.5, parseFloat(ttsGainArg))) : DEFAULT_TTS_GAIN;

    const hasInstRef = Boolean(refAudioPath && fs.existsSync(refAudioPath));
    const hasTtsGuide = Boolean(ttsAudioPath && fs.existsSync(ttsAudioPath));
    const hasStanzas = Boolean(hasInstRef && stanzaPaths.length > 0);
    const isCover = hasInstRef || hasTtsGuide;

    const cfgArg = getArg('--cfg');
    const samplerCfgArg = getArg('--sampler-cfg');
    const cfgScale = cfgArg !== null
      ? parseFloat(cfgArg)
      : (isCover ? DEFAULT_YUE_COVER_CFG_SCALE : DEFAULT_YUE_CFG_SCALE);
    const samplerCfg = samplerCfgArg !== null ? parseFloat(samplerCfgArg) : null;

    const seed = Math.floor(Math.random() * 1000000000);

    let selectedVoice = VOCAL_PROFILES[1];
    const lowerTags = tags.toLowerCase();
    if (lowerTags.includes('baritone') || lowerTags.includes('bass')) {
      selectedVoice = VOCAL_PROFILES[0];
    } else if (lowerTags.includes('dramatic soprano')) {
      selectedVoice = VOCAL_PROFILES[3];
    } else if (lowerTags.includes('tenor')) {
      selectedVoice = VOCAL_PROFILES[2];
    }

    const isEarlyMusic =
      earlyMusicFlag ||
      /\b(early music|baroque|renaissance|harpsichord|lute|madrigal|cantata|aria|chamber|celtic folk|irish folk|viola da gamba|continuo|recorder|consort)\b/i.test(tags);

    // For early music, drop standalone "Classical" (which pulls YuE2 toward 20th-century chromaticism)
    // and anchor genre blending through Celtic Folk & Folk with warm wooden chamber acoustics.
    const cleanedTags = isEarlyMusic
      ? tags
          .split(',')
          .map(t => t.trim())
          .filter(t => t && !/^classical$/i.test(t))
          .join(', ')
      : tags;

    const compositeStyle = dedupeStyleTags(
      isEarlyMusic
        ? `${selectedVoice.stylePrompt}, continuous melodic singing, lyrical sung early music ballad, Celtic Folk, Folk, modal acoustic melody, ${cleanedTags}, warm wooden chamber acoustics, rich stereo depth, natural hall resonance`
        : `${selectedVoice.stylePrompt}, continuous melodic singing, clear sung vocal melody, ${cleanedTags}, warm balanced mix, rich stereo depth`
    );

    const vocalsStartAtZero = speechFirst || (hasTtsGuide && !hasInstRef);
    const pureMusicalCover = hasInstRef && !hasStanzas && !speechFirst;
    const formattedLyrics = sanitizeLyrics(rawLyrics, {
      stripLeadingIntro: vocalsStartAtZero,
      ensureIntroForCover: pureMusicalCover
    });

    console.log(`🎼 Composite Style Prompt: "${compositeStyle}"`);

    const workflowFile = isCover
      ? path.join(WORKFLOWS_DIR, 'yue2_cover_api.json')
      : path.join(WORKFLOWS_DIR, 'yue2_text_to_music_api.json');

    if (!fs.existsSync(workflowFile)) {
      throw new Error(`Required ComfyUI API template not found: ${workflowFile}. Please export it from ComfyUI first.`);
    }

    let effectiveDuration = requestedDuration;
    if (!isCover && requestedDuration >= 90 && requestedDuration < DEFAULT_TEXT_TO_MUSIC_DURATION) {
      effectiveDuration = DEFAULT_TEXT_TO_MUSIC_DURATION;
      console.log(`⏱️ [Text-to-Music] Extending target duration from ${requestedDuration}s -> ${effectiveDuration}s for full lyric completion.`);
    } else if (hasInstRef) {
      effectiveDuration = probeAudioDurationSec(refAudioPath, DEFAULT_TEXT_TO_MUSIC_DURATION);
      console.log(`⏱️ [Cover Mode] Locking duration to reference track length: ${effectiveDuration}s`);
    } else if (hasTtsGuide) {
      effectiveDuration = Math.max(requestedDuration, DEFAULT_TEXT_TO_MUSIC_DURATION);
      console.log(`⏱️ [Pure Kokoro Cover Mode] Setting duration to ${effectiveDuration}s (mode: ${ttsMode})`);
    }

    const baseWorkflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));

    if (isCover) {
      conformedRefPath = path.join(os.tmpdir(), `yue_ref_${Date.now()}.flac`);
      // Strips leading silence AND any internal dead-air pauses (>0.35s below -45dB) from the musical reference track:
      const bachCleanFilter =
        'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-42dB:stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB';
      // Optional mild midrange pocket applied ONLY to temporary ComfyUI conditioning audio (leaves published example .opus rich & untouched):
      const refPocketFilter = refPocket ? ',equalizer=f=1800:t=q:w=1.2:g=-2.5' : '';
      // Only strips leading silence on Kokoro speech so natural spoken cadence is untouched:
      const ttsSilenceStrip =
        'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-42dB';
      const fadeStart = Math.max(5, effectiveDuration - 4.5);

      if (hasStanzas) {
        const stanzas = stanzaPaths.map(p => {
          const out = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim();
          return { path: p, dur: Math.max(0.5, parseFloat(out) || 4.0) };
        });

        const N = stanzas.length;
        const totalSpeechDur = stanzas.reduce((acc, s) => acc + s.dur, 0);
        const usableDur = Math.max(totalSpeechDur + 4.0, effectiveDuration - 2.5);
        const gapDivisor = Math.max(1, speechFirst ? N : (N + 1));
        const bachGap = Math.max(1.5, (usableDur - totalSpeechDur) / gapDivisor);

        let cursor = speechFirst ? 0.0 : bachGap;
        const windows = [];
        for (const st of stanzas) {
          if (cursor + st.dur > effectiveDuration - 2.5) break;
          windows.push({ path: st.path, start: cursor, end: cursor + st.dur, dur: st.dur });
          cursor += st.dur + bachGap;
        }

        console.log(
          `🎚️  Interleaving ${windows.length} Kokoro stanzas over CONTINUOUS ducked music (${speechFirst ? 'Speech-First @ 0.00s' : 'Music-First'}, bed duck=${duckLevel}, tts gain=${ttsGain}):`
        );
        windows.forEach((w, idx) => {
          console.log(`   • Stanza ${idx + 1}: ${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s (${w.dur.toFixed(2)}s)`);
        });

        const inputs = [`-i "${refAudioPath}"`, ...windows.map(w => `-i "${w.path}"`)].join(' ');
        const duckExprs = windows.map(w => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`).join('+');

        let fg = `[0:a]${bachCleanFilter}${refPocketFilter},apad=whole_dur=${effectiveDuration},volume=${duckLevel}:enable='${duckExprs}':eval=frame[bach_ducked];`;
        const mixLabels = ['[bach_ducked]'];

        windows.forEach((w, idx) => {
          const inIdx = idx + 1;
          const delayMs = Math.round(w.start * 1000);
          const fadeOutSt = Math.max(0, w.dur - 0.08).toFixed(3);
          fg += `[${inIdx}:a]volume=${ttsGain},afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutSt}:d=0.08,adelay=${delayMs}|${delayMs}[st${idx}];`;
          mixLabels.push(`[st${idx}]`);
        });

        fg += `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,alimiter=limit=-1.2dB,afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;

        execSync(
          `ffmpeg -y ${inputs} -filter_complex "${fg}" -ar 48000 -ac 2 -t ${effectiveDuration} "${conformedRefPath}"`,
          { stdio: 'ignore' }
        );
      } else if (hasTtsGuide && !hasInstRef) {
        const ttsFilter = ttsMode === 'once'
          ? `[0:a]${ttsSilenceStrip},apad=pad_dur=${effectiveDuration},atrim=0:${effectiveDuration}`
          : `[0:a]${ttsSilenceStrip},apad=pad_dur=1.5,aloop=loop=-1:size=2e+09,afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;

        console.log(`🎙️ Staging PURE Kokoro speech from t=0s (${ttsMode})...`);
        execSync(
          `ffmpeg -y -i "${ttsAudioPath}" -filter_complex "${ttsFilter}" -ar 48000 -ac 2 -t ${effectiveDuration} "${conformedRefPath}"`,
          { stdio: 'ignore' }
        );
      } else {
        const filterChain = `${bachCleanFilter}${refPocketFilter},afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;
        console.log(`⚡ Conforming pure musical cover reference for [${selectedVoice.name}] (${effectiveDuration}s, cfg=${cfgScale}${refPocket ? ', temp ref-pocket ON' : ''})...`);
        execSync(
          `ffmpeg -y -i "${refAudioPath}" -af "${filterChain}" -ar 48000 -ac 2 -t ${effectiveDuration} "${conformedRefPath}"`,
          { stdio: 'ignore' }
        );
      }

      console.log(`📡 Staging reference audio into ComfyUI...`);
      const fileBuffer = fs.readFileSync(conformedRefPath);
      const formData = new FormData();
      formData.append('image', new Blob([fileBuffer]), path.basename(conformedRefPath));
      formData.append('overwrite', 'true');

      const uploadRes = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: formData });
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        stagedFilename = uploadData.name || path.basename(conformedRefPath);
        console.log(`✅ Staged audio in ComfyUI: "${stagedFilename}"`);
      } else {
        stagedFilename = path.basename(conformedRefPath);
      }
    }

    const { workflow } = patchWorkflow(baseWorkflow, {
      style: compositeStyle,
      lyrics: formattedLyrics,
      duration: effectiveDuration,
      seed: seed,
      stagedRefAudio: stagedFilename,
      cfgScale,
      samplerCfg
    });

    const payload = { client_id: "yue2_prod", prompt: workflow };
    const res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
    const { prompt_id } = await res.json();
    console.log(`Job Queued: ${prompt_id} [Mode: ${isCover ? (hasStanzas ? 'Cover+Kokoro' : 'Pure Musical Cover') : 'Text-to-Music'} | CFG: ${cfgScale} | Max Duration: ${effectiveDuration}s]`);

    let success = false;
    let outputInfo = {};
    const startTime = Date.now();

    while (Date.now() - startTime < 600000) {
      await new Promise(r => setTimeout(r, 3000));

      const historyRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
      const history = await historyRes.json();

      if (history[prompt_id]?.status?.status_str === 'error') {
        throw new Error("ComfyUI Node Error occurred during YuE2 generation.");
      }

      let foundAudio = null;
      let foundScore = null;

      const outputs = history[prompt_id]?.outputs || {};
      for (const nodeId in outputs) {
        const out = outputs[nodeId];

        if (out?.audio?.length > 0) {
          foundAudio = out.audio[0];
        }

        const candidates = out?.text || out?.string || [];
        for (const candidate of candidates) {
          const candidateStr = String(candidate).trim();
          if (isValidAbc(candidateStr)) {
            foundScore = candidateStr;
          }
        }
      }

      if (foundAudio) {
        const dlRes = await fetch(`${COMFY_URL}/view?filename=${foundAudio.filename}&subfolder=${foundAudio.subfolder}&type=${foundAudio.type}`);
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

        const savePath = path.join(OUTPUT_DIR, foundAudio.filename);
        const buffer = await dlRes.arrayBuffer();
        fs.writeFileSync(savePath, Buffer.from(buffer));

        const actualGeneratedDuration = probeAudioDurationSec(savePath, effectiveDuration);

        let abcFilename = null;
        let midiFilename = null;
        let midiReadyAbc = null;
        let trioAbcFilename = null;
        let trioAbcScore = '';

        if (foundScore) {
          const baseSlug = foundAudio.filename.replace(/\.[^.]+$/, '');
          abcFilename = `${baseSlug}.abc`;
          midiFilename = `${baseSlug}.mid`;
          trioAbcFilename = `${baseSlug}_trio.abc`;

          const rawAbcPath = path.join(OUTPUT_DIR, abcFilename);
          const rawMidiPath = path.join(OUTPUT_DIR, midiFilename);
          const rawTrioAbcPath = path.join(OUTPUT_DIR, trioAbcFilename);

          midiReadyAbc = foundScore.replace(/%%MIDI[^\r\n]*/g, '').trim();

          const v1Lines = midiReadyAbc.split('\n').filter(l => /^[ \t]*(\[?V:\s*1\b|[^V%A-Z:][^:]*\|)/.test(l));
          let barCount = 0;
          for (const line of v1Lines) {
            const matches = line.match(/\|/g);
            if (matches) barCount += matches.length;
          }

          const meterMatch = midiReadyAbc.match(/^[ \t]*M:\s*(\d+)\/(\d+)/m);
          const beatsPerBar = meterMatch ? (parseInt(meterMatch[1], 10) * (4 / parseInt(meterMatch[2], 10))) : 4;
          const totalBeats = Math.max(16, (barCount || 32) * beatsPerBar);

          let targetBpm = Math.round((totalBeats / actualGeneratedDuration) * 60);
          if (targetBpm < 60) targetBpm = 60;
          if (targetBpm > 180) targetBpm = 180;

          const globalHeaders = `%%MIDI gchord off\nQ: 1/4=${targetBpm}`;
          const v1Block = 'V:1 name="Vocal" snm="Vocal"\n%%MIDI channel 1\n%%MIDI program 73';
          const v2Block = 'V:2 name="Inst." snm="Inst."\n%%MIDI channel 2\n%%MIDI program 71';

          if (/^[ \t]*V:\s*1\b[^\r\n]*/m.test(midiReadyAbc)) {
            midiReadyAbc = midiReadyAbc.replace(/^[ \t]*V:\s*1\b[^\r\n]*/m, v1Block);
          }
          if (/^[ \t]*V:\s*2\b[^\r\n]*/m.test(midiReadyAbc)) {
            midiReadyAbc = midiReadyAbc.replace(/^[ \t]*V:\s*2\b[^\r\n]*/m, v2Block);
          }

          if (!midiReadyAbc.includes('%%MIDI program 73')) {
            if (/^[ \t]*K:[^\r\n]*/m.test(midiReadyAbc)) {
              midiReadyAbc = midiReadyAbc.replace(/(^[ \t]*K:[^\r\n]*)/m, `$1\n${globalHeaders}\n${v1Block}\n${v2Block}`);
            } else {
              midiReadyAbc = `${globalHeaders}\n${v1Block}\n${v2Block}\n${midiReadyAbc}`;
            }
          } else {
            midiReadyAbc = midiReadyAbc.replace(/(^[ \t]*K:[^\r\n]*)/m, `$1\n${globalHeaders}`);
          }

          fs.writeFileSync(rawAbcPath, midiReadyAbc, 'utf8');

          try {
            execSync(`abc2midi "${rawAbcPath}" -o "${rawMidiPath}"`, { stdio: 'pipe' });
          } catch (_) {}

          if (fs.existsSync(rawMidiPath)) {
            console.log(`🎹 Generated Wind Duo MIDI: ${midiFilename}`);

            try {
              execSync(`midi2abc "${rawMidiPath}" -o "${rawTrioAbcPath}"`, { stdio: 'pipe' });

              if (fs.existsSync(rawTrioAbcPath)) {
                let trioContent = fs.readFileSync(rawTrioAbcPath, 'utf8');

                trioContent = trioContent
                  .replace(/^T:\s*from images\/[^\r\n]*/m, 'T: Chamber Trio (Flute, Piano, Clarinet)')
                  .replace(/(^[ \t]*V:\s*1\b)[^\r\n]*/m, '$1 clef=treble name="Flute (73)" snm="Fl."')
                  .replace(/(^[ \t]*V:\s*2\b)[^\r\n]*/m, '$1 clef=bass name="Piano (0)" snm="Pno."')
                  .replace(/(^[ \t]*V:\s*3\b)[^\r\n]*/m, '$1 clef=treble name="Clarinet (71)" snm="Cl."');

                fs.writeFileSync(rawTrioAbcPath, trioContent, 'utf8');
                trioAbcScore = trioContent;
                console.log(`🎼 Generated Full Trio ABC Score with Staff Labels: ${trioAbcFilename}`);
              }
            } catch (m2aErr) {
              console.warn(`⚠️ midi2abc decompile failed: ${m2aErr.message}`);
            }
          } else {
            console.warn(`⚠️ abc2midi failed to create MIDI file: ${midiFilename}`);
          }

          const astroPublicDir = path.join(process.cwd(), 'site/public/images');
          if (fs.existsSync(astroPublicDir)) {
            try {
              if (fs.existsSync(rawAbcPath)) {
                fs.copyFileSync(rawAbcPath, path.join(astroPublicDir, abcFilename));
              }
              if (fs.existsSync(rawMidiPath)) {
                fs.copyFileSync(rawMidiPath, path.join(astroPublicDir, midiFilename));
                console.log(`📡 Mirrored MIDI to site/public/images/${midiFilename}`);
              }
              if (fs.existsSync(rawTrioAbcPath)) {
                fs.copyFileSync(rawTrioAbcPath, path.join(astroPublicDir, trioAbcFilename));
                console.log(`📡 Mirrored Trio ABC to site/public/images/${trioAbcFilename}`);
              }
            } catch (_) {}
          }
        }

        outputInfo = {
          savedFilePath: savePath,
          filename: foundAudio.filename,
          duration: actualGeneratedDuration,
          vocalProfile: selectedVoice.name,
          abcScore: midiReadyAbc || foundScore || '',
          abcFilename: abcFilename,
          midiFilename: (midiFilename && fs.existsSync(path.join(OUTPUT_DIR, midiFilename))) ? midiFilename : '',
          trioAbcFilename: (trioAbcFilename && fs.existsSync(path.join(OUTPUT_DIR, trioAbcFilename))) ? trioAbcFilename : '',
          trioAbcScore: trioAbcScore || ''
        };

        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        success = true;
        break;
      }
      process.stdout.write(".");
    }

    if (!success) throw new Error("Timeout: YuE2 generation exceeded limit.");

  } catch (e) {
    console.error(`\n❌ Run Failed: ${e.message}`);
    process.exit(1);
  } finally {
    if (conformedRefPath && fs.existsSync(conformedRefPath)) {
      try { fs.unlinkSync(conformedRefPath); } catch (_) {}
    }
  }
}

main();
