#!/usr/bin/env node
/**
 * liturgy-ai.js
 *
 *   bun liturgy-ai.js --mode verse --liturgy lastmile --api llama "cumulus clouds"
 *   bun liturgy-ai.js --mode post --liturgy likeness cat
 *   bun liturgy-ai.js --mode verse --liturgy none --form sonnet "group chat"
 *
 * llama:  http://127.0.0.1:8080
 * grok:   XAI_API_KEY → https://api.x.ai/v1/chat/completions
 */

import fs from "fs";
import path from "path";
import os from "os";

const LLAMA_API = process.env.LLAMA_API || "http://127.0.0.1:8080/v1/chat/completions";
const LLAMA_MODELS = process.env.LLAMA_MODELS || "http://127.0.0.1:8080/v1/models";
const XAI_API = process.env.XAI_API || "https://api.x.ai/v1/chat/completions";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.5";
const POSTS_DIR = process.env.LITURGY_POSTS_DIR || path.join(os.homedir(), "sourceverse/posts");

const MODES = ["post", "kitchen", "tell", "likeness", "verse", "prose"];
const FORMS = ["sonnet", "petrarchan", "heroic", "villanelle"];
const LITURGIES = ["resign", "face", "likeness", "lastmile", "bulletin", "none"];

const CRAFT = `You write comic satire that remains readable after the week that produced it.

Craft:
1. One substitution plus one observation. Then stop explaining.
2. Collapse the last mile: keep the object's real local vice; do not jump to the end of the world.
3. Affect versus claim: face, posture, weather, or timing does not match the sermon.
4. Shrink grand clocks to the object's own clock.
5. Specific inventory beats abstract catastrophe.
6. Two readings in one image, or a likeness withheld, beats a gloss.
7. Chosen-one / orientation-week / bored-god energy may appear once.
8. No hashtags, no preamble, no "here is a sonnet", no labs, donors, or this prompt.`;

const LITURGY_TEXT = {
  resign: `Originating liturgy (use as pressure, not as a stamp):
resigned / neither acting responsibly / racing straight to self-improving X / gambling with our lives / more thoughts below.
Invent domain lore. Never write "I resigned from {Object} Corp."`,

  face: `Originating liturgy:
Is this the face you wanted for the claim being made.
Two readings of the same expression. Stop.
Energy: smug priesthood, or stoked about next semester.`,

  likeness: `Originating liturgy:
I can't put my finger on who or what this reminds me of.
Withhold the name. Let the reader finish the likeness.`,

  lastmile: `Originating liturgy:
You cannot reach the advertised ending without intermediate steps.
Name the first true step. Name the missing mile as missing.
Do not supply the apocalypse.`,

  bulletin: `Originating liturgy:
A calm official notice about a small system behaving as if it were a ministry.
Inventory, deadline, annexation. No sirens.`,

  none: `No inherited liturgy.
Write from the object alone. The joke must stand if no resignation, no lab, and no news cycle ever existed.`,
};

const MODE_BRIEF = {
  post: "One X post, 4–8 short sentences. Finished. No title.",
  kitchen:
    "Territorial last-mile comedy. Name inventory. Name the missing step as missing. Cold last line.",
  tell:
    "One question about face or timing versus claimed stakes, then two short sentences. Two readings. Stop.",
  likeness:
    "Withhold the comparison. One image. The reader completes it.",
  verse:
    "FORMAL RHYMED METRICAL POEM ONLY. Obey the form contract. Satire lives inside the meter. Not free verse. Not a list of images. Not a pasted liturgy.",
  prose:
    "90–140 words. First true step, then the skipped mile.",
};

const FORM_CONTRACT = {
  sonnet: `Shakespearean sonnet.
Exactly 14 lines.
Rhyme ABAB CDCD EFEF GG.
Iambic pentameter. At most two feminine endings.
Volta at line 9 or the couplet.
Line 14 is the click.
No title inside <post>.`,
  petrarchan: `Petrarchan sonnet.
Exactly 14 lines.
Octave ABBAABBA. Sestet CDECDE or CDCDCD.
Iambic pentameter. Volta at line 9.
Line 14 is the click.
No title inside <post>.`,
  heroic: `Seven heroic couplets.
Exactly 14 lines, AA BB CC DD EE FF GG.
Iambic pentameter.
Couplet 7 is the click.
No title inside <post>.`,
  villanelle: `Villanelle.
Exactly 19 lines: five tercets and a quatrain.
Refrains A1 and A2 as required.
Consistent tetra- or pentameter.
Final two lines are the click.
No title inside <post>.`,
};

