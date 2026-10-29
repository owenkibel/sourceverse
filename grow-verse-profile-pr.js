import fs from 'fs/promises';
import path from 'path';
import ogs from 'open-graph-scraper';
import { firefox } from 'playwright';

const PROFILES_DIR = path.join(process.cwd(), 'author-profiles');
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GROK_MODEL = 'grok-4.7';

const args = process.argv.slice(2);
const authorArg = args.find(a => a.startsWith('--author='))?.split('=').slice(1).join('=').trim();
const urlArg = args.find(a => a.startsWith('--url='))?.split('=').slice(1).join('=').trim();
const urlsFileArg = args.find(a => a.startsWith('--urls-file='))?.split('=').slice(1).join('=').trim();
const useGrok = args.includes('--grok');
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1];

const slugify = (t) =>
  (t || 'author')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/^-+|-+$/g, '');

// --- URL Extraction Helpers (Shared with generate-links7.js) ---

function isXUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com';
  } catch {
    return /x\.com|twitter\.com/i.test(String(url));
  }
}

function xStatusId(url) {
  const m = String(url).match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function tweetText(t) {
  return String(t?.text || t?.full_text || '').trim();
}

function tweetHandle(t) {
  return String(t?.author?.screen_name || t?.user_screen_name || t?.authorName || '').toLowerCase();
}

async function fetchXViaFx(url) {
  const id = xStatusId(url);
  if (!id) return null;

  try {
    const res = await fetch(`https://api.fxtwitter.com/2/thread/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-fx-thread' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.thread || data.tweets || [];
      if (parts.length > 1) {
        const root = parts[0];
        const handle = tweetHandle(root);
        const same = parts.filter(p => !handle || tweetHandle(p) === handle);
        const body = same.map(tweetText).filter(Boolean).join('\n\n');
        if (body.length > 100) {
          return {
            title: `${root.author?.name || handle} (@${handle})`,
            text: body
          };
        }
      }
    }
  } catch (_) {}

  for (const ep of [
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`
  ]) {
    try {
      const res = await fetch(ep, {
        headers: { 'User-Agent': 'Mozilla/5.0 Sourceverse-fx' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const t = data.tweet || data;
      const text = tweetText(t);
      if (text) {
        return {
          title: t.author?.name || 'X Post',
          text
        };
      }
    } catch (_) {}
  }
  return null;
}

function extractMainArticleText(html) {
  if (!html) return '';
  let targetHtml = html;
  const articleMatch = html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].trim().length > 200) {
    targetHtml = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i);
    if (mainMatch && mainMatch[1].trim().length > 200) {
      targetHtml = mainMatch[1];
    }
  }
  return targetHtml
    .replace(/<(nav|footer|header|aside|script|style|form)[\s\S]*?>[\s\S]*?<\/\1>/gi, '');
}

async function scrapeColumnText(rawUrl) {
  const url = rawUrl
    .replace(/^https?:\/\/[^/]+\.cdn\.ampproject\.org\/[vc]\/(s\/)?/i, 'https://')
    .replace(/\.amp(\?.*|#.*)?$/i, '');
  console.log(`\n🔎 Extracting column text from: ${url}`);

  if (isXUrl(url)) {
    const fx = await fetchXViaFx(url);
    if (fx?.text && fx.text.length > 220) {
      console.log(`   ✅ Extracted ${fx.text.length} chars via fxtwitter API.`);
      return fx;
    }
  }

  try {
    const { result, html } = await ogs({ url, timeout: 12000 });
    if (html && !isXUrl(url)) {
      const cleanHtml = extractMainArticleText(html);
      const sanitizeHtml = (await import('sanitize-html')).default;
      const sanitized = sanitizeHtml(cleanHtml, {
        allowedTags: ['main', 'article', 'p', 'h1', 'h2', 'h3', 'section', 'blockquote']
      });
      const { convert } = await import('html-to-text');
      const text = convert(sanitized, { wordwrap: false }).replace(/\s+/g, ' ').trim();
      if (text.length > 250) {
        console.log(`   ✅ Extracted ${text.length} chars via OGS/HTML parser.`);
        return { title: result?.ogTitle || 'Column', text };
      }
    }
  } catch (_) {}

  console.log(`   🌐 Launching headless Firefox fallback for full DOM extraction...`);
  const browser = await firefox.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (isXUrl(url)) {
      await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) {
          window.scrollBy(0, 1200);
          await new Promise(r => setTimeout(r, 500));
        }
      });
      await page.waitForTimeout(1200);
    }

    const extracted = await page.evaluate(() => {
      const articleBody =
        document.querySelector('[data-testid="twitterArticleRichTextView"]') ||
        document.querySelector('[data-testid="twitterArticleReadView"]') ||
        document.querySelector('article') ||
        document.querySelector('main');

      const blocks = Array.from(
        (articleBody || document.body).querySelectorAll(
          'p, [data-block="true"], [data-testid="tweetText"], blockquote'
        )
      )
        .map(el => el.innerText.trim())
        .filter(t => t.length > 20);

      return {
        title: document.title || 'Extracted Column',
        text: blocks.join('\n\n')
      };
    });

    await context.close();
    console.log(`   ✅ Extracted ${extracted.text.length} chars via Playwright.`);
    return extracted;
  } finally {
    await browser.close();
  }
}

