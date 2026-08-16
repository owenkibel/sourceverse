import fs from 'fs';
import path from 'path';

const LLAMA_API = "http://localhost:8080/v1/chat/completions";
const OUTPUT_JSON = "./generated_limericks.json";
// const OUTPUT_MD = "./generated_limericks.md";

function loadList(filename) {
  const filePath = path.join(import.meta.dirname || process.cwd(), filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing list file: ${filename}`);
  }
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseLimerick(rawText) {
  // 1. Extract content inside <limerick> tags if present
  const tagMatch = rawText.match(/<limerick>([\s\S]*?)<\/limerick>/i);
  if (tagMatch) {
    return tagMatch[1].trim();
  }

  // 2. Fallback: Filter out thinking noise and grab the final 5 lines
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('*') && !l.startsWith('Line') && !l.includes('da DUM'));

  if (lines.length >= 5) {
    return lines.slice(-5).join('\n');
  }

  return rawText.trim() || "Error: Model returned empty response.";
}

async function expandSeedWithLLM(seedPhrase) {
  const prompt = `Write a classic 5-line limerick (strict AABBA rhyme scheme) based on this concept:

"${seedPhrase}"

Rules:
- Exactly 5 lines with bouncy limerick rhythm.
- Wrap ONLY the final 5-line poem inside <limerick>...</limerick> tags. Do not write explanations.`;

  const response = await fetch(LLAMA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false } // Prevents reasoning loop blowout
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  const rawText = choice?.message?.content || choice?.message?.reasoning_content || "";
  return parseLimerick(rawText);
}

async function main() {
  console.log("=== Limerick Generator (Concatenated Seed Edition) ===\n");

  const list1 = loadList('list1L.txt');
  const list2 = loadList('list2L.txt');
  const list3 = loadList('list3L.txt');

  const count = parseInt(process.argv[2], 10) || 5;
  const results = [];
  let mdOutput = `# Generated Fig & Orchard Limericks\n\n*Generated on ${new Date().toISOString()}*\n\n---\n\n`;

  for (let i = 1; i <= count; i++) {
    // Concatenate the three lists into a single continuous phrase
    const part1 = pick(list1);
    const part2 = pick(list2);
    const part3 = pick(list3);
    const seedPhrase = `${part1}, ${part2}, ${part3}.`;

    console.log(`[${i}/${count}] Seed Phrase: "${seedPhrase}"`);
    console.log(`   🧠 Generating...`);

    try {
      const poem = await expandSeedWithLLM(seedPhrase);

      console.log(`\n--- Limerick ${i} ---`);
      console.log(poem);
      console.log('-------------------------------\n');

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

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
// Replace the single file write in main() with individual blog post creation:
const postSlug = `limerick-batch-${Date.now()}`;
const blogPostPath = path.join(process.env.HOME, 'sourceverse/posts', `${postSlug}.md`);

const blogMarkdown = `---
title: "Fig & Orchard Limericks: Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
tags: ["limericks", "generative-poetry", "gemma12b", "botanical"]
---

${mdOutput}
`;

fs.writeFileSync(blogPostPath, blogMarkdown);
console.log(`🚀 Direct-published batch to Astro blog: ${blogPostPath}`);

  console.log(`✅ Complete! Output saved to:`);
  console.log(`   - JSON: ${OUTPUT_JSON}`);
  // console.log(`   - Markdown: ${OUTPUT_MD}`);
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});