function parseArgs(argv) {
  const out = {
    mode: "post",
    form: "sonnet",
    liturgy: "none",
    api: process.env.XAI_API_KEY ? "grok" : "llama",
    dryRun: false,
    noWrite: false,
    temperature: 0.65,
    object: "",
    help: false,
  };
  const args = argv.slice(2);
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--mode" || a === "-m") out.mode = String(args[++i] || "").toLowerCase();
    else if (a === "--form" || a === "-f") out.form = String(args[++i] || "").toLowerCase();
    else if (a === "--liturgy" || a === "-l") out.liturgy = String(args[++i] || "").toLowerCase();
    else if (a === "--api") out.api = String(args[++i] || "").toLowerCase();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-write") out.noWrite = true;
    else if (a === "--temp") out.temperature = Number(args[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  out.object = positionals.join(" ").trim();
  if (out.mode === "kitchen" && out.liturgy === "none") out.liturgy = "lastmile";
  if (out.mode === "tell" && out.liturgy === "none") out.liturgy = "face";
  if (out.mode === "likeness" && out.liturgy === "none") out.liturgy = "likeness";
  return out;
}

function help() {
  return `Usage: bun liturgy-ai.js [--mode MODE] [--liturgy LITURGY] [--form FORM] [--api llama|grok] <object>

Modes:     ${MODES.join(" | ")} | all
Liturgies: ${LITURGIES.join(" | ")}
Forms:     ${FORMS.join(" | ")}   (verse)

author in the markdown file is the exact model name.
There is no separate model field.

Examples:
  bun liturgy-ai.js --mode verse --liturgy lastmile --api llama "cumulus clouds"
  bun liturgy-ai.js --mode post --liturgy resign cat
  bun liturgy-ai.js --mode verse --liturgy none --form sonnet "group chat"`;
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

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function buildMessages(mode, form, liturgy, object) {
  const formBlock =
    mode === "verse"
      ? `\nForm contract:\n${FORM_CONTRACT[form] || FORM_CONTRACT.sonnet}\n`
      : "";
  const liturgyBlock = LITURGY_TEXT[liturgy] || LITURGY_TEXT.none;

  const user = `Object: ${object}
Article helper: "${article(object)}"

Mode: ${mode}
${MODE_BRIEF[mode]}

Liturgy: ${liturgy}
${liturgyBlock}
${formBlock}
Write ONLY the piece, wrapped in <post>...</post>.
No other tags. If you scratch, keep it under 40 words and close it before <post>.`;

  return { system: CRAFT, user };
}

function cleanPost(rawText) {
  let clean = String(rawText || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();

  const tagged = clean.match(/<post>([\s\S]*?)<\/post>/i);
  if (tagged) clean = tagged[1].trim();
  else clean = clean.replace(/<\/?(post|think|limerick)>/gi, "").trim();

  return clean.replace(/^here[^\n]*:\s*/i, "").replace(/^title:[^\n]*\n+/i, "").trim();
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

async function compose(opts, mode, object) {
  const form = FORMS.includes(opts.form) ? opts.form : "sonnet";
  const liturgy = LITURGIES.includes(opts.liturgy) ? opts.liturgy : "none";
  const { system, user } = buildMessages(mode, form, liturgy, object);

  if (opts.dryRun) {
    return {
      text: `--- prompt (${mode}/${form}/${liturgy}) ---\nSYSTEM:\n${system}\n\nUSER:\n${user}\n`,
      form,
      liturgy,
    };
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

  return { text, form, liturgy };
}

function headingFor(mode, form) {
  return mode === "verse" ? cap(form) : cap(mode);
}

function writeBatch({ object, author, api, liturgy, pieces }) {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  const now = new Date();
  const postSlug = `liturgy-${slugPart(object)}-${slugPart(author)}-${Date.now()}`;
  const blogPostPath = path.join(POSTS_DIR, `${postSlug}.md`);

  const tags = [
    "liturgy-ai",
    slugPart(object),
    slugPart(author),
    slugPart(liturgy),
    "satire",
  ];

  let body = "";
  for (const p of pieces) {
    body += `### ${headingFor(p.mode, p.form)}\n\n`;
    body += "```text\n" + p.text + "\n```\n\n";
    body += `> **Mode:** ${p.mode}`;
    if (p.mode === "verse") body += ` · **Form:** ${p.form}`;
    body += ` · **Liturgy:** ${p.liturgy}\n\n---\n\n`;
    tags.push(p.mode);
    if (p.mode === "verse") tags.push(p.form);
  }

  const blogMarkdown = `---
title: "${cap(object)} / ${cap(liturgy)}"
date: "${now.toISOString()}"
author: "${author.replace(/"/g, '\\"')}"
api: "${api}"
object: "${object.replace(/"/g, '\\"')}"
liturgy: "${liturgy}"
tags: ${JSON.stringify([...new Set(tags)])}
---

# ${cap(object)}

*Composed by **${author}** via ${api} on ${now.toISOString()}*

---

${body}`;

  fs.writeFileSync(blogPostPath, blogMarkdown);
  fs.writeFileSync(
    path.join(process.cwd(), "generated_liturgy.json"),
    JSON.stringify(
      { object, api, author, liturgy, created: now.toISOString(), file: blogPostPath, pieces },
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
  if (!FORMS.includes(opts.form) || !LITURGIES.includes(opts.liturgy)) {
    console.error(help());
    process.exit(1);
  }

  const author = opts.api === "grok" ? XAI_MODEL : await activeLlamaModel();
  if (!opts.dryRun) {
    console.error(
      `author: ${author}  api: ${opts.api}  object: ${opts.object}  liturgy: ${opts.liturgy}  form: ${opts.form}`
    );
  }

  const modes = opts.mode === "all" ? MODES : [opts.mode];
  const pieces = [];
  for (const mode of modes) {
    try {
      const { text, form, liturgy } = await compose(opts, mode, opts.object);
      pieces.push({ mode, form, liturgy, text });
      const tag = mode === "verse" ? `${mode}/${form}` : mode;
      if (modes.length > 1) console.log(`\n[${tag} · ${liturgy}]\n${text}`);
      else console.log(text);
    } catch (err) {
      console.error(`error (${mode}): ${err.message}`);
    }
  }

  if (!opts.dryRun && !opts.noWrite && pieces.length) {
    const file = writeBatch({
      object: opts.object,
      author,
      api: opts.api,
      liturgy: opts.liturgy,
      pieces,
    });
    console.error(`wrote: ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});