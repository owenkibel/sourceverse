// run_yue.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";
const WORKFLOWS_DIR = "./workflows";

const CLASSICAL_VOICES = [
  {
    name: "Bass-Baritone",
    gender: "male",
    stylePrompt: "warm resonant bass-baritone male vocals, rich theatrical presence, natural dynamic acoustic space"
  },
  {
    name: "Mezzo-Soprano",
    gender: "female",
    stylePrompt: "warm dark operatic mezzo-soprano vocal, rich early music tone, pristine un-processed clarity"
  },
  {
    name: "Lyric Tenor",
    gender: "male",
    stylePrompt: "bright soaring classical lyric tenor voice, elegant articulation, clean baroque performance"
  },
  {
    name: "Dramatic Soprano",
    gender: "female",
    stylePrompt: "powerful soaring operatic dramatic soprano vocal, classical chamber performance, clear crystalline tone"
  }
];

// Add at the top or helpers section of run_yue.js
function isValidAbc(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  // Standard ABC notation starts with X: and contains meter/key headers or measures
  return (/^X:\s*\d+/m.test(trimmed) || trimmed.includes('K:') || trimmed.includes('M:') || trimmed.includes('|'));
}

function sanitizeLyrics(lyrics) {
  if (!lyrics || !lyrics.trim()) return "[Instrumental]";
  let cleaned = lyrics.trim();
  // Ensure YuE2 has structural tags for proper autoregressive alignment
  if (!cleaned.includes('[')) {
    cleaned = `[Verse]\n${cleaned}`;
  }
  return cleaned;
}