// --- Iterative Prompt Growth Engine ---

const VERSE_GENRE_TAXONOMY = `
1. HORATIAN_EPISTOLARY_COUPLETS: Conversational iambic pentameter (AABB) with flexible medial caesuras, dry understatement, parenthetical qualification, and polite zeugma (Pope, Dryden, Horatian epistles). Best for cool-headed essayistic prose and understated irony.
2. AUDENESQUE_SOCIETY_QUATRAINS: Crisp iambic tetrameter or pentameter quatrains (ABAB or ABCB) pairing clinical, modern sociological observation with deceptively calm stanzaic symmetry (W.H. Auden, Praed, Wendy Cope). Best for detached cultural and institutional diagnosis.
3. SWIFTIAN_OCTOSYLLABICS: Nimble 4-beat iambic tetrameter couplets (AABB, 8 syllables) with unsentimental, conversational speed and dry punchlines (Jonathan Swift, Matthew Prior). Best for compact, aphoristic X threads and sharp snark.
4. BYRONIC_OTTAVA_RIMA: 8-line iambic pentameter stanzas (ABABABCC) where six lines of patient, worldly observation are punctured by a deadpan two-line couplet clinch. Best for digressive Substack essays.
5. DRY_COMMON_MEASURE_BALLAD: Alternating 8/6 common measure (ABCB) or 14-syllable joined fourteeners with an understated recursive refrain. Best for narrative case studies and folkloric parables.
`;

