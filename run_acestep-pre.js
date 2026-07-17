import fs from 'fs';
import path from 'path';

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

    // Baseline execution nodes common to both structural approaches
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
              "bpm": 190, 
              "duration": safeDuration,
              "timesignature": "4",
              "language": "en",
              "keyscale": "E minor",
              "generate_audio_codes": true,
              "cfg_scale": 2,
              "temperature": 0.85,
              "top_p": 0.9,
              "top_k": 0,
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

    // Dynamic Latent Routing: Fork execution pipeline structure based on reference payload data
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
        
        // Connect VAEEncode output to the KSampler and drop denoise to permit styling modifications
        nodes["111"] = {
            "inputs": {
              "seed": seed, 
              "steps": 20, 
              "cfg": 2.0, 
              "sampler_name": "euler",
              "scheduler": "simple",
              "denoise": 0.65, // <-- Lowered to allow the reference audio structure to shine through
              "use_apg": true, 
              "use_cfg_rescale": false,
              "cfg_rescale_multiplier": 0.25,
              "enable_dynamic_cfg": true,
              "enable_latent_normalization": true,
              "use_vocoder": false,
              "noise_ema": 0.08,
              "noise_norm_threshold": 2,
              "anti_autotune_strength": 0.15,
              "frequency_damping": 0.18,      
              "temporal_smoothing": 0.1,     
              "beat_stability": 0.5,
              "enable_quality_check": false,
              "model": ["78", 0],
              "positive": ["94", 0],
              "negative": ["47", 0],
              "latent": ["121", 0] // <-- Routed from Audio Encoder
            },
            "class_type": "AceStepKSampler"
        };
    } else {
        console.log("💨 No reference track requested. Generating empty space baseline matrix.");
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
              "frequency_damping": 0.18,      
              "temporal_smoothing": 0.1,     
              "beat_stability": 0.5,
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

        let selectedVoice = CLASSICAL_VOICES[1]; 
        const lowerTags = tags.toLowerCase();
        if (lowerTags.includes('baritone') || (lowerTags.includes('male') && lowerTags.includes('bass'))) {
            selectedVoice = CLASSICAL_VOICES[0]; 
        } else if (lowerTags.includes('tenor') || lowerTags.includes('male')) {
            selectedVoice = CLASSICAL_VOICES[2]; 
        } else if (lowerTags.includes('soprano') && lowerTags.includes('dramatic')) {
            selectedVoice = CLASSICAL_VOICES[3]; 
        } else if (lowerTags.includes('soprano') || lowerTags.includes('female')) {
            selectedVoice = CLASSICAL_VOICES[1]; 
        }

        console.log(`🎭 Selected Vocal Profile: ${selectedVoice.name} -> Routing as [${selectedVoice.gender}]`);

        const payload = buildPayload(tags, lyrics, seed, duration, selectedVoice, refAudioPath);
        
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
    }
}

main();