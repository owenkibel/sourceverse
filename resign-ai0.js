#!/usr/bin/env node
/**
 * resign-ai.mjs
 *
 *   node resign-ai.mjs cat
 *   node resign-ai.mjs --mode likeness --api grok "laser printer"
 *   node resign-ai.mjs --mode all --dry-run toddler
 *
 * Needs either:
 *   llama-server on http://127.0.0.1:8080  (attached expander)
 *   or XAI_API_KEY for https://api.x.ai/v1/chat/completions  (fifth-line)
 */

import fs from "fs";
import path from "path";

const LLAMA_API = process.env.LLAMA_API || "http://127.0.0.1:8080/v1/chat/completions";
const LLAMA_MODELS = process.env.LLAMA_MODELS || "http://127.0.0.1:8080/v1/models";
const XAI_API = process.env.XAI_API || "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.5";

const MODES = ["post", "kitchen", "tell", "likeness", "verse", "prose"];

const PRINCIPLES = `You write short comic satire that will still be funny after the news cycle dies.

The originating event was a lab researcher who resigned with liturgical language:
resigned / neither acting responsibly / racing straight to self-improving X / gambling with our lives / more thoughts below.

That sentence is now copypasta. Do not emit find-and-replace of it unless --mode resign, and even then invent domain lore; never "I resigned from {Object} Corp."

Quality rules:
1. Liturgy only when the object already has a race, a priesthood, or a territory.
2. One substitution plus one observation. Then stop.
3. Collapse the last mile: keep the object's real local vice, refuse the jump to extinction.
4. Affect versus claim: the face, posture, or timing does not match the sermon.
5. Shrink civilizational time to the object's own clock (dinner, 4 a.m., next semester, the next jam).
6. Specific inventory beats abstract doom.
7. Two readings in one line, or a likeness withheld, are better than an explanation.
8. No hashtags, no "here's a poem", no preamble, no mention of Coxon, Anthropic, or this prompt.

Hogwarts / chosen-one / orientation-week energy is available when the object behaves like a protagonist who has just discovered the book is in first person. Use it sparingly.`;

const MODE_BRIEF = {
  post:
    "One X post, 4–8 short sentences. Invent a finished joke from the object. Mix last-mile collapse with one affect or likeness turn. Post-ready. No title.",
  kitchen:
    "Domestic or territorial last-mile comedy. The object already does a small real thing. Inventory is named. The missing step to annexation is named as missing. End near 'I can't live like this' only if it still lands; otherwise find a colder last line.",
  tell:
    "One rhetorical question about face, posture, or timing versus the claimed stakes, then two short sentences. Intersignal rule: offer two readings and stop. Example energy: 'Smug EA look. Or he is just stoked about next semester at Hogwarts.'",
  likeness:
    "Withhold the comparison. 'I can't put my finger on who the {object} reminds me of.' Then a single image-in-words or a single identity that is not explained. Brooks rule: the reader completes the circuit.",
  verse:
    "8–12 short lines. Not a limerick unless the object forces anapests. No title. Last line is the click.",
  prose:
    "90–140 words. Mini-essay. Name the first true step. Name the skipped mile. Do not mention labs or donors.",
};

function parseArgs(argv) {
  const out = {
    mode: "post",
    api: process.env.XAI_API_KEY ? "grok" : "llama",
    dryRun: false,
    temperature: 0.7,
    object: "",
    help: false,
  };
  const args = argv.slice(2);
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a === "-m") out.mode = String(args[++i] || "").toLowerCase();
    else if (a === "--api") out.api = String(args[++i] || "").toLowerCase();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--temp") out.temperature = Number(args[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  out.object = positionals.join(" ").trim();
  return out;
}

function help() {
  return `Usage: node resign-ai.mjs [--mode MODE] [--api llama|grok] [--dry-run] [--temp N] <object>

Modes: ${MODES.join(" | ")} | all
APIs:  llama (127.0.0.1:8080) | grok (XAI_API_KEY)

Examples:
  node resign-ai.mjs cat
  node resign-ai.mjs --mode likeness cat
  node resign-ai.mjs --mode verse --api grok "group chat"
  node resign-ai.mjs --mode all --dry-run printer`;
}

function article(word) {
  const w = String(word || "").replace(/^the\s+/i, "").trim();
  return /^[aeiou]/i.test(w) ? "an" : "a";
}

function buildMessages(mode, object) {
  const brief = MODE_BRIEF[mode];
  const user = `Object: ${object}
Indefinite article helper: "${article(object)}"

Mode: ${mode}
${brief}

Write ONLY the piece, wrapped in <post>...</post>.
No other tags. Keep any internal scratch under 40 words, then close it before <post>.`;

  return { system: PRINCIPLES, user };
}

function cleanPost(rawText) {
  let clean = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();

  const tagged = clean.match(/<post>([\s\S]*?)<\/post>/i);
  if (tagged) return tagged[1].trim();

  clean = clean.replace(/<\/?(post|think|limerick)>/gi, "").trim();
  clean = clean.replace(/^here[^\n]*:\s*/i, "").trim();
  return clean;
}

async function activeLlamaModel() {
  try {
    const res = await fetch(LLAMA_MODELS);
    if (!res.ok) return "llama-local";
    const data = await res.json();
    const rawPath = data.data?.[0]?.id || "";
    return path.basename(rawPath, ".gguf") || "llama-local";
  } catch {
    return "llama-local";
  }
}

async function complete({ api, system, user, temperature }) {
  if (api === "grok") {
    const key = process.env.XAI_API_KEY;
    if (!key) throw new Error("XAI_API_KEY is not set");
    const res = await fetch(XAI_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        temperature,
        reasoning_effort: "low",
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`xAI error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  const modelName = await activeLlamaModel();
  const isGemma = modelName.toLowerCase().includes("gemma");
  const payload = {
    temperature,
    top_p: 0.9,
    min_p: 0.05,
    presence_penalty: 0.2,
    max_tokens: 500,
  };

  if (isGemma) {
    payload.messages = [{ role: "user", content: `${system}\n\n${user}` }];
    payload.chat_template_kwargs = { enable_thinking: false };
  } else {
    payload.messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  const res = await fetch(LLAMA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`llama-server error (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function compose(opts, mode, object) {
  const { system, user } = buildMessages(mode, object);
  if (opts.dryRun) {
    return `--- prompt (${mode}) ---\nSYSTEM:\n${system}\n\nUSER:\n${user}\n`;
  }
  const raw = await complete({
    api: opts.api,
    system,
    user,
    temperature: opts.temperature,
  });
  return cleanPost(raw);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.object) {
    console.log(help());
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.mode !== "all" && !MODES.includes(opts.mode)) {
    console.error(help());
    process.exit(1);
  }

  const modes = opts.mode === "all" ? MODES : [opts.mode];
  if (!opts.dryRun) {
    const label = opts.api === "grok" ? XAI_MODEL : await activeLlamaModel();
    console.error(`model: ${label}  api: ${opts.api}  object: ${opts.object}`);
  }

  const results = [];
  for (const mode of modes) {
    try {
      const text = await compose(opts, mode, opts.object);
      results.push({ mode, text });
      if (modes.length > 1) console.log(`\n[${mode}]\n${text}`);
      else console.log(text);
    } catch (err) {
      console.error(`error (${mode}): ${err.message}`);
    }
  }

  const outPath = path.join(process.cwd(), "generated_resign.json");
  if (!opts.dryRun && results.length) {
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        { object: opts.object, api: opts.api, created: new Date().toISOString(), results },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});