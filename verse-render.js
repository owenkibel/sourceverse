import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";

// Public Sourceverse blog directories
const POSTS_DIR = path.join(process.cwd(), 'posts');
const IMAGES_DIR = path.join(process.cwd(), 'images');
const ASTRO_PUBLIC_IMAGES = path.join(process.cwd(), 'site/public/images');

// Krea-2 Turbo default model filenames (from run_krea.js)
const DEFAULT_KREA_UNET = "krea2_turbo_fp8_scaled.safetensors";
const DEFAULT_KREA_CLIP = "qwen3vl_4b_fp8_scaled.safetensors";
const DEFAULT_KREA_VAE  = "qwen_image_vae.safetensors";

function parseCliArgs() {
  const args = process.argv.slice(2);
  const config = {
    engine: args.includes('--krea') || args.includes('--krea2') ? 'krea' : 'lens',
    unet: DEFAULT_KREA_UNET,
    lora: null,
    loraStrength: 0.6,
    limit: Infinity,
    targetFile: null,
    profileFilter: null,
    countPerPost: 3,
    force: args.includes('--force')
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--krea' || arg === '--krea2') config.engine = 'krea';
    else if (arg === '--lens') config.engine = 'lens';
    else if (arg === '--unet' && args[i + 1]) config.unet = args[++i];
    else if (arg.startsWith('--unet=')) config.unet = arg.split('=')[1];
    else if (arg === '--lora' && args[i + 1]) config.lora = args[++i];
    else if (arg.startsWith('--lora=')) config.lora = arg.split('=')[1];
    else if (arg === '--lora-strength' && args[i + 1]) config.loraStrength = parseFloat(args[++i]);
    else if (arg.startsWith('--lora-strength=')) config.loraStrength = parseFloat(arg.split('=')[1]);
    else if (arg === '--file' && args[i + 1]) config.targetFile = args[++i];
    else if (arg.startsWith('--file=')) config.targetFile = arg.split('=')[1];
    else if (arg.startsWith('--profile=')) config.profileFilter = arg.split('=')[1].toLowerCase();
    else if (arg.startsWith('--images=')) config.countPerPost = parseInt(arg.split('=')[1], 10) || 3;
    else if ((arg === '--latest' || arg === '--limit') && args[i + 1]) config.limit = parseInt(args[++i], 10);
    else if (arg.startsWith('--limit=')) config.limit = parseInt(arg.split('=')[1], 10);
    else if (!arg.startsWith('--') && !isNaN(parseInt(arg, 10))) config.limit = parseInt(arg, 10);
  }
  return config;
}

// 1. Lens Turbo BF16 workflow (from kitchen-render.js)
function buildLensPayload(promptText, seed, timeStamp) {
  return {
    client_id: "lens_verse_prod",
    prompt: {
      "35": { inputs: { aspect_ratio: "1:1 (Square)", megapixels: 2 }, class_type: "ResolutionSelector" },
      "43": { inputs: { filename_prefix: `Lens_Verse_${timeStamp}`, images: ["34:5", 0] }, class_type: "SaveImage" },
      "34:9": { inputs: { vae_name: "flux2-vae.safetensors" }, class_type: "VAELoader" },
      "34:2": { inputs: { clip_name: "gpt_oss_20b_nvfp4.safetensors", type: "lens", device: "default" }, class_type: "CLIPLoader" },
      "34:3": { inputs: { text: promptText, clip: ["34:2", 0] }, class_type: "CLIPTextEncode" },
      "34:7": { inputs: { text: "", clip: ["34:2", 0] }, class_type: "CLIPTextEncode" },
      "34:8": { inputs: { width: ["34:32", 1], height: ["34:33", 1], batch_size: 1 }, class_type: "EmptyLatentImage" },
      "34:16": { inputs: { scheduler: "simple", steps: 4, denoise: 1, model: ["34:21", 0] }, class_type: "BasicScheduler" },
      "34:18": { inputs: { sampler_name: "euler" }, class_type: "KSamplerSelect" },
      "34:23": { inputs: { strength: 1, pre_cfg: false, model: ["34:21", 0] }, class_type: "CFGNorm" },
      "34:10": { inputs: { unet_name: "lens_turbo_bf16.safetensors", weight_dtype: "default" }, class_type: "UNETLoader" },
      "34:14": {
        inputs: {
          add_noise: true,
          noise_seed: seed,
          cfg: 1,
          model: ["34:23", 0],
          positive: ["34:3", 0],
          negative: ["34:7", 0],
          sampler: ["34:18", 0],
          sigmas: ["34:16", 0],
          latent_image: ["34:8", 0]
        },
        class_type: "SamplerCustom"
      },
      "34:5": { inputs: { samples: ["34:14", 0], vae: ["34:9", 0] }, class_type: "VAEDecode" },
      "34:21": { inputs: { max_shift: 1.15, base_shift: 0.5, width: ["34:32", 1], height: ["34:33", 1], model: ["34:10", 0] }, class_type: "ModelSamplingFlux" },
      "34:30": { inputs: { value: 1064 }, class_type: "PrimitiveInt" },
      "34:31": { inputs: { value: 1888 }, class_type: "PrimitiveInt" },
      "34:32": { inputs: { expression: "a & -8", "values.a": ["34:30", 0] }, class_type: "ComfyMathExpression" },
      "34:33": { inputs: { expression: "a & -8", "values.a": ["34:31", 0] }, class_type: "ComfyMathExpression" }
    }
  };
}

