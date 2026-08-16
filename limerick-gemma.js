/**
 * Fig & Orchard Limerick Seed → Gemma Generator
 * Three-list architecture (party-namer style)
 * Minimal prompt that works well with Gemma when thinking is disabled
 */

import fs from 'fs';
import path from 'path';

const LLAMA_API = "http://localhost:8080/v1/chat/completions";
const OUTPUT_JSON = "./generated_limericks.json";

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
  // Prefer content inside <limerick> tags
  const tagMatch = rawText.match(/<limerick>([\s\S]*?)<\/limerick>/i);
  if (tagMatch) {
    return tagMatch[1].trim();
  }

  // Fallback: take the last 5 non-empty lines
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length >= 5) {
    return lines.slice(-5).join('\n');
  }

  return rawText.trim() || "Error: empty response from model";
}

async function expandSeedWithLLM(seedPhrase) {
  // Minimal prompt that worked with Gemma
  const prompt = `Write a classic 5-line limerick (AABBA) from this idea:

"${seedPhrase}"

Output only the limerick inside <limerick> tags.`;

  const response = await fetch(LLAMA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false }
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseLimerick(rawText);
}

async function main() {
  console.log("=== Fig & Orchard Limerick Generator (Gemma) ===\n");

  const list1 = loadList('list1L.txt');
  const list2 = loadList('list2L.txt');
  const list3 = loadList('list3L.txt');

  const count = parseInt(process.argv[2], 10) || 5;
  const results = [];

  let mdOutput = `# Generated Fig & Orchard Limericks\n\n*Generated on ${new Date().toISOString()}*\n\n---\n\n`;

  for (let i = 1; i <= count; i++) {
    const setup = pick(list1);
    const development = pick(list2);
    const twist = pick(list3);

    // Party-namer style seed
    const seedPhrase = `${setup}, ${development}, ${twist}`;

    console.log(`[${i}/${count}] Seed: "${seedPhrase}"`);
    console.log(`   Generating...`);

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

      mdOutput += `### ${i}. ${setup}\n\n`;
      mdOutput += `\`\`\`text\n${poem}\n\`\`\`\n\n`;
      mdOutput += `> **Seed Phrase:** "${seedPhrase}"\n\n---\n\n`;

    } catch (err) {
      console.error(`❌ Error on item ${i}: ${err.message}\n`);
    }
  }

  // Save JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));

  // Optional: direct publish to Astro-style blog post
  const postSlug = `limerick-batch-${Date.now()}`;
  const blogPostPath = path.join(process.env.HOME || ".", 'sourceverse/posts', `${postSlug}.md`);

  const blogMarkdown = `---
title: "Fig & Orchard Limericks: Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
tags: ["limericks", "generative-poetry", "gemma", "botanical"]
---

${mdOutput}
`;

  // Create directory if needed
  fs.mkdirSync(path.dirname(blogPostPath), { recursive: true });
  fs.writeFileSync(blogPostPath, blogMarkdown);

  console.log(`✅ Done!`);
  console.log(`   JSON:  ${OUTPUT_JSON}`);
  console.log(`   Post:  ${blogPostPath}`);
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});