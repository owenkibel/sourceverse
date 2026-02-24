import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

async function uploadAudio(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`Ref audio missing: ${filePath}`);
    console.log(`Uploading: ${path.basename(filePath)}`);
    const blob = new Blob([fs.readFileSync(filePath)]);
    const formData = new FormData();
    formData.append('image', blob, path.basename(filePath));
    formData.append('type', 'input');
    formData.append('overwrite', 'true');
    const res = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()).name;
}

function convertToOpus(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath).audioCodec('libopus').audioBitrate('128k').on('end', resolve).on('error', reject).save(outputPath);
    });
}

function buildPayload(lyrics, style, refFilename = null) {
    const prompt = {
        "11": { "class_type": "MultiLineLyricsDR", "inputs": { "lyrics": lyrics } },
        "10": { 
            "class_type": "DiffRhythm2Node", 
            "inputs": { 
                "歌词": ["11", 0], "音乐风格提示词": style,
                "参考音乐": refFilename ? ["13", 0] : null, 
                "歌曲最大长度": 210, "步数": 20, "cfg": 4.0,
                "seed": Math.floor(Math.random() * 1e9), "卸载模型": true
            } 
        },
        "14": { "class_type": "SaveAudio", "inputs": { "audio": ["10", 0], "filename_prefix": "DR2_Gen" } }
    };
    if (refFilename) prompt["13"] = { "class_type": "LoadAudio", "inputs": { "audio": refFilename } };
    return { client_id: "dr2_prod", prompt };
}

async function main() {
    try {
        console.log("--- Starting DiffRhythm 2 ---");
        if (!fs.existsSync('lyrics.txt') || !fs.existsSync('style.txt')) throw new Error("Missing inputs");
        
        const lyrics = fs.readFileSync('lyrics.txt', 'utf8').trim();
        const style = fs.readFileSync('style.txt', 'utf8').trim();
        
        // Sanity Check: If lyrics are empty, don't even try (avoids "Unknown language" error)
        if (lyrics.length < 2) throw new Error("Lyrics too short, skipping.");

        let refFilename = null;
        if (fs.existsSync('ref_audio_path')) {
            const refPath = fs.readFileSync('ref_audio_path', 'utf8').trim();
            if (refPath) refFilename = await uploadAudio(refPath);
        }

        const payload = buildPayload(lyrics, style, refFilename);
        const res = await fetch(`${COMFY_URL}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(await res.text());
        const promptId = (await res.json()).prompt_id;
        console.log(`Job Queued: ${promptId}`);

        let outputInfo = {};
        const startTime = Date.now();
        // 2 minute timeout
        while (Date.now() - startTime < 120000) {
            await new Promise(r => setTimeout(r, 1000));
            const history = await (await fetch(`${COMFY_URL}/history/${promptId}`)).json();
            
            // Success Check
            if (history[promptId]?.outputs?.["14"]) {
                const file = history[promptId].outputs["14"].audio[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                const tempPath = path.join(OUTPUT_DIR, `temp-${file.filename}`);
                fs.writeFileSync(tempPath, Buffer.from(await dlRes.arrayBuffer()));

                const safeName = `dr2-${Date.now()}-${path.parse(file.filename).name}.opus`;
                const finalPath = path.join(OUTPUT_DIR, safeName);
                await convertToOpus(tempPath, finalPath);
                fs.unlinkSync(tempPath);

                outputInfo = { savedFilePath: finalPath, filename: safeName };
                break;
            }

            // Failure Check (Catches "Unknown language" crashes reported by ComfyUI)
            if (history[promptId]?.status?.status_str === 'error') {
                const errData = history[promptId]?.status?.messages;
                const errStr = errData ? JSON.stringify(errData) : "Unknown Node Error";
                throw new Error(`ComfyUI Node Failed: ${errStr}`);
            }
        }

        if (!outputInfo.filename) throw new Error("Timeout or no output.");

        const stateFilePath = process.argv[process.argv.indexOf('--state-file') + 1] || 'output_state.json';
        fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));
        console.log(`Success.`);

    } catch (e) {
        // Log explicitly so main script sees it
        console.error(`Run Failed: ${e.message}`);
        process.exit(1);
    }
}

main();