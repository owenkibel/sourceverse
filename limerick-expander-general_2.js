import fs from 'fs';
import path from 'path';

const LLAMA_API = "http://127.0.0.1:8080/v1/chat/completions";
const OUTPUT_JSON = "./generated_limericks.json";

function loadList(filename) {
  const filePath = path.join(import.meta.dirname || process.cwd(), filename);
  if (!fs.existsSync(filePath)) throw new Error(`Missing list file: ${filename}`);
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cleanLimerick(rawText) {
  // 1. If wrapped in <limerick> tags (complete or closing-only from prefill)
  const tagMatch = rawText.match(/<limerick>([\s\S]*?)<\/limerick>/i);
  if (tagMatch) {
    return tagMatch[1].trim();
  }

  // 2. Strip all thinking tags and intermediate thought scratchpad
  let text = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // Strip completed thought blocks
    .replace(/<think>[\s\S]*/gi, '')          // Strip open/truncated thought blocks
    .replace(/<\/?limerick>/gi, '')           // Strip standalone/residual limerick tags
    .replace(/<\/?think>/gi, '')              // Strip standalone think tags
    .trim();

  // 3. Fallback: Extract pure 5-line verse without markdown headers or chatter
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => 
      l.length > 0 && 
      !l.startsWith('*') && 
      !l.startsWith('#') &&
      !l.startsWith('Here') &&
      !l.startsWith('Note:') &&
      !l.toLowerCase().includes('limerick')
    );

  if (lines.length >= 5) {
    return lines.slice(0, 5).join('\n');
  }

  return text;
}

async function getActiveModelName() {
  try {
    const res = await fetch("http://127.0.0.1:8080/v1/models");
    if (!res.ok) return "llama-local";
    const data = await res.json();
    
    const rawPath = data.data?.[0]?.id || "";
    return path.basename(rawPath, '.gguf') || "llama-local";
  } catch {
    return "llama-local";
  }
}

async function expandSeedWithLLM(seedPhrase, modelName = "") {
  const nameLower = modelName.toLowerCase();
  const isGemma = nameLower.includes("gemma");

  const systemInstructions = `You are a master of comic satire and witty botanical verse.
You specialize in classic 5-line limericks with flawless AABBA meter and subtle, clever double-entendres.
Always output the 5-line poem wrapped strictly inside <limerick>...</limerick> tags. No intro or explanations.`;

  const userInstructions = `Write a classic 5-line limerick based on this botanical premise:
"${seedPhrase}"

Requirements:
- Strict AABBA rhyme scheme with bouncy anapestic rhythm.
- Playful botanical innuendo and a sharp punchline twist.
- Wrap ONLY the 5-line poem inside <limerick>...</limerick> tags.`;

  const payload = {
    temperature: 0.7,
    top_p: 0.9,
    min_p: 0.05,
    presence_penalty: 0.0,
    max_tokens: 1200 // Allows full thinking scansion + limerick output
  };

  if (isGemma) {
    // For Gemma: Combine into user role and explicitly turn off thinking kwargs
    payload.messages = [
      { role: 'user', content: `${systemInstructions}\n\n${userInstructions}` }
    ];
    payload.chat_template_kwargs = { enable_thinking: false };
  } else {
    // For Qwen, RVN, Hermes, and Grok: Standard ChatML system + user turns
    payload.messages = [
      { role: 'system', content: systemInstructions },
      { role: 'user', content: userInstructions }
    ];
  }

  const response = await fetch(LLAMA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`llama-server error (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return cleanLimerick(rawText);
}

async function main() {
  const modelName = await getActiveModelName();
  console.log(`🤖 Connected to active model: ${modelName}\n`);

  const list1 = loadList('list1L.txt');
  const list2 = loadList('list2L.txt');
  const list3 = loadList('list3L.txt');

  const count = parseInt(process.argv[2], 10) || 5;
  const results = [];
  let mdOutput = ``;

  for (let i = 1; i <= count; i++) {
    const part1 = pick(list1);
    const part2 = pick(list2);
    const part3 = pick(list3);
    const seedPhrase = `${part1}, ${part2}, ${part3}.`;

    console.log(`[${i}/${count}] Seed: "${seedPhrase}"`);

    try {
      const poem = await expandSeedWithLLM(seedPhrase, modelName);

      console.log(`\n${poem}\n------------------------------------------\n`);

      results.push({
        id: i,
        seedPhrase,
        limerick: poem,
        timestamp: new Date().toISOString()
      });

      mdOutput += `### ${i}. ${part1}\n\n`;
      mdOutput += `\`\`\`text\n${poem}\n\`\`\`\n\n`;
      mdOutput += `> **Seed Phrase:** "${seedPhrase}"\n\n---\n\n`;

    } catch (err) {
      console.error(`❌ Error on item ${i}: ${err.message}\n`);
    }
  }

  // Save JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));

  // Construct Markdown Post with dynamic model attribution
  const cleanModelSlug = modelName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const postSlug = `limerick-${cleanModelSlug}-${Date.now()}`;
  const blogPostPath = path.join(process.env.HOME, 'sourceverse/posts', `${postSlug}.md`);

  const blogMarkdown = `---
title: "Fig & Orchard Limericks (${modelName}): Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
model: "${modelName}"
tags: ["limericks", "generative-poetry", "${cleanModelSlug}", "botanical"]
---

# Generated Fig & Orchard Limericks

*Generated by **${modelName}** on ${new Date().toISOString()}*

---

${mdOutput}
`;

  fs.writeFileSync(blogPostPath, blogMarkdown);
  console.log(`🚀 Saved batch to Astro blog: ${blogPostPath}`);
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});