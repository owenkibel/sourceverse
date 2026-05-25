import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// // The extracted US and GB voices
// const ALL_VOICES = [
//   "🇺🇸 🚺 Heart ❤️", "🇺🇸 🚺 Bella 🔥", "🇺🇸 🚺 Nicole 🎧", "🇺🇸 🚺 Aoede 🎵", "🇺🇸 🚺 Kore", 
//   "🇺🇸 🚺 Sarah", "🇺🇸 🚺 Nova ⭐", "🇺🇸 🚺 Sky ☁️", "🇺🇸 🚺 Alloy", "🇺🇸 🚺 Jessica", "🇺🇸 🚺 River 🌊", 
//   "🇺🇸 🚹 Michael", "🇺🇸 🚹 Fenrir 🐺", "🇺🇸 🚹 Puck 🎭", "🇺🇸 🚹 Echo 🔊", "🇺🇸 🚹 Eric", 
//   "🇺🇸 🚹 Liam", "🇺🇸 🚹 Onyx 💎", "🇺🇸 🚹 Adam", "🇺🇸 🚹 Santa 🎅", 
//   "🇬🇧 🚺 Emma", "🇬🇧 🚺 Isabella", "🇬🇧 🚺 Alice 📚", "🇬🇧 🚺 Lily 🌸", 
//   "🇬🇧 🚹 George", "🇬🇧 🚹 Fable 📖", "🇬🇧 🚹 Lewis", "🇬🇧 🚹 Daniel"
// ];

// The extracted US, GB, and IN voices
const ALL_VOICES = [
  "🇺🇸 🚺 Heart ❤️", "🇺🇸 🚺 Bella 🔥", "🇺🇸 🚺 Nicole 🎧", "🇺🇸 🚺 Aoede 🎵", "🇺🇸 🚺 Kore", 
  "🇺🇸 🚺 Sarah", "🇺🇸 🚺 Nova ⭐", "🇺🇸 🚺 Sky ☁️", "🇺🇸 🚺 Alloy", "🇺🇸 🚺 Jessica", "🇺🇸 🚺 River 🌊", 
  "🇺🇸 🚹 Michael", "🇺🇸 🚹 Fenrir 🐺", "🇺🇸 🚹 Puck 🎭", "🇺🇸 🚹 Echo 🔊", "🇺🇸 🚹 Eric", 
  "🇺🇸 🚹 Liam", "🇺🇸 🚹 Onyx 💎", "🇺🇸 🚹 Adam", "🇺🇸 🚹 Santa 🎅", 
  "🇬🇧 🚺 Emma", "🇬🇧 🚺 Isabella", "🇬🇧 🚺 Alice 📚", "🇬🇧 🚺 Lily 🌸", 
  "🇬🇧 🚹 George", "🇬🇧 🚹 Fable 📖", "🇬🇧 🚹 Lewis", "🇬🇧 🚹 Daniel",
  "🇮🇳 🚺 Alpha α", "🇮🇳 🚺 Beta β", "🇮🇳 🚹 Omega Ω", "🇮🇳 🚹 Psi Ψ"
];

let lastVoice = "";

// Randomly cast a new voice, ensuring it never repeats the previous one
function getNextVoice() {
    // Filter out the voice that just spoke
    const availableVoices = ALL_VOICES.filter(v => v !== lastVoice);
    
    // Pick a random voice from the remaining pool
    const chosenVoice = availableVoices[Math.floor(Math.random() * availableVoices.length)];
    
    // Save it for the next round
    lastVoice = chosenVoice;
    return chosenVoice;
}

// Build the payload for a single line
function buildPayload(text, voice, index, timeStamp) {
    return {
        "client_id": "kokoro_tts_prod",
        "prompt": {
            "1": {
                "class_type": "GeekyKokoroTTS",
                "inputs": {
                    "text": text,
                    "voice": voice,
                    "speed": 1.0,
                    "use_gpu": true,
                    "enable_blending": false // Blending is strictly OFF for this experiment
                }
            },
            "3": {
                "class_type": "SaveAudio",
                "inputs": {
                    "filename_prefix": `Kokoro_Line_${index}_${timeStamp}`,
                    "audio": ["1", 0]
                }
            }
        }
    };
}