// 2. Krea-2 Turbo FP8 workflow (from run_krea.js)
function buildKreaPayload(promptText, seed, timeStamp, options = {}) {
  const unetName = options.unet || DEFAULT_KREA_UNET;
  const loraName = options.lora || null;
  const loraStrength = options.loraStrength ?? 0.6;
  const activeModelNode = loraName ? ["18", 0] : ["10", 0];

  const promptGraph = {
    "10": {
      inputs: { unet_name: unetName, weight_dtype: "default" },
      class_type: "UNETLoader"
    },
    "11": {
      inputs: { clip_name: DEFAULT_KREA_CLIP, type: "krea2", device: "default" },
      class_type: "CLIPLoader"
    },
    "12": {
      inputs: { vae_name: DEFAULT_KREA_VAE },
      class_type: "VAELoader"
    },
    "13": {
      inputs: { text: promptText, clip: ["11", 0] },
      class_type: "CLIPTextEncode"
    },
    "14": {
      inputs: { text: "", clip: ["11", 0] },
      class_type: "CLIPTextEncode"
    },
    "15": {
      inputs: { width: 1056, height: 1888, batch_size: 1 },
      class_type: "EmptyLatentImage"
    },
    "16": {
      inputs: {
        seed: seed,
        steps: 8,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
        model: activeModelNode,
        positive: ["13", 0],
        negative: ["14", 0],
        latent_image: ["15", 0]
      },
      class_type: "KSampler"
    },
    "17": {
      inputs: { samples: ["16", 0], vae: ["12", 0] },
      class_type: "VAEDecode"
    },
    "43": {
      inputs: { filename_prefix: `Krea2_Verse_${timeStamp}`, images: ["17", 0] },
      class_type: "SaveImage"
    }
  };

  if (loraName) {
    promptGraph["18"] = {
      inputs: {
        lora_name: loraName,
        strength_model: loraStrength,
        model: ["10", 0]
      },
      class_type: "LoraLoaderModelOnly"
    };
  }

  return {
    client_id: "krea2_verse_prod",
    prompt: promptGraph
  };
}

async function freeComfyVRAM() {
  try {
    await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
  } catch (_) {}
}

async function renderPrompt(promptText, outputFilename, config) {
  const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const seed = Math.floor(Math.random() * 1e14);

  const payload =
    config.engine === 'krea'
      ? buildKreaPayload(promptText, seed, timeStamp, config)
      : buildLensPayload(promptText, seed, timeStamp);

  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`ComfyUI Queue Error: ${await res.text()}`);

  const { prompt_id } = await res.json();
  const startTime = Date.now();
  while (Date.now() - startTime < 180000) {
    await new Promise(r => setTimeout(r, 2000));
    const hRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    const history = await hRes.json();

    if (history[prompt_id]?.outputs?.["43"]?.images?.length > 0) {
      const file = history[prompt_id].outputs["43"].images[0];
      const dlRes = await fetch(`${COMFY_URL}/view?filename=${file.filename}&subfolder=${file.subfolder}&type=${file.type}`);
      const imgBuffer = Buffer.from(await dlRes.arrayBuffer());

      const primaryPath = path.join(IMAGES_DIR, outputFilename);
      fs.writeFileSync(primaryPath, imgBuffer);

      if (fs.existsSync(ASTRO_PUBLIC_IMAGES)) {
        fs.writeFileSync(path.join(ASTRO_PUBLIC_IMAGES, outputFilename), imgBuffer);
      }
      return `/images/${outputFilename}`;
    }
    if (history[prompt_id]?.status?.status_str === 'error') {
      const errMsgs = JSON.stringify(history[prompt_id]?.status?.messages || []);
      throw new Error(`ComfyUI Node Execution Error: ${errMsgs}`);
    }
  }
  throw new Error("Timeout waiting for ComfyUI");
}

