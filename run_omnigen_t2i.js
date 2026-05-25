import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";

// --- NODE ID CONFIGURATION ---
const POSITIVE_PROMPT_NODE = "4"; 
const KSAMPLER_NODE = "6";        
const SAVE_IMAGE_NODE = "9";      

async function main() {
    try {
        const args = process.argv.slice(2);
        
        // 1. Get the state file argument
        const stateFileIndex = args.findIndex(a => a === '--state-file');
        const stateFileTarget = stateFileIndex !== -1 ? args[stateFileIndex + 1] : 'state.json';

        // 2. Read the prompt
        let imagePrompt = "A highly detailed, cinematic shot of a futuristic city";
        if (fs.existsSync('prompt.txt')) {
            imagePrompt = fs.readFileSync('prompt.txt', 'utf8').trim();
        }

        console.log(`\n🌌 Mode: OmniGen2 Text-to-Image`);
        console.log(`Injecting Prompt: ${imagePrompt.substring(0, 50)}...`);

        // 3. Load the JSON Workflow
        const workflowPath = path.join(process.cwd(), 'omnigen2-t2i.json');
        if (!fs.existsSync(workflowPath)) {
            throw new Error(`Workflow file not found at: ${workflowPath}`);
        }
        const rawJson = fs.readFileSync(workflowPath, 'utf8');
        const promptData = JSON.parse(rawJson);
        
        // 4. Inject the Prompt and Seed
        const seed = Math.floor(Math.random() * 100000000000000);
        
        if (!promptData[POSITIVE_PROMPT_NODE] || !promptData[KSAMPLER_NODE]) {
            throw new Error("Node IDs do not match the JSON workflow. Please check POSITIVE_PROMPT_NODE and KSAMPLER_NODE.");
        }

        promptData[POSITIVE_PROMPT_NODE].inputs.text = imagePrompt;  
        promptData[KSAMPLER_NODE].inputs.seed = seed;         
        
        const payload = { prompt: promptData };

        // 5. Send to ComfyUI
        const res = await fetch(`${COMFY_URL}/prompt`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error(`Server Error: ${await res.text()}`);
        const { prompt_id } = await res.json();
        console.log(`Job queued successfully. Prompt ID: ${prompt_id}`);
        
        // 6. Poll for Completion
        let success = false;
        let outputInfo = {};
        process.stdout.write('Generating');
        
        for (let i = 0; i < 300; i++) { // Allow up to 10 minutes
            await new Promise(r => setTimeout(r, 2000));
            process.stdout.write('.');
            
            const histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
            const history = await histRes.json();

            if (history[prompt_id]?.outputs?.[SAVE_IMAGE_NODE]?.images?.length > 0) {
                console.log('\nGeneration complete! Downloading image...');
                const file = history[prompt_id].outputs[SAVE_IMAGE_NODE].images[0];
                const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
                
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                const savePath = path.join(OUTPUT_DIR, file.filename);
                
                const buffer = await dlRes.arrayBuffer();
                fs.writeFileSync(savePath, Buffer.from(buffer));
                
                outputInfo = { savedFilePath: savePath, filename: file.filename };
                success = true;
                break;
            }
            if (history[prompt_id]?.status?.status_str === 'error') {
                console.log('\n');
                throw new Error("ComfyUI Node Error during generation.");
            }
        }

        if (!success) {
            console.log('\n');
            throw new Error("OmniGen generation timed out.");
        }
        
        // 7. Write the Success State
        fs.writeFileSync(stateFileTarget, JSON.stringify(outputInfo, null, 2));
        console.log(`State saved to ${stateFileTarget}`);

    } catch (e) {
        console.error(`\nOmniGen Generation Failed: ${e.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});