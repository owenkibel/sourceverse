import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import util from 'util';

const execFileAsync = util.promisify(execFile);
const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// The extracted US and GB voices
const ALL_VOICES = [
  "🇺🇸 🚺 Heart ❤️", "🇺🇸 🚺 Bella 🔥", "🇺🇸 🚺 Nicole 🎧", "🇺🇸 🚺 Aoede 🎵", "🇺🇸 🚺 Kore", 
  "🇺🇸 🚺 Sarah", "🇺🇸 🚺 Nova ⭐", "🇺🇸 🚺 Sky ☁️", "🇺🇸 🚺 Alloy", "🇺🇸 🚺 Jessica", "🇺🇸 🚺 River 🌊", 
  "🇺🇸 🚹 Michael", "🇺🇸 🚹 Fenrir 🐺", "🇺🇸 🚹 Puck 🎭", "🇺🇸 🚹 Echo 🔊", "🇺🇸 🚹 Eric", 
  "🇺🇸 🚹 Liam", "🇺🇸 🚹 Onyx 💎", "🇺🇸 🚹 Adam", "🇺🇸 🚹 Santa 🎅", 
  "🇬🇧 🚺 Emma", "🇬🇧 🚺 Isabella", "🇬🇧 🚺 Alice 📚", "🇬🇧 🚺 Lily 🌸", 
  "🇬🇧 🚹 George", "🇬🇧 🚹 Fable 📖", "🇬🇧 🚹 Lewis", "🇬🇧 🚹 Daniel"
];

// Randomly cast an opposite-gender duo
function getRandomVoices() {
    const males = ALL_VOICES.filter(v => v.includes('🚹'));
    const females = ALL_VOICES.filter(v => v.includes('🚺'));

    // Flip a coin to see which gender reads the odd lines
    const maleFirst = Math.random() > 0.5;
    const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
    
    const voice1 = maleFirst ? randomItem(males) : randomItem(females);
    const voice2 = maleFirst ? randomItem(females) : randomItem(males);
    
    return { voice1, voice2 };
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
        
        // Strip out empty lines so the back-and-forth rhythm isn't broken
        const lines = poemText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) throw new Error("Poem file is empty.");

        const { voice1, voice2 } = getRandomVoices();
        console.log(`🎤 Voice 1 (Odd lines):  ${voice1}`);
        console.log(`🎤 Voice 2 (Even lines): ${voice2}\n`);

        const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const generatedFiles = [];

        // Generate the lines sequentially
        for (let i = 0; i < lines.length; i++) {
            const isOddLine = (i % 2 === 0); // 0-based index means 0 is line 1 (Odd)
            const currentVoice = isOddLine ? voice1 : voice2;
            
            // Extract just the emoji and name for a cleaner terminal log
            const shortName = currentVoice.split(' ').slice(0, 3).join(' ');
            process.stdout.write(`   🗣️  Generating Line ${i + 1} (${shortName})... `);
            
            const filePath = await generateLine(lines[i], currentVoice, i, timeStamp);
            generatedFiles.push(filePath);
            console.log(`Done.`);
        }

        console.log(`\n🎵 Stitching ${generatedFiles.length} lines together...`);
        
        // Create an FFmpeg demuxer list
        const concatFilePath = path.join(os.tmpdir(), `concat_${timeStamp}.txt`);
        const concatContent = generatedFiles.map(f => `file '${path.resolve(f)}'`).join('\n');
        fs.writeFileSync(concatFilePath, concatContent);

        const finalFilename = `Kokoro_Alternating_${timeStamp}.flac`;
        const finalFilePath = path.join(OUTPUT_DIR, finalFilename);

        // Run FFmpeg to seamlessly join the lines without re-encoding
        await execFileAsync('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatFilePath,
            '-c', 'copy',
            finalFilePath
        ]);

        // Clean up the temporary individual line files and text file
        fs.unlinkSync(concatFilePath);
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