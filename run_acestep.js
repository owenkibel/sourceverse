import fs from 'fs';
import path from 'path';
import os from 'os';                 // <-- ADD THIS
import { execSync } from 'child_process'; // <-- ADD THIS

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

const CLASSICAL_VOICES = [
    {
        name: "Bass-Baritone",
        gender: "natural_male",
        tags: "deep rich dramatic operatic bass-baritone singing voice, classical theatrical resonance, robust chest voice low end, organic acoustic vibrato, purely natural dynamic production"
    },
    {
        name: "Mezzo-Soprano",
        gender: "natural_female",
        tags: "warm dark operatic mezzo-soprano vocal, early music classical singing style, full-bodied rich dramatic tone, expressive natural throat vibrato, pristine un-processed clarity"
    },
    {
        name: "Lyric Tenor",
        gender: "natural_male",
        tags: "bright soaring classical lyric tenor voice, elegant operatic articulation, clean baroque performance style, wide dynamic acoustic range, expressive fluid organic vibrato"
    },
    {
        name: "Dramatic Soprano",
        gender: "natural_female",
        tags: "powerful soaring operatic dramatic soprano vocal, classical chamber performance, clear crystalline singing tone, immaculate pitch control, rich natural vibrato"
    }
];

function buildPayload(styleTag, lyrics, seed, duration, selectedVoice, refAudioPath = null) {
    const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14); 
    const safeDuration = Math.ceil(duration / 16) * 16; 
    const cleanStyle = styleTag.split(',')[0].replace(/\[|\]/g, '').trim().substring(0, 50);

    // Verified 14-key natural scale pool
    const KEY_SCALES = [
        "C major", "D major", "E major", "F major", "G major", "A major", "B major",
        "C minor", "D minor", "E minor", "F minor", "G minor", "A minor", "B minor"
    ];
    const selectedKey = KEY_SCALES[Math.floor(Math.random() * KEY_SCALES.length)];
    const dynamicBpm = Math.floor(Math.random() * (135 - 105 + 1)) + 105; 

    console.log(`🎼 Generation Parameters: Key [${selectedKey}] | Tempo [${dynamicBpm} BPM]`);

    const nodes = {
        "18": {
            "inputs": { "samples": ["111", 0], "vae": ["106", 0] },
            "class_type": "VAEDecodeAudio"
        },
        "47": {
            "inputs": { "conditioning": ["94", 0] },
            "class_type": "ConditioningZeroOut"
        },
        "78": {
            "inputs": { "shift": 3, "model": ["104", 0] },
            "class_type": "ModelSamplingAuraFlow"
        },
        "94": {
            "inputs": {
              "tags": ["110", 0], 
              "lyrics": lyrics,
              "seed": seed,
              "bpm": dynamicBpm,            // Dynamic tempo (105-135 BPM)
              "duration": safeDuration,
              "timesignature": "4",
              "language": "en",
              "keyscale": selectedKey,      // Dynamic key scale
              "generate_audio_codes": true,
              "cfg_scale": 2.0,             // Restored for solid lyric adherence
              "temperature": 0.85,          // Restored to stable vocal-code token generation
              "top_p": 0.9,
              "top_k": 0,                   // Disabled to prevent code hallucination
              "min_p": 0,
              "clip": ["105", 0] 
            },
            "class_type": "TextEncodeAceStepAudio1.5"
          },
          "104": {
            "inputs": {
              "unet_name": "acestep_v1.5_xl_turbo_fp8_e4m3fn.safetensors",
              "weight_dtype": "default"
            },
            "class_type": "UNETLoader"
          },
          "105": {
            "inputs": {
              "clip_name1": "qwen_0.6b_ace15.safetensors",
              "clip_name2": "qwen_4b_ace15.safetensors",
              "type": "ace",
              "device": "default"
            },
            "class_type": "DualCLIPLoader"
          },
          "106": {
            "inputs": { "vae_name": "ace_1.5_vae.safetensors" },
            "class_type": "VAELoader"
          },
          "109": {
            "inputs": {
              "filename_prefix": `ACE_Step_4B_${selectedVoice.name.replace(/\s+/g, '_')}_${timeStamp}`, 
              "audio": ["18", 0]
            },
            "class_type": "SaveAudio"
          },
          "110": {
            "inputs": {
              "style": cleanStyle, 
              "extra": `${selectedVoice.tags}, masterfully mixed, high fidelity, pristine acoustic room spacing, wide stereo image, no modern pop processing`, 
              "voice_style": selectedVoice.gender 
            },
            "class_type": "AceStepPromptGen"
          }
    };

    if (refAudioPath && fs.existsSync(refAudioPath)) {
        console.log(`🔗 Injecting Audio Reference Track Nodes: ${refAudioPath}`);
        nodes["120"] = {
            "inputs": { "audio": refAudioPath },
            "class_type": "LoadAudio"
        };
        nodes["121"] = {
            "inputs": { "audio": ["120", 0], "vae": ["106", 0] },
            "class_type": "VAEEncodeAudio"
        };
        
        nodes["111"] = {
            "inputs": {
              "seed": seed, 
              "steps": 20,                   
              "cfg": 2.0, 
              "sampler_name": "euler",
              "scheduler": "simple",
              "denoise": 0.68,               // Balanced denoise for reference tracks
              "use_apg": true, 
              "use_cfg_rescale": false,
              "cfg_rescale_multiplier": 0.25,
              "enable_dynamic_cfg": true,
              "enable_latent_normalization": true,
              "use_vocoder": false,
              "noise_ema": 0.08,
              "noise_norm_threshold": 2,
              "anti_autotune_strength": 0.15, 
              "frequency_damping": 0.18,      // Restored for clean harmonic resonance
              "temporal_smoothing": 0.10,     
              "beat_stability": 0.50,        // Restored for steady vocal rhythm
              "enable_quality_check": false,
              "model": ["78", 0],
              "positive": ["94", 0],
              "negative": ["47", 0],
              "latent": ["121", 0] 
            },
            "class_type": "AceStepKSampler"
        };
    } else {
        nodes["98"] = {
            "inputs": { "seconds": safeDuration, "batch_size": 1 },
            "class_type": "EmptyAceStep1.5LatentAudio"
        };
        nodes["111"] = {
            "inputs": {
              "seed": seed, 
              "steps": 20, 
              "cfg": 2.0, 
              "sampler_name": "euler",
              "scheduler": "simple",
              "denoise": 1.0, 
              "use_apg": true, 
              "use_cfg_rescale": false,
              "cfg_rescale_multiplier": 0.25,
              "enable_dynamic_cfg": true,
              "enable_latent_normalization": true,
              "use_vocoder": false,
              "noise_ema": 0.08,
              "noise_norm_threshold": 2,
              "anti_autotune_strength": 0.15,
              "frequency_damping": 0.18,      // Restored for clean harmonic resonance
              "temporal_smoothing": 0.10,     
              "beat_stability": 0.50,        // Restored for steady vocal rhythm
              "enable_quality_check": false,
              "model": ["78", 0],
              "positive": ["94", 0],
              "negative": ["47", 0],
              "latent": ["98", 0]
            },
            "class_type": "AceStepKSampler"
        };
    }

    return { "client_id": "acestep_4b_prod", "prompt": nodes };
}