// Inside patchWorkflow(): Auto-tap the ABC generator into a built-in PreviewAny node
function patchWorkflow(workflow, { style, lyrics, duration, seed, stagedRefAudio = null }) {
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

    if (stagedRefAudio && (node.class_type === 'LoadAudio' || 'audio' in node.inputs)) {
      if (typeof node.inputs.audio === 'string') {
        node.inputs.audio = stagedRefAudio;
        patchedAudio = true;
      }
    }
  }

  // Inject ComfyUI core PreviewAny node to tap the ABC score string into history outputs
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

    const stateFileIndex = args.findIndex(a => a === '--state-file');
    const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'yue_state.json';

    const tagsIndex = args.findIndex(a => a === '--tags');
    const tags = tagsIndex !== -1 ? args[tagsIndex + 1] : "Folk, Americana";

    const lyricsIndex = args.findIndex(a => a === '--lyrics');
    const rawLyrics = lyricsIndex !== -1 ? args[lyricsIndex + 1] : "";

    const durationIndex = args.findIndex(a => a === '--duration');
    const duration = durationIndex !== -1 ? parseInt(args[durationIndex + 1], 10) : 128;

    const refAudioIndex = args.findIndex(a => a === '--ref-audio');
    const refAudioPath = refAudioIndex !== -1 ? args[refAudioIndex + 1] : null;

    const seed = Math.floor(Math.random() * 1000000000);

    // 1. Select Vocal Profile
    let selectedVoice = CLASSICAL_VOICES[1];
    const lowerTags = tags.toLowerCase();
    if (lowerTags.includes('baritone') || lowerTags.includes('bass')) {
      selectedVoice = CLASSICAL_VOICES[0];
    } else if (lowerTags.includes('dramatic soprano')) {
      selectedVoice = CLASSICAL_VOICES[3];
    } else if (lowerTags.includes('tenor')) {
      selectedVoice = CLASSICAL_VOICES[2];
    }

    const compositeStyle = `${tags}, ${selectedVoice.stylePrompt}, masterfully mixed, 48kHz stereo, high fidelity`;
    const formattedLyrics = sanitizeLyrics(rawLyrics);

    // 2. Choose Workflow File (Cover vs Text-to-Music)
    const isCover = Boolean(refAudioPath && fs.existsSync(refAudioPath));
    const workflowFile = isCover
      ? path.join(WORKFLOWS_DIR, 'yue2_cover_api.json')
      : path.join(WORKFLOWS_DIR, 'yue2_text_to_music_api.json');

    if (!fs.existsSync(workflowFile)) {
      throw new Error(`Required ComfyUI API template not found: ${workflowFile}. Please export it from ComfyUI first.`);
    }

    const baseWorkflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));

    // 3. Stage Reference Audio if present
    if (isCover) {
      conformedRefPath = path.join(os.tmpdir(), `yue_ref_${Date.now()}.flac`);
      console.log(`⚡ Conforming reference track to 48kHz stereo FLAC...`);
      execSync(`ffmpeg -y -i "${refAudioPath}" -ar 48000 -ac 2 -t ${duration} "${conformedRefPath}"`, { stdio: 'ignore' });

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

    // 4. Inject runtime parameters
    const { workflow } = patchWorkflow(baseWorkflow, {
      style: compositeStyle,
      lyrics: formattedLyrics,
      duration: duration,
      seed: seed,
      stagedRefAudio: stagedFilename
    });

    // 5. Submit to ComfyUI
    const payload = { client_id: "yue2_prod", prompt: workflow };
    const res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
    const { prompt_id } = await res.json();
    console.log(`Job Queued: ${prompt_id} [Mode: ${isCover ? 'Cover' : 'Text-to-Music'}]`);

    // 6. Poll for output audio
    let success = false;
    let outputInfo = {};
    const startTime = Date.now();

    while (Date.now() - startTime < 600000) { // 10 minute timeout for autoregressive rollout
      await new Promise(r => setTimeout(r, 3000));

      const historyRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
      const history = await historyRes.json();

      if (history[prompt_id]?.status?.status_str === 'error') {
        throw new Error("ComfyUI Node Error occurred during YuE2 generation.");
      }

// In the polling loop of run_yue.js
      let foundAudio = null;
      let foundScore = null;

      const outputs = history[prompt_id]?.outputs || {};
      for (const nodeId in outputs) {
        const out = outputs[nodeId];
        
        // 1. Capture rendered FLAC
        if (out?.audio?.length > 0) {
          foundAudio = out.audio[0];
        }

        // 2. Capture validated ABC notation only
        const candidates = out?.text || out?.string || [];
        for (const candidate of candidates) {
          const str = String(candidate).trim();
          if (isValidAbc(str)) {
            foundScore = str;
          }
        }
      }

      if (foundAudio) {
        const dlRes = await fetch(`${COMFY_URL}/view?filename=${foundAudio.filename}&subfolder=${foundAudio.subfolder}&type=${foundAudio.type}`);
        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

        const savePath = path.join(OUTPUT_DIR, foundAudio.filename);
        const buffer = await dlRes.arrayBuffer();
        fs.writeFileSync(savePath, Buffer.from(buffer));

        let abcFilename = null;
        let midiFilename = null;

        if (foundScore) {
          const baseSlug = foundAudio.filename.replace(/\.[^.]+$/, '');
          abcFilename = `${baseSlug}.abc`;
          midiFilename = `${baseSlug}.mid`;

          const rawAbcPath = path.join(OUTPUT_DIR, abcFilename);
          const rawMidiPath = path.join(OUTPUT_DIR, midiFilename);

          fs.writeFileSync(rawAbcPath, foundScore, 'utf8');

          try {
            // Run abc2midi and output errors if conversion fails
            execSync(`abc2midi "${rawAbcPath}" -o "${rawMidiPath}"`, { stdio: 'pipe' });
            console.log(`🎹 Generated MIDI file: ${midiFilename}`);
          } catch (midiErr) {
            console.warn(`⚠️ abc2midi conversion failed: ${midiErr.message}`);
          }

          // Mirror directly to Astro's public directory
          const astroPublicDir = path.join(process.cwd(), 'site/public/images');
          if (fs.existsSync(astroPublicDir)) {
            try {
              fs.copyFileSync(rawAbcPath, path.join(astroPublicDir, abcFilename));
              if (fs.existsSync(rawMidiPath)) {
                fs.copyFileSync(rawMidiPath, path.join(astroPublicDir, midiFilename));
                console.log(`📡 Mirrored MIDI to site/public/images/${midiFilename}`);
              }
            } catch (_) {}
          }
        }

        outputInfo = { 
          savedFilePath: savePath, 
          filename: foundAudio.filename, 
          vocalProfile: selectedVoice.name,
          abcScore: foundScore || '',
          abcFilename: abcFilename,
          midiFilename: (midiFilename && fs.existsSync(path.join(OUTPUT_DIR, midiFilename))) ? midiFilename : ''
        };
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        success = true;
        break;
      }
      process.stdout.write(".");
    }

    if (!success) throw new Error("Timeout: YuE2 generation exceeded limit.");
    fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));

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