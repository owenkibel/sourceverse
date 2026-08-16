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

function cleanLimerick(text) {
  return text
    .replace(/<[^>]*>/g, '') // strip any accidental tags
    .replace(/^["']|["']$/g, '')
    .trim();
}

async function expandSeedWithLLM(seedPhrase) {
  const systemPrompt = `You are an expert satirical poet. You write hilarious, bawdy 5-line limericks with flawless AABBA rhyme and bouncy anapestic meter.
Never use slant rhymes or half-rhymes. Every rhyme must be clean and audible.`;

  const userPrompt = `Write a classic 5-line limerick based on this comical theme:
"${seedPhrase}"

Structure Requirements:
- Line 1: Setup (Ends with Rhyme A)
- Line 2: Narrative (Ends with Rhyme A)
- Line 3: Short punchy turn (Ends with Rhyme B)
- Line 4: Short reaction (Ends with Rhyme B)
- Line 5: The witty twist / punchline (Ends with Rhyme A)

Example of expected output format:
There once was a fig in the sun,
Whose ripening days had begun.
A wasp took a peek,
At the syconium's cheek,
And giggled, "The covering's done!"

Rules:
- Treat the seed phrase as inspiration for the joke; do not force awkward words onto the line ends.
- Return ONLY the 5 lines of the poem. No titles, intro, or explanations.`;

  const response = await fetch(LLAMA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      top_p: 0.9,
      min_p: 0.05,
      presence_penalty: 0.0, // Critical: do not penalize phonetics/rhymes
      max_tokens: 200
    })
  });

  if (!response.ok) {
    throw new Error(`llama-server error (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return cleanLimerick(rawText);
}

async function main() {
  console.log("=== Generating Fig & Orchard Limericks (Strict Rhyme Edition) ===\n");

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

  // Publish to Astro posts directory
  const postSlug = `limerick-batch-${Date.now()}`;
  const blogPostPath = path.join(process.env.HOME, 'sourceverse/posts', `${postSlug}.md`);

  const blogMarkdown = `---
title: "Fig & Orchard Limericks: Batch ${new Date().toLocaleDateString()}"
date: "${new Date().toISOString()}"
author: "Owen Kibel"
tags: ["limericks", "generative-poetry", "hermes4", "botanical"]
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