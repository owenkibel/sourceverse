/**
 * Fig & Orchard Limerick Generator – Oracle Party-Namer Edition
 * Uses list1O / list2O / list3O + improved seed formatter
 * Minimal prompt that works well with local Gemma
 */

import fs from 'fs';
import path from 'path';

const LLAMA_API = "http://localhost:8080/v1/chat/completions";
const OUTPUT_JSON = "./generated_limericks_oracle.json";

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

function makeLimerickSeedFromPartyName(prefix, core, suffix) {
  const templates = [
    `A band known as the ${prefix} ${core} ${suffix}`,
    `The ${core} of the ${suffix.replace(/^of the /i, '')}, who were ${prefix}`,
    `Some ${core} calling themselves ${prefix} ${suffix}`,
    `The proudly ${prefix} ${core} ${suffix}`,
    `A gathering of ${prefix} ${core} ${suffix}`,
    `The ${prefix} ${core} who claimed the title ${suffix}`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

function parseLimerick(rawText) {
  const tagMatch = rawText.match(/<limerick>([\s\S]*?)<\/limerick>/i);
  if (tagMatch) {
    return tagMatch[1].trim();
  }

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
  console.log("=== Fig & Orchard Limerick Generator (Oracle Party-Namer Edition) ===\n");

  const list1 = loadList('list1O.txt'); // Forward Leaf
  const list2 = loadList('list2O.txt'); // Middle Word
  const list3 = loadList('list3O.txt'); // Hinder Leaf

  const count = parseInt(process.argv[2], 10) || 5;
  const results = [];

  let mdOutput = `# Generated Fig & Orchard Limericks (Oracle Edition)\n\n*Generated on ${new Date().toISOString()}*\n\n---\n\n`;

  for (let i = 1; i <= count; i++) {
    const prefix = pick(list1);
    const core   = pick(list2);
    const suffix = pick(list3);

    const seedPhrase = makeLimerickSeedFromPartyName(prefix, core, suffix);

    console.log(`[${i}/${count}] Seed: "${seedPhrase}"`);
    console.log(`   Generating...`);

    try {
      const poem = await expandSeedWithLLM(seedPhrase);

      console.log(`\n--- Limerick ${i} ---`);
      console.log(poem);
      console.log('-------------------------------\n');

      results.push({
        id: i,
        prefix,
        core,
        suffix,
        seedPhrase,
        limerick: poem,
        timestamp: new Date().toISOString()
      });

      mdOutput += `### ${i}. ${prefix} ${core} ${suffix}\n\n`;
      mdOutput += `\`\`\`text\n${poem}\n\`\`\`\n\n`;
      mdOutput += `> **Seed Phrase:** "${seedPhrase}"\n\n---\n\n`;

    } catch (err) {
      console.error(`❌ Error on item ${i}: ${err.message}\n`);
    }
  }

  // Save JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));

  // Optional Astro-style blog post
  const postSlug = `limerick-oracle-batch-${Date.now()}`;
  const blogPostPath = path.join(process.env.HOME || ".", 'sourceverse/posts', `${postSlug}.md`);

  const blogMarkdown = `---
title: "Fig & Orchard Limericks (Oracle Edition): Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
tags: ["limericks", "generative-poetry", "gemma", "botanical", "oracle"]
---

${mdOutput}
`;

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