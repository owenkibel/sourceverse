import fs from 'fs/promises';
import path from 'path';

const args = process.argv.slice(2);
let stateFile = null;
const stateFileIdx = args.indexOf('--state-file');
if (stateFileIdx !== -1 && args[stateFileIdx + 1]) {
  stateFile = args[stateFileIdx + 1];
}

const promptText = (await fs.readFile('prompt.txt', 'utf8').catch(() => 'Abstract composition')).trim();
const COMFY_URL = 'http://127.0.0.1:8188';

function createWorkflow(prompt) {
  const seed = Math.floor(Math.random() * 1e9);

  return {
    "1": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
        "weight_dtype": "default"
      }
    },
    "2": {
      "class_type": "CLIPLoader",
      "inputs": {
        "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
        "type": "qwen_image" // Match the Qwen type identified in your CLIPLoader enum
      }
    },
    "3": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
      }
    },
    "4": {
      "class_type": "EmptyLatentImage",
      "inputs": {
        "width": 768,
        "height": 1344,
        "batch_size": 1
      }
    },
    "5": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": prompt,
        "clip": ["2", 0]
      }
    },
    "6": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": "blurry, low quality, distorted, artifacts",
        "clip": ["2", 0]
      }
    },
    "7": {
      "class_type": "KSampler",
      "inputs": {
        "seed": seed,
        "steps": 25,
        "cfg": 1.0,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 1.0,
        "model": ["1", 0],
        "positive": ["5", 0],
        "negative": ["6", 0],
        "latent_image": ["4", 0]
      }
    },
    "8": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["7", 0],
        "vae": ["3", 0]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "filename_prefix": "Qwen_Art",
        "images": ["8", 0]
      }
    }
  };
}

async function run() {
  console.log('🚀 [Qwen-Image] Submitting prompt to ComfyUI...');
  const workflow = createWorkflow(promptText);

  const queueRes = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow })
  });

  if (!queueRes.ok) {
    const errorDetails = await queueRes.text();
    console.error(`\n❌ ComfyUI Validation Details:\n${errorDetails}\n`);
    throw new Error(`ComfyUI queue failed with status ${queueRes.status}`);
  }

  const { prompt_id } = await queueRes.json();
  console.log(`⏳ [Qwen-Image] Queued prompt: ${prompt_id}. Waiting for completion...`);

  let completed = false;
  let filename = '';
  let subfolder = '';

  while (!completed) {
    await new Promise(r => setTimeout(r, 1500));
    const histRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    if (!histRes.ok) continue;

    const histData = await histRes.json();
    const job = histData[prompt_id];
    if (!job) continue;

    // Check for execution failure so the runner doesn't hang
    if (job.status?.status_str === 'error' || job.status?.messages?.some(m => m[0] === 'execution_error')) {
      throw new Error(`ComfyUI execution error: ${JSON.stringify(job.status)}`);
    }

    if (job.status?.completed) {
      const outputs = job.outputs;
      const saveNodeOutput = outputs["9"]?.images?.[0];
      if (saveNodeOutput) {
        filename = saveNodeOutput.filename;
        subfolder = saveNodeOutput.subfolder || '';
        completed = true;
      }
    }
  }

  const viewUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
  const imgRes = await fetch(viewUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch rendered image: ${imgRes.statusText}`);

  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const destDir = path.join(process.cwd(), 'images');
  await fs.mkdir(destDir, { recursive: true });

  const finalFilename = `qwen_${Date.now()}_${filename}`;
  const localDestPath = path.join(destDir, finalFilename);
  await fs.writeFile(localDestPath, buffer);

  console.log(`✅ [Qwen-Image] Generated: ${finalFilename}`);

  if (stateFile) {
    await fs.writeFile(stateFile, JSON.stringify({
      filename: finalFilename,
      savedFilePath: localDestPath
    }), 'utf8');
  }
}

run().catch(err => {
  console.error(`❌ [Qwen-Image] Execution error:`, err);
  process.exit(1);
});