async function main() {
    // 1. Declare the variable here at the top level of the function scope
    let conformedRefPath = null; 

    try {
        console.log("--- Starting ACE-Step 4B Generation ---");
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'acestep_state.json';
        
        const tagsIndex = args.findIndex(a => a === '--tags');
        const tags = tagsIndex !== -1 ? args[tagsIndex + 1] : "Celtic Folk";
        
        const lyricsIndex = args.findIndex(a => a === '--lyrics');
        const lyrics = lyricsIndex !== -1 ? args[lyricsIndex + 1] : "";

        const durationIndex = args.findIndex(a => a === '--duration');
        const duration = durationIndex !== -1 ? parseInt(args[durationIndex + 1], 10) : 96;

        const refAudioIndex = args.findIndex(a => a === '--ref-audio');
        const refAudioPath = refAudioIndex !== -1 ? args[refAudioIndex + 1] : null;

        const seed = Math.floor(Math.random() * 1000000000);

        // =========================================================================
        // AUDIO CONFORMANCE INTERCEPTOR
        // =========================================================================
        const safeDuration = Math.ceil(duration / 16) * 16;
        let finalRefPath = refAudioPath;
        
        // 2. REMOVE the 'let' keyword from here so it updates the top-scoped variable
        if (refAudioPath && fs.existsSync(refAudioPath)) {
            conformedRefPath = path.join(os.tmpdir(), `acestep_conformed_${Date.now()}.flac`);
            console.log(`⚡ Conforming reference track to exactly ${safeDuration}s at 48kHz...`);
            try {
                // Pad with silence if short, truncate if long, force 48kHz stereo
                execSync(`ffmpeg -y -i "${refAudioPath}" -ar 48000 -ac 2 -af "apad" -t ${safeDuration} "${conformedRefPath}"`, { stdio: 'ignore' });
                finalRefPath = conformedRefPath;
            } catch (err) {
                console.error(`⚠️ Conformance failed: ${err.message}. Falling back to raw file.`);
            }
        }

// =========================================================================
        // ROBUST VOCAL PROFILE ROUTING (Word-boundary safe)
        // =========================================================================
        let selectedVoice = CLASSICAL_VOICES[1]; // Default fallback: Mezzo-Soprano (natural_female)
        const lowerTags = tags.toLowerCase();

        if (lowerTags.includes('baritone') || lowerTags.includes('bass')) {
            selectedVoice = CLASSICAL_VOICES[0]; // Bass-Baritone (natural_male)
        } else if (lowerTags.includes('dramatic soprano')) {
            selectedVoice = CLASSICAL_VOICES[3]; // Dramatic Soprano (natural_female)
        } else if (lowerTags.includes('mezzo') || lowerTags.includes('soprano') || (/\bfemale\b/.test(lowerTags) && !/\bmale\b/.test(lowerTags))) {
            selectedVoice = CLASSICAL_VOICES[1]; // Mezzo-Soprano (natural_female)
        } else if (lowerTags.includes('tenor') || /\bmale\b/.test(lowerTags)) {
            selectedVoice = CLASSICAL_VOICES[2]; // Lyric Tenor (natural_male)
        }

        console.log(`🎭 Selected Vocal Profile: ${selectedVoice.name} -> Routing as [${selectedVoice.gender}]`);

        // CHANGED: Pass finalRefPath instead of refAudioPath
        const payload = buildPayload(tags, lyrics, seed, duration, selectedVoice, finalRefPath);
        
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
        const responseData = await res.json();
        const promptId = responseData.prompt_id;
        console.log(`Job Queued: ${promptId}`);

        let success = false;
        let outputInfo = {};
        const startTime = Date.now();
        
        while (Date.now() - startTime < 300000) {
            await new Promise(r => setTimeout(r, 2000)); 
            
            const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
            const history = await historyRes.json();
            
            if (history[promptId]?.status?.status_str === 'error') {
                throw new Error("ComfyUI Node Error occurred during generation.");
            }

            let foundAudio = null;
            const outputs = history[promptId]?.outputs || {};
            for (const nodeId in outputs) {
                if (outputs[nodeId]?.audio?.length > 0) {
                    foundAudio = outputs[nodeId].audio[0];
                    break;
                }
            }
            
            if (foundAudio) {
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${foundAudio.filename}&subfolder=${foundAudio.subfolder}&type=${foundAudio.type}`);
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                
                const savePath = path.join(OUTPUT_DIR, foundAudio.filename);
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                
                outputInfo = { savedFilePath: savePath, filename: foundAudio.filename, vocalProfile: selectedVoice.name };
                console.log(`\n✅ Success! Audio saved to ${savePath}`);
                success = true;
                break;
            }
            process.stdout.write(".");
        }
if (!success) throw new Error("Timeout: ACE-Step 4B generation took too long.");
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));

    } catch (e) {
        console.error(`\n❌ Run Failed: ${e.message}`);
        process.exit(1);
    } finally {
        // CLEANUP: Wipe the temporary conformed flac file if it exists
        if (conformedRefPath && fs.existsSync(conformedRefPath)) {
            try { fs.unlinkSync(conformedRefPath); } catch (_) {}
        }
    }
}

main();