// Fallback generator if an older verse-*.md file lacks "Prompt 1:" lines
async function generatePromptsFromPoem(poemContent, count = 3) {
  const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY1 to generate fallback scene prompts.");

  console.log(`   ✨ Generating ${count} visual scene prompts via gemini-3.5-flash-lite...`);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Read the following satirical/editorial poem and provide a section titled '## Visual Scene Prompts' containing ${count} distinct, highly descriptive visual prompts (FLUX/Krea editorial illustration style) capturing the poem's key scenes and ironic metaphors. Format each on its own line starting with 'Prompt 1:', 'Prompt 2:', etc.\n\nPoem:\n${poemContent.slice(0, 8000)}`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        thinkingConfig: { thinkingLevel: "minimal" }
      }
    })
  });

  if (!res.ok) throw new Error(`Gemini prompt generation failed: ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim();
}

async function main() {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const config = parseCliArgs();
  const { limit, targetFile, profileFilter, countPerPost, force, engine } = config;
  const engineLabel = engine === 'krea' ? 'Krea-2 Turbo' : 'Lens Turbo';

  console.log(`🚀 Starting verse-render [Engine: ${engineLabel}]`);

  let mdFiles = fs.readdirSync(POSTS_DIR)
    .filter(f => f.startsWith('verse-') && f.endsWith('.md'))
    .map(f => ({ name: f, time: fs.statSync(path.join(POSTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
    .map(f => f.name);

  if (targetFile) {
    mdFiles = mdFiles.filter(f => f.toLowerCase() === path.basename(targetFile).toLowerCase());
  }
  if (profileFilter) {
    mdFiles = mdFiles.filter(f => f.toLowerCase().includes(`verse-${profileFilter}`));
  }

  let processedCount = 0;

  for (const file of mdFiles) {
    if (processedCount >= limit) break;

    const filePath = path.join(POSTS_DIR, file);
    let content = fs.readFileSync(filePath, 'utf8');

    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) continue;

    let frontMatter = fmMatch[1];
    let body = fmMatch[2];

    const isAlreadyRendered =
      /^rendered:\s*true/m.test(frontMatter) ||
      /^status:\s*"rendered"/m.test(frontMatter);

    if (isAlreadyRendered && !force) {
      continue;
    }

    let promptMatches = [...body.matchAll(/Prompt\s*\d+:\s*(.*)/gi)];
    if (promptMatches.length === 0) {
      try {
        const generatedSection = await generatePromptsFromPoem(body, countPerPost);
        body = `${body.trim()}\n\n---\n\n${generatedSection}\n`;
        promptMatches = [...generatedSection.matchAll(/Prompt\s*\d+:\s*(.*)/gi)];
      } catch (err) {
        console.error(`❌ Could not generate scene prompts for ${file}: ${err.message}`);
        continue;
      }
    }

    if (promptMatches.length === 0) continue;

    const baseName = path.basename(file, '.md').slice(0, 45);
    console.log(`\n🎨 Rendering ${engineLabel} illustrations for ${file}...`);

    let renderedImageMarkdown = `\n\n---\n\n## Generated Editorial Imagery (${engineLabel})\n`;
    let firstImageUrl = null;

    const maxPrompts = Math.min(promptMatches.length, countPerPost);
    for (let i = 0; i < maxPrompts; i++) {
      const promptText = promptMatches[i][1].replace(/^[*`"']+|[*`"']+$/g, '').trim();
      const imageFilename = `${baseName}_${engine}_img_${i + 1}_${Date.now().toString(36)}.png`;
      try {
        console.log(`   🖼️ [${engineLabel}] Prompt ${i + 1}: "${promptText.slice(0, 55)}..."`);
        const url = await renderPrompt(promptText, imageFilename, config);
        if (!firstImageUrl) firstImageUrl = url;
        renderedImageMarkdown += `\n![${promptText.replace(/[\[\]]/g, '')}](${url})\n*${promptText}*\n`;
      } catch (err) {
        console.error(`❌ Image ${i + 1} failed: ${err.message}`);
      }
    }

    if (!firstImageUrl) continue;

    let fmLines = frontMatter
      .split('\n')
      .filter(l => !/^(rendered|status|image|image_engine):/.test(l.trim()));

    fmLines.push(`image: "${firstImageUrl}"`);
    fmLines.push(`image_engine: "${engineLabel}"`);
    fmLines.push(`rendered: true`);
    fmLines.push(`status: "rendered"`);

    if (!body.includes('chroma-drift.js')) {
      body = `<script src="/chroma-drift.js" type="module"></script>\n\n${body.trim()}`;
    }

    const updatedMarkdown = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}${renderedImageMarkdown}\n`;
    fs.writeFileSync(filePath, updatedMarkdown, 'utf8');

    console.log(`✅ Updated ${file} with rendered: true, ${engineLabel} imagery, and Chroma Drift.\n`);
    processedCount++;
  }

  if (processedCount > 0) {
    await freeComfyVRAM();
  }
}

main();