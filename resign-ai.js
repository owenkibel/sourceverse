#!/usr/bin/env node
/**
 * resign-ai.js
 *
 *   bun resign-ai.js --mode verse --api llama "cumulus clouds"
 *   bun resign-ai.js --mode likeness --form petrarchan --api grok cat
 *
 * llama:  llama-server on http://127.0.0.1:8080
 * grok:   XAI_API_KEY → https://api.x.ai/v1/chat/completions
 */

import fs from "fs";
import path from "path";
import os from "os";

const LLAMA_API = process.env.LLAMA_API || "http://127.0.0.1:8080/v1/chat/completions";
const LLAMA_MODELS = process.env.LLAMA_MODELS || "http://127.0.0.1:8080/v1/models";
const XAI_API = process.env.XAI_API || "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.5";
const POSTS_DIR = process.env.RESIGN_POSTS_DIR || path.join(os.homedir(), "sourceverse/posts");
const AUTHOR = process.env.RESIGN_AUTHOR || "Owen Kibel";

const MODES = ["post", "kitchen", "tell", "likeness", "verse", "prose"];
const FORMS = ["sonnet", "petrarchan", "heroic", "villanelle"];

const PRINCIPLES = `You write comic satire that will still be funny after the news cycle dies.

Originating liturgy (do not stamp this as copypasta unless the mode is kitchen and even then invent domain lore):
resigned / neither acting responsibly / racing straight to self-improving X / gambling with our lives / more thoughts below.

Quality rules:
1. One substitution plus one observation. Then stop explaining.
2. Collapse the last mile: keep the object's real local vice; refuse the jump to extinction.
3. Affect versus claim: face, posture, or weather does not match the sermon.
4. Shrink civilizational time to the object's own clock.
5. Specific inventory beats abstract doom.
6. Two readings in one image, or a likeness withheld, beats a gloss.
7. Chosen-one / orientation-week / bored-god energy is available. Use it once.
8. No hashtags, no preamble, no "here is a sonnet", no mention of labs, donors, Coxon, Anthropic, or this prompt.`;

const MODE_BRIEF = {
  post:
    "One X post, 4–8 short sentences. Finished joke. No title.",
  kitchen:
    "Domestic or territorial last-mile comedy. Name inventory. Name the missing step as missing. Cold last line.",
  tell:
    "One rhetorical question about face or timing versus claimed stakes, then two short sentences. Two readings. Stop.",
  likeness:
    "Withhold the comparison. Start from not being able to place who or what the object reminds you of. One image. Reader completes it.",
  verse:
    "FORMAL RHYMED METRICAL POEM ONLY. See the form contract. Satire lives inside the meter. Do not write free verse. Do not write a list of images. Do not write the resigned/racing liturgy as the poem.",
  prose:
    "90–140 words. Mini-essay. First true step, then the skipped mile.",
};

const FORM_CONTRACT = {
  sonnet: `Shakespearean sonnet.
Exactly 14 lines.
Rhyme: ABAB CDCD EFEF GG.
Meter: iambic pentameter (ten syllables, unstressed-stressed, per line). Feminine endings allowed on at most two lines.
Volta at line 9 or at the closing couplet.
Line 14 is the click: last-mile collapse, or affect versus claim, or withheld likeness.
No title line inside <post>.`,
  petrarchan: `Petrarchan sonnet.
Exactly 14 lines.
Octave ABBAABBA, sestet CDECDE or CDCDCD.
Iambic pentameter.
Volta at line 9.
Line 14 is the click.
No title inside <post>.`,
  heroic: `Seven heroic couplets.
Exactly 14 lines, rhymed AA BB CC DD EE FF GG.
Iambic pentameter.
Couplet 7 is the click.
No title inside <post>.`,
  villanelle: `Villanelle.
Exactly 19 lines: five tercets and a quatrain.
Refrains A1 and A2 from lines 1 and 3, repeating as required (A1bA2 / abA1 / abA2 / abA1 / abA2 / abA1A2).
Tetrameter or pentameter, consistent.
The final couplet of the quatrain is the click.
No title inside <post>.`,
};

