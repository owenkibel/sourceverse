import fs from 'fs';
import path from 'path';

const COMFY_URL = "http://127.0.0.1:8188";

// Public Sourceverse blog directories
const POSTS_DIR = path.join(process.cwd(), 'posts');
const IMAGES_DIR = path.join(process.cwd(), 'images');
const ASTRO_PUBLIC_IMAGES = path.join(process.cwd(), 'site/public/images');

function parseCliArgs() {
  const args = process.argv.slice(2);
  const config = {
    limit: Infinity,
    targetFile: null,
    profileFilter: null,
    countPerPost: 3,
    force: args.includes('--force')
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' && args[i + 1]) config.targetFile = args[++i];
    else if (arg.startsWith('--file=')) config.targetFile = arg.split('=')[1];
    else if (arg.startsWith('--profile=')) config.profileFilter = arg.split('=')[1].toLowerCase();
    else if (arg.startsWith('--images=')) config.countPerPost = parseInt(arg.split('=')[1], 10) || 3;
    else if ((arg === '--latest' || arg === '--limit') && args[i + 1]) config.limit = parseInt(args[++i], 10);
    else if (arg.startsWith('--limit=')) config.limit = parseInt(arg.split('=')[1], 10);
    else if (!arg.startsWith('--') && !isNaN(parseInt(arg, 10))) config.limit = parseInt(arg, 10);
  }
  return config;
}

// Direct ComfyUI Flux2 / Lens Turbo workflow from kitchen-render.js
function buildPayload(promptText, seed, timeStamp) {
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

async function renderPrompt(promptText, outputFilename) {
  const timeStamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const seed = Math.floor(Math.random() * 1e14);
  const payload = buildPayload(promptText, seed, timeStamp);

  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`ComfyUI Queue Error: ${await res.text()}`);

  const { prompt_id } = await res.json();
  const startTime = Date.now();
  while (Date.now() - startTime < 120000) {
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
      throw new Error("ComfyUI Node Execution Error");
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
              text: `Read the following satirical/editorial poem and provide a section titled '## Visual Scene Prompts' containing ${count} distinct, highly descriptive visual prompts (FLUX/editorial illustration style) capturing the poem's key scenes and ironic metaphors. Format each on its own line starting with 'Prompt 1:', 'Prompt 2:', etc.\n\nPoem:\n${poemContent.slice(0, 8000)}`
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

  const { limit, targetFile, profileFilter, countPerPost, force } = parseCliArgs();

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
      console.log(`⏭️  Skipping already-rendered verse post: ${file}`);
      continue;
    }

    // Extract inline prompts (if generated in single pass) or synthesize via 2nd API call
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
    console.log(`\n🎨 Rendering illustrations for ${file}...`);

    let renderedImageMarkdown = "\n\n---\n\n## Generated Editorial Imagery\n";
    let firstImageUrl = null;

    const maxPrompts = Math.min(promptMatches.length, countPerPost);
    for (let i = 0; i < maxPrompts; i++) {
      const promptText = promptMatches[i][1].replace(/^[*`"']+|[*`"']+$/g, '').trim();
      const imageFilename = `${baseName}_img_${i + 1}_${Date.now().toString(36)}.png`;
      try {
        console.log(`   🖼️ Rendering Prompt ${i + 1}: "${promptText.slice(0, 55)}..."`);
        const url = await renderPrompt(promptText, imageFilename);
        if (!firstImageUrl) firstImageUrl = url;
        renderedImageMarkdown += `\n![${promptText.replace(/[\[\]]/g, '')}](${url})\n*${promptText}*\n`;
      } catch (err) {
        console.error(`❌ Image ${i + 1} failed: ${err.message}`);
      }
    }

    if (!firstImageUrl) continue;

    // Update front matter: set rendered: true, status: "rendered", and hero image
    let fmLines = frontMatter
      .split('\n')
      .filter(l => !/^(rendered|status|image):/.test(l.trim()));

    fmLines.push(`image: "${firstImageUrl}"`);
    fmLines.push(`rendered: true`);
    fmLines.push(`status: "rendered"`);

    if (!body.includes('chroma-drift.js')) {
      body = `<script src="/chroma-drift.js" type="module"></script>\n\n${body.trim()}`;
    }

    const updatedMarkdown = `---\n${fmLines.join('\n')}\n---\n\n${body.trim()}${renderedImageMarkdown}\n`;
    fs.writeFileSync(filePath, updatedMarkdown, 'utf8');

    console.log(`✅ Updated ${file} with rendered: true, hero image, and Chroma Drift.\n`);
    processedCount++;
  }
}

main();