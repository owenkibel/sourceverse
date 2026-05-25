import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// Standard nodes for a single-speaker Whisper clone
const NODE_LOAD_AUDIO = "10"; 
const NODE_WHISPER = "11";
const NODE_OMNIVOICE = "12";
const NODE_SAVE_AUDIO = "13";

// 1. Build Payload for a SINGLE stanza
function buildPayload(text, voiceAudio, index, timeStamp) {
    return {
        "client_id": "omnivoice_chunked",
        "prompt": {
            [NODE_LOAD_AUDIO]: {
                "class_type": "LoadAudio",
                "inputs": { "audio": voiceAudio }
            },
            [NODE_WHISPER]: {
                "class_type": "OmniVoiceWhisperLoader",
                "inputs": {
                    "model": "whisper-large-v3-turbo (auto-download)",
                    "device": "auto",
                    "dtype": "fp16"
                }
            },
            [NODE_OMNIVOICE]: {
                "class_type": "OmniVoiceVoiceCloneTTS",
                "inputs": {
                    "model": "OmniVoice-bf16",
                    "text": text,
                    "ref_text": "", // Whisper will auto-transcribe the reference
                    "steps": 32,
                    "guidance_scale": 2.0,
                    "t_shift": 0.1,
                    "speed": 1.0,
                    "duration": 0.0,
                    "device": "auto",
                    "dtype": "auto",
                    "attention": "auto",
                    "seed": Math.floor(Math.random() * 1000000000), // Random variance
                    "position_temperature": 5.0,
                    "class_temperature": 0.0,
                    "layer_penalty_factor": 5.0,
                    "denoise": true,
                    "preprocess_prompt": true,
                    "postprocess_output": true,
                    // CRITICAL: Keep model loaded between stanzas for speed
                    "keep_model_loaded": true, 
                    "instruct": "",
                    "ref_audio": [NODE_LOAD_AUDIO, 0],
                    "whisper_model": [NODE_WHISPER, 0]
                }
            },
            [NODE_SAVE_AUDIO]: {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `Omni_Stanza_${index}_${timeStamp}`,
                    "audio": [NODE_OMNIVOICE, 0]
                }
            }
        }
    };
}

// 2. Generate and download a single stanza
async function generateStanza(text, voiceAudio, index, timeStamp) {
    const payload = buildPayload(text, voiceAudio, index, timeStamp);
    
    const res = await fetch(`${COMFY_URL}/prompt`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
    });
    
    if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
    const responseData = await res.json();
    const promptId = responseData.prompt_id;
    
    let success = false;
    const startTime = Date.now();
    let savedPath = "";

    // OmniVoice is heavier than Kokoro; allow 5 mins per stanza
    while (Date.now() - startTime < 300000) { 
        await new Promise(r => setTimeout(r, 2000)); 
        const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
        const history = await historyRes.json();
        
        if (history[promptId]?.outputs?.[NODE_SAVE_AUDIO]?.audio?.length > 0) {
            const file = history[promptId].outputs[NODE_SAVE_AUDIO].audio[0];
            const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
            
            if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            
            savedPath = path.join(OUTPUT_DIR, file.filename);
            const buffer = await dlRes.arrayBuffer();
            fs.writeFileSync(savedPath, Buffer.from(buffer));
            
            success = true;
            break;
        }
        if (history[promptId]?.status?.status_str === 'error') throw new Error("ComfyUI Node Error");
    }
    
    if (!success) throw new Error(`Timeout generating stanza ${index + 1}`);
    return savedPath;
}

// 3. Main Orchestrator
async function main() {
    try {
        console.log("--- Starting OmniVoice Chunked & Panned TTS ---");
        
        const args = process.argv.slice(2);
        
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';

        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        const refAudio1Index = args.findIndex(a => a === '--ref-audio1');
        const audioVoice1 = refAudio1Index !== -1 ? args[refAudio1Index + 1] : 'owen_anchor.wav';

        const refAudio2Index = args.findIndex(a => a === '--ref-audio2');
        const audioVoice2 = refAudio2Index !== -1 ? args[refAudio2Index + 1] : 'F5TTS_test_en_1_ref_short.deep.wav';

        if (!fs.existsSync(promptFilePath)) throw new Error(`${promptFilePath} not found`);
        
        let poemText = fs.readFileSync(promptFilePath, 'utf8');
        
        // Split by double-newlines to isolate stanzas
        const stanzas = poemText.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
        if (stanzas.length === 0) throw new Error("Poem file is empty.");

        console.log(`📜 Found ${stanzas.length} stanzas. Generating voices...`);

        const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const generatedFiles = [];

        // Generate the stanzas sequentially
        for (let i = 0; i < stanzas.length; i++) {
            // Alternate voices based on even/odd index
            const currentVoice = (i % 2 === 0) ? audioVoice1 : audioVoice2;
            
            process.stdout.write(`   🗣️  Generating Stanza ${i + 1} (${currentVoice})... `);
            // Replace internal newlines so OmniVoice reads fluidly
            const flatStanza = stanzas[i].replace(/\n/g, ' '); 
            
            const filePath = await generateStanza(flatStanza, currentVoice, i, timeStamp);
            generatedFiles.push(filePath);
            console.log(`Done.`);
        }

        console.log(`\n🎵 Panning and Stitching ${generatedFiles.length} stanzas into stereo...`);
        
        const finalFilename = `OmniVoice_Alternating_${timeStamp}.flac`;
        const finalFilePath = path.join(OUTPUT_DIR, finalFilename);

        let ffmpegArgs = ['-y'];
        generatedFiles.forEach(f => ffmpegArgs.push('-i', f));

        // Add 1.5 seconds of generated stereo silence to protect the tail
        ffmpegArgs.push('-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=channel_layout=stereo:sample_rate=24000');

        let filterGraph = '';
        let concatLabels = '';

        // Spatial panning filter
        for (let i = 0; i < generatedFiles.length; i++) {
            const isVoice1 = (i % 2 === 0);
            const panL = isVoice1 ? '0.8' : '0.2';
            const panR = isVoice1 ? '0.2' : '0.8';

            filterGraph += `[${i}:a]pan=stereo|c0=${panL}*c0|c1=${panR}*c0[a${i}];`;
            concatLabels += `[a${i}]`;
        }

        const silenceIdx = generatedFiles.length;
        concatLabels += `[${silenceIdx}:a]`;
        filterGraph += `${concatLabels}concat=n=${generatedFiles.length + 1}:v=0:a=1[final_out]`;

        await execFileAsync('ffmpeg', [
            ...ffmpegArgs,
            '-filter_complex', filterGraph,
            '-map', '[final_out]',
            '-c:a', 'flac',
            finalFilePath
        ]);

        // Clean up the temporary individual line files
        for (const f of generatedFiles) {
            fs.unlinkSync(f);
        }

        // Hand the final stitched file back to the main thread
        const outputInfo = { savedFilePath: finalFilePath, filename: finalFilename };
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        
        console.log(`✅ Success! Final alternating track saved to ${stateFilePath}`);

    } catch (e) {
        console.error(`\n❌ Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();