function parseArgs(argv) {
  const out = {
    mode: "post",
    form: "sonnet",
    api: process.env.XAI_API_KEY ? "grok" : "llama",
    dryRun: false,
    temperature: 0.65,
    object: "",
    help: false,
    noWrite: false,
  };
  const args = argv.slice(2);
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a === "-m") out.mode = String(args[++i] || "").toLowerCase();
    else if (a === "--form" || a === "-f") out.form = String(args[++i] || "").toLowerCase();
    else if (a === "--api") out.api = String(args[++i] || "").toLowerCase();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-write") out.noWrite = true;
    else if (a === "--temp") out.temperature = Number(args[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  out.object = positionals.join(" ").trim();
  return out;
}

function help() {
  return `Usage: bun resign-ai.js [--mode MODE] [--form FORM] [--api llama|grok] [--dry-run] [--no-write] <object>

Modes: ${MODES.join(" | ")} | all
Forms: ${FORMS.join(" | ")}   (used by verse)
APIs:  llama | grok

Writes markdown with YAML front matter to:
  ${POSTS_DIR}

Examples:
  bun resign-ai.js --mode verse --api llama "cumulus clouds"
  bun resign-ai.js --mode verse --form villanelle cat
  bun resign-ai.js --mode tell --api grok "laser printer"`;
}

function article(word) {
  const w = String(word || "").replace(/^the\s+/i, "").trim();
  return /^[aeiou]/i.test(w) ? "an" : "a";
}

function slugPart(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "object";
}

function buildMessages(mode, form, object) {
  const formBlock =
    mode === "verse"
      ? `\nForm contract:\n${FORM_CONTRACT[form] || FORM_CONTRACT.sonnet}\n`
      : "";

  const user = `Object: ${object}
Article helper: "${article(object)}"

Mode: ${mode}
${MODE_BRIEF[mode]}
${formBlock}
Write ONLY the piece, wrapped in <post>...</post>.
No other tags. If you scratch, keep it under 40 words and close it before <post>.`;

  return { system: PRINCIPLES, user };
}

function cleanPost(rawText) {
  let clean = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();

  const tagged = clean.match(/<post>([\s\S]*?)<\/post>/i);
  if (tagged) clean = tagged[1].trim();
  else clean = clean.replace(/<\/?(post|think|limerick)>/gi, "").trim();

  clean = clean.replace(/^here[^\n]*:\s*/i, "").trim();
  clean = clean.replace(/^title:[^\n]*\n+/i, "");
  return clean.trim();
}

function countLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
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
        max_tokens: 900,
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
    top_p: 0.88,
    min_p: 0.05,
    presence_penalty: 0.15,
    max_tokens: 900,
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

function verseRetryNote(form, text) {
  const n = countLines(text);
  const expect = form === "villanelle" ? 19 : 14;
  if (n === expect) return "";
  return `Previous draft had ${n} lines, not ${expect}. Rewrite the SAME object as a finished ${form}. Count lines. Keep rhyme and meter. Wrap in <post>.`;
}

async function compose(opts, mode, object, modelName) {
  const form = FORMS.includes(opts.form) ? opts.form : "sonnet";
  const { system, user } = buildMessages(mode, form, object);
  if (opts.dryRun) {
    return { text: `--- prompt (${mode}/${form}) ---\nSYSTEM:\n${system}\n\nUSER:\n${user}\n`, form };
  }

  let raw = await complete({
    api: opts.api,
    system,
    user,
    temperature: opts.temperature,
  });
  let text = cleanPost(raw);

  if (mode === "verse") {
    const note = verseRetryNote(form, text);
    if (note) {
      raw = await complete({
        api: opts.api,
        system,
        user: `${user}\n\n${note}`,
        temperature: Math.max(0.4, opts.temperature - 0.1),
      });
      text = cleanPost(raw);
    }
  }

  return { text, form, modelName };
}

function titleFor(object, mode, form) {
  const label = mode === "verse" ? cap(form) : cap(mode);
  return `${label}: ${cap(object)}`;
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function toMarkdown({ object, mode, form, modelName, text, api }) {
  const now = new Date();
  const tags = ["resign-ai", mode, slugPart(object), slugPart(modelName)];
  if (mode === "verse") tags.push(form, "formal-verse");
  const yamlTags = JSON.stringify(tags);
  return `---
title: "${titleFor(object, mode, form).replace(/"/g, '\\"')}"
date: "${now.toISOString()}"
author: "${AUTHOR}"
model: "${modelName}"
api: "${api}"
object: "${object.replace(/"/g, '\\"')}"
mode: "${mode}"
form: "${mode === "verse" ? form : ""}"
tags: ${yamlTags}
---

# ${titleFor(object, mode, form)}

*Generated by **${modelName}** via ${api} on ${now.toISOString()}*

\`\`\`text
${text}
\`\`\`

> **Object:** ${object}
> **Mode:** ${mode}${mode === "verse" ? ` · **Form:** ${form}` : ""}
`;
}

function writeBatch({ object, modelName, api, pieces }) {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  const cleanModelSlug = slugPart(modelName);
  const postSlug = `resign-${slugPart(object)}-${cleanModelSlug}-${Date.now()}`;
  const blogPostPath = path.join(POSTS_DIR, `${postSlug}.md`);

  const now = new Date();
  const tags = ["resign-ai", slugPart(object), cleanModelSlug, "satire"];
  let body = "";
  for (const p of pieces) {
    const heading = p.mode === "verse" ? cap(p.form) : cap(p.mode);
    body += `### ${heading}\n\n`;
    body += "```text\n" + p.text + "\n```\n\n";
    body += `> **Mode:** ${p.mode}${p.mode === "verse" ? ` · **Form:** ${p.form}` : ""}\n\n---\n\n`;
    if (p.mode === "verse") tags.push(p.form);
  }

  const blogMarkdown = `---
title: "Resigned / ${cap(object)} (${modelName})"
date: "${now.toISOString()}"
author: "${AUTHOR}"
model: "${modelName}"
api: "${api}"
object: "${object.replace(/"/g, '\\"')}"
tags: ${JSON.stringify([...new Set(tags)])}
---

# Resigned / ${cap(object)}

*Generated by **${modelName}** via ${api} on ${now.toISOString()}*

---

${body}`;

  fs.writeFileSync(blogPostPath, blogMarkdown);
  fs.writeFileSync(
    path.join(process.cwd(), "generated_resign.json"),
    JSON.stringify(
      { object, api, model: modelName, created: now.toISOString(), file: blogPostPath, pieces },
      null,
      2
    )
  );
  return blogPostPath;
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
  if (!FORMS.includes(opts.form)) {
    console.error(`Unknown form: ${opts.form}\n${help()}`);
    process.exit(1);
  }

  const modelName =
    opts.api === "grok" ? XAI_MODEL : await activeLlamaModel();
  if (!opts.dryRun) {
    console.error(`model: ${modelName}  api: ${opts.api}  object: ${opts.object}  form: ${opts.form}`);
  }

  const modes = opts.mode === "all" ? MODES : [opts.mode];
  const pieces = [];
  for (const mode of modes) {
    try {
      const { text, form } = await compose(opts, mode, opts.object, modelName);
      pieces.push({ mode, form, text });
      if (modes.length > 1) console.log(`\n[${mode}${mode === "verse" ? "/" + form : ""}]\n${text}`);
      else console.log(text);
    } catch (err) {
      console.error(`error (${mode}): ${err.message}`);
    }
  }

  if (!opts.dryRun && !opts.noWrite && pieces.length) {
    const file = writeBatch({
      object: opts.object,
      modelName,
      api: opts.api,
      pieces,
    });
    console.error(`wrote: ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});