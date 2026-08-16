import fs from 'fs';
import path from 'path';

const LLAMA_API = "http://127.0.0.1:8080/v1/chat/completions";
const OUTPUT_JSON = "./generated_limericks.json";

function loadList(filename) {
  const filePath = path.join(import.meta.dirname || process.cwd(), filename);
  if (!fs.existsSync(filePath)) throw new Error(`Missing list file: ${filename}`);
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
  const match = rawText.match(/<limerick>([\s\S]*?)<\/limerick>/i);
  if (match) return match[1].trim();

  // Fallback: grab the 5 non-empty lines
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('*') && !l.startsWith('Line') && !l.includes('da DUM'));

  if (lines.length >= 5) return lines.slice(-5).join('\n');
  return rawText.trim();
}

async function expandSeedWithLLM(seedPhrase) {
  // Minimal, uninhibited prompt
  const prompt = `Write a witty, classic 5-line limerick with a strict AABBA rhyme scheme based on this concept:

"${seedPhrase}"

Wrap ONLY the 5-line poem inside <limerick>...</limerick> tags.`;

  const response = await fetch(LLAMA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.75,
      top_p: 0.9,
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseLimerick(rawText);
}

async function main() {
  console.log("=== Generating Fig & Orchard Limericks (Minimal Prompt) ===\n");

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
      const poem = await expandSeedWithLLM(seedPhrase);

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

  // Save directly to Astro Blog
  const postSlug = `limerick-batch-${Date.now()}`;
  const blogPostPath = path.join(process.env.HOME, 'sourceverse/posts', `${postSlug}.md`);

  const blogMarkdown = `---
title: "Fig & Orchard Limericks: Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
tags: ["limericks", "generative-poetry", "botanical"]
---

# Generated Fig & Orchard Limericks

*Generated on ${new Date().toISOString()}*

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