async function evolveProfileWithLLM(authorName, existingProfile, columnData, sourceUrl) {
  const iterationNum = (existingProfile?.readingsCount || 0) + 1;

  const systemPrompt = `You are a master literary critic, prosodist, and prompt architect.
Your task is to answer a specific counterfactual question across successive readings of a columnist's prose:
"If ${authorName} wrote in formal metrical verse instead of prose—without losing any of their understatement, cognitive posture, dry humor, or syntactic rhythm—what exact genre of verse would they write, and what system prompt will reliably reproduce that poetic voice?"

### AVAILABLE VERSE GENRE TAXONOMY (AUTO-MATCH PERSONA)
${VERSE_GENRE_TAXONOMY}

### RULES FOR ITERATIVE PROMPT GROWTH (READING #${iterationNum})
1. **Separate Invariant Voice from Topical Content:** Do NOT hardcode the specific news topic of a single article into the general style rules. Extract *how* the author thinks, frames premises, qualifies claims, uses understatement/litotes, and lands observations.
2. **Preserve & Refine:** If an existing profile is provided (Readings 1..${iterationNum - 1}), keep its strongest insights, prune anything that proved too narrow, and sharpen the metrical and rhetorical specifications based on the new sample.
3. **Strict Anti-Patterns:** Define what a verse adaptation of ${authorName} must NEVER do (e.g., never use bombastic exclamation marks, never pad lines with archaic "doth/thee/thou", never turn dry understatement into broad slapstick).
4. **Produce a Complete, Self-Contained "masterVersePrompt":** Write the exact system/instruction prompt that another script (generate-links7.js) will use to rewrite a full column by ${authorName} into verse.
5. **Calibration Stanza:** Write a single 4-to-8 line sample stanza adapting one moment from the current text using your newly evolved prompt to prove the meter and tone.`;

  const userPayload = `AUTHOR: ${authorName}
READING NUMBER: #${iterationNum}
SOURCE URL: ${sourceUrl}

${
  existingProfile
    ? `=== EXISTING EVOLVED PROFILE (FROM ${existingProfile.readingsCount} PRIOR READINGS) ===\n${JSON.stringify(
        {
          verseGenreMatch: existingProfile.verseGenreMatch,
          stylisticInvariants: existingProfile.stylisticInvariants,
          antiPatterns: existingProfile.antiPatterns,
          masterVersePrompt: existingProfile.masterVersePrompt
        },
        null,
        2
      )}\n`
    : `=== INITIAL READING (NO PRIOR PROFILE YET) ===\nBuild the foundational verse profile from scratch.`
}

=== NEW PROSE COLUMN SAMPLE (${columnData.title}) ===
${columnData.text.slice(0, 28000)}

Return a valid JSON object matching this exact structure:
{
  "verseGenreMatch": {
    "primaryGenreKey": "One of the taxonomy keys (e.g. HORATIAN_EPISTOLARY_COUPLETS or AUDENESQUE_SOCIETY_QUATRAINS)",
    "formLabel": "Human-readable name of the poetic form",
    "meterAndStanza": "Exact meter, syllable targets, caesura placement, and rhyme scheme",
    "rationale": "Why this poetic form is the exact acoustic analogue of ${authorName}'s prose cadence"
  },
  "stylisticInvariants": {
    "ironicTemperature": "How understatement, litotes, snark, or deadpan detachment operates in their sentences",
    "openingAndClosingMoves": "How they typically enter an argument and how they land a final point",
    "lexicalAndSyntacticHabits": "Characteristic diction, clause structure, parentheticals, and register shifts"
  },
  "antiPatterns": [
    "Explicit rule 1 of what the verse adaptation must avoid",
    "Explicit rule 2..."
  ],
  "deltaSummary": "1-2 sentences describing what Reading #${iterationNum} added, confirmed, or refined in the prompt",
  "masterVersePrompt": "The complete, detailed system prompt to be injected into generate-links7.js when rewriting any column by ${authorName} into verse. Must specify exact stanza form, meter, rhyme discipline, tone, understatement rules, and anti-patterns.",
  "calibrationStanza": "A 4-8 line verse sample adapting a thought from the current column in this exact style"
}`;

if (useGrok) {
    if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY missing for --grok");
    const model = modelArg || DEFAULT_GROK_MODEL;
    console.log(`🧠 Evolving verse profile with Grok (${model}) [reasoning_effort: low]...`);
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPayload }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: 4096,
        reasoning_effort: 'low'
      })
    });
    if (!res.ok) throw new Error(`Grok HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const rawContent = (msg.content || msg.reasoning_content || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return {
      parsed: JSON.parse(rawContent),
      modelUsed: model
    };
  } else {
    const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY1 missing");

    let model = modelArg || DEFAULT_GEMINI_MODEL; // Defaults to gemini-3.8-flash for Phase 1
    if (args.includes('--3.5-lite') || args.includes('--flash-lite')) model = 'gemini-3.5-flash-lite';
    if (args.includes('--3.8-flash')) model = 'gemini-3.8-flash';
    if (args.includes('--4-argon') || args.includes('--argon')) model = 'gemini-4-argon';

    const PHASE1_MODEL_CONFIGS = {
      'gemini-3.5-flash-lite': {
        temperature: 0.5,
        thinkingConfig: { thinkingLevel: 'minimal' }
      },
      'gemini-3.8-flash': {
        temperature: 0.5,
        thinkingConfig: { thinkingLevel: 'low' }
      },
      'gemini-4-argon': {
        thinkingConfig: { thinkingLevel: 'low' }
      }
    };

    const selectedConfig = PHASE1_MODEL_CONFIGS[model] || PHASE1_MODEL_CONFIGS['gemini-3.8-flash'];
    console.log(`🧠 Evolving verse profile with Gemini (${model})...`);

    const GEMINI_VERSE_SAFETY = [
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPayload }] }],
           safetySettings: GEMINI_VERSE_SAFETY,
          generationConfig: {
            ...selectedConfig,
            responseMimeType: 'application/json'
          }
        })
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const rawJson = (data.candidates?.[0]?.content?.parts || [])
      .filter(p => !p.thought && typeof p.text === 'string')
      .map(p => p.text)
      .join('');
    if (!rawJson) throw new Error("Empty JSON response from Gemini.");
// Inside evolveProfileWithLLM in grow-verse-profile.js:
    const cleanJson = rawJson
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return {
      parsed: JSON.parse(cleanJson),
      modelUsed: model
    };
  }
}

async function processSingleUrl(authorName, authorSlug, targetUrl) {
  const profilePath = path.join(PROFILES_DIR, `${authorSlug}.json`);
  const promptMdPath = path.join(PROFILES_DIR, `${authorSlug}-prompt.md`);

  let existingProfile = null;
  try {
    existingProfile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  } catch (_) {}

  if (existingProfile?.ingestedUrls?.includes(targetUrl) && !args.includes('--force')) {
    console.log(`⏭️  URL already ingested into ${authorSlug}.json (use --force to re-read): ${targetUrl}`);
    return;
  }

  const columnData = await scrapeColumnText(targetUrl);
  if (!columnData?.text || columnData.text.length < 80) {
    console.error(`❌ Could not extract sufficient prose from ${targetUrl}`);
    return;
  }

  const { parsed, modelUsed } = await evolveProfileWithLLM(
    authorName,
    existingProfile,
    columnData,
    targetUrl
  );

  const readingsCount = (existingProfile?.readingsCount || 0) + 1;
  const ingestedUrls = [...new Set([...(existingProfile?.ingestedUrls || []), targetUrl])];
  const evolutionLog = [
    ...(existingProfile?.evolutionLog || []),
    {
      reading: readingsCount,
      timestamp: new Date().toISOString(),
      url: targetUrl,
      title: columnData.title,
      modelUsed,
      genreMatched: parsed.verseGenreMatch?.primaryGenreKey,
      deltaSummary: parsed.deltaSummary,
      calibrationStanza: parsed.calibrationStanza
    }
  ];

  const updatedProfile = {
    authorName,
    authorSlug,
    readingsCount,
    lastUpdated: new Date().toISOString(),
    lastModelUsed: modelUsed,
    ingestedUrls,
    verseGenreMatch: parsed.verseGenreMatch,
    stylisticInvariants: parsed.stylisticInvariants,
    antiPatterns: parsed.antiPatterns,
    masterVersePrompt: parsed.masterVersePrompt,
    latestCalibrationStanza: parsed.calibrationStanza,
    evolutionLog
  };

  await fs.mkdir(PROFILES_DIR, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify(updatedProfile, null, 2) + '\n', 'utf8');

  // Also write a human-readable Markdown inspect card
  const mdReport = `# Prosodic Persona Profile: ${authorName} (Reading #${readingsCount})

- **Matched Verse Genre:** \`${parsed.verseGenreMatch.primaryGenreKey}\` — ${parsed.verseGenreMatch.formLabel}
- **Meter & Stanza:** ${parsed.verseGenreMatch.meterAndStanza}
- **Rationale:** ${parsed.verseGenreMatch.rationale}
- **Latest Refinement (Reading #${readingsCount}):** ${parsed.deltaSummary}

## Master Versification Prompt (Injected into \`generate-links7.js\`)

\`\`\`text
${parsed.masterVersePrompt}
\`\`\`

## Latest Calibration Sample
> ${parsed.calibrationStanza.split('\n').join('\n> ')}
`;
  await fs.writeFile(promptMdPath, mdReport, 'utf8');

  console.log(`\n======================================================================`);
  console.log(`✅ [${authorName}] Profile evolved to Reading #${readingsCount}`);
  console.log(`   🎭 Matched Genre : ${parsed.verseGenreMatch.primaryGenreKey} (${parsed.verseGenreMatch.formLabel})`);
  console.log(`   📏 Meter Spec    : ${parsed.verseGenreMatch.meterAndStanza}`);
  console.log(`   🔄 Refinement    : ${parsed.deltaSummary}`);
  console.log(`   📄 Saved JSON    : ${profilePath}`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`📜 Calibration Stanza:\n\n${parsed.calibrationStanza}`);
  console.log(`======================================================================\n`);
}

async function main() {
  if (!authorArg || (!urlArg && !urlsFileArg)) {
    console.log(`Usage:
  Single URL : bun grow-verse-profile.js --author="Black 101" --url="https://..."
  Batch File : bun grow-verse-profile.js --author="Black 101" --urls-file=black101-urls.txt
  Options    : --grok (use Grok 4.7 instead of Gemini 3.8 Flash) | --model=gemini-4-argon | --force`);
    process.exit(1);
  }

  const authorSlug = slugify(authorArg);
  const urlsToRead = [];

  if (urlArg) urlsToRead.push(urlArg);
  if (urlsFileArg) {
    const rawList = await fs.readFile(urlsFileArg, 'utf8');
    rawList
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .forEach(u => urlsToRead.push(u));
  }

  for (const u of urlsToRead) {
    await processSingleUrl(authorArg, authorSlug, u);
  }
}

main().catch(err => {
  console.error("Fatal error in grow-verse-profile:", err);
  process.exit(1);
});