// Generate and download a single line of audio
async function generateLine(text, voice, index, timeStamp) {
    const payload = buildPayload(text, voice, index, timeStamp);
    
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

    // Wait up to 60 seconds per line
    while (Date.now() - startTime < 60000) { 
        await new Promise(r => setTimeout(r, 1000)); 
        const historyRes = await fetch(`${COMFY_URL}/history/${promptId}`);
        const history = await historyRes.json();
        
        if (history[promptId]?.outputs?.["3"]?.audio?.length > 0) {
            const file = history[promptId].outputs["3"].audio[0];
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
    
    if (!success) throw new Error(`Timeout generating line ${index + 1}`);
    return savedPath;
}

async function main() {
    try {
        console.log("--- Starting Kokoro Alternating TTS ---");
        
        const args = process.argv.slice(2);
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFilePath = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'tts_state.json';
        const promptFileIndex = args.findIndex(a => a === '--prompt-file');
        const promptFilePath = promptFileIndex !== -1 ? args[promptFileIndex + 1] : 'poem.txt';

        if (!fs.existsSync(promptFilePath)) throw new Error(`${promptFilePath} not found`);
        
        let poemText = fs.readFileSync(promptFilePath, 'utf8');
        
        // Split by double-newlines (or multiple whitespace) to isolate stanzas
        const stanzas = poemText.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
        if (stanzas.length === 0) throw new Error("Poem file is empty.");

        console.log(`📜 Found ${stanzas.length} stanzas. Casting voices...`);

        const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const generatedFiles = [];

        // Generate the stanzas sequentially
        for (let i = 0; i < stanzas.length; i++) {
            const currentVoice = getNextVoice();
            
            // Extract just the emoji and name for a cleaner terminal log
            const shortName = currentVoice.split(' ').slice(0, 3).join(' ');
            process.stdout.write(`   🗣️  Generating Stanza ${i + 1} (${shortName})... `);
            
            const filePath = await generateLine(stanzas[i], currentVoice, i, timeStamp);
            generatedFiles.push(filePath);
            console.log(`Done.`);
        }

    console.log(`\n🎵 Panning and Stitching ${generatedFiles.length} stanzas into stereo...`);
        
        const finalFilename = `Kokoro_Alternating_${timeStamp}.flac`;
        const finalFilePath = path.join(OUTPUT_DIR, finalFilename);

        // 1. Build the dynamic FFmpeg arguments array
        let ffmpegArgs = ['-y'];
        
        // Add all our generated voice files as inputs
        generatedFiles.forEach(f => {
            ffmpegArgs.push('-i', f);
        });

        // Add ONE MORE input: 1.5 seconds of generated stereo silence to protect the tail
        ffmpegArgs.push('-f', 'lavfi', '-t', '1.5', '-i', 'anullsrc=channel_layout=stereo:sample_rate=24000');

        let filterGraph = '';
        let concatLabels = '';

        // 2. Build the spatial panning filter for each file
        for (let i = 0; i < generatedFiles.length; i++) {
            // Voice 1 (Odd stanzas, index 0, 2) -> Panned 80% Left, 20% Right
            // Voice 2 (Even stanzas, index 1, 3) -> Panned 20% Left, 80% Right
            const isVoice1 = (i % 2 === 0);
            const panL = isVoice1 ? '0.8' : '0.2';
            const panR = isVoice1 ? '0.2' : '0.8';

            // Kokoro is Mono (c0). We push it to Stereo (c0 and c1) at our target percentages
            filterGraph += `[${i}:a]pan=stereo|c0=${panL}*c0|c1=${panR}*c0[a${i}];`;
            concatLabels += `[a${i}]`;
        }

        // Add our silence track (which is the very last input index) to the end of the concat chain
        const silenceIdx = generatedFiles.length;
        concatLabels += `[${silenceIdx}:a]`;

        // 3. Concatenate all panned tracks + the silence tail
        filterGraph += `${concatLabels}concat=n=${generatedFiles.length + 1}:v=0:a=1[final_out]`;

        // 4. Execute the complex graph
        await execFileAsync('ffmpeg', [
            ...ffmpegArgs,
            '-filter_complex', filterGraph,
            '-map', '[final_out]',
            '-c:a', 'flac', // Re-encode cleanly to FLAC
            finalFilePath
        ]);

        // Clean up the temporary individual line files
        for (const f of generatedFiles) {
            fs.unlinkSync(f);
        }

        // Hand the final stitched file back to the main thread
        const outputInfo = { savedFilePath: finalFilePath, filename: finalFilename };
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        
        console.log(`✅ Success! Final alternating track ready.`);

    } catch (e) {
        console.error(`\n❌ Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();