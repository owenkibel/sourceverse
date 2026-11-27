// run_yue.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';

const COMFY_URL = "http://127.0.0.1:8188";
const OUTPUT_DIR = "./images";
const WORKFLOWS_DIR = "./workflows";

const DEFAULT_TEXT_TO_MUSIC_DURATION = 165;
const MAX_SAFE_VRAM_DURATION = 175;
const DEFAULT_YUE_CFG_SCALE = 1.8;
const DEFAULT_YUE_COVER_CFG_SCALE = 1.7; // Lower CFG works cleanly once V: Ins melody bars are promoted into V: Vocal
const DEFAULT_DUCK_LEVEL = 0.32;         // Continuous harmonic bed (~-10 dB) when Kokoro interleaving is explicitly enabled
const DEFAULT_TTS_GAIN = 0.85;

// Warm, singing-forward vocal profiles (avoiding "classical" / "crystalline" cues that cause 20th-c. chromatic drift or glare)
const VOCAL_PROFILES = [
  {
    name: "Bass-Baritone",
    gender: "male",
    stylePrompt: "deep warm bass-baritone male lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, rich intimate resonance"
  },
  {
    name: "Mezzo-Soprano",
    gender: "female",
    stylePrompt: "warm rich contralto and mezzo-soprano female lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, intimate ballad tone"
  },
  {
    name: "Lyric Tenor",
    gender: "male",
    stylePrompt: "warm lyric tenor male lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, graceful acoustic ballad articulation"
  },
  {
    name: "Dramatic Soprano",
    gender: "female",
    stylePrompt: "warm expressive soprano female lead singer, melodic legato singing, sustained vocal vowels, clear sung lyrics, lush resonant tone"
  }
];

function dedupeStyleTags(styleStr) {
  const seen = new Set();
  return styleStr
    .split(',')
    .map(t => t.trim())
    .filter(t => {
      if (!t) return false;
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}

function isValidAbc(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;
  return (/^X:\s*\d+/m.test(trimmed) || trimmed.includes('K:') || trimmed.includes('M:') || trimmed.includes('|'));
}

function sanitizeLyrics(lyrics, { stripLeadingIntro = false, ensureIntroForCover = false } = {}) {
  if (!lyrics || !lyrics.trim()) return "[Instrumental]";
  let cleaned = lyrics
    .replace(/\\n/g, '\n')
    .replace(
      /\s*(\[(?:Intro|Verse[^\]]*|Chorus[^\]]*|Bridge[^\]]*|Outro[^\]]*|Instrumental[^\]]*|Hook[^\]]*)\])\s*/gi,
      '\n\n$1\n'
    )
    .replace(/[ \t]*[|/][ \t]*/g, '\n')
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (!t || t.startsWith('[')) return t;
      // Only break genuinely long lines where both halves stay substantial
      if (t.length > 68) {
        return t
          .replace(/([.;!?—])\s+(?=[A-Za-z"'])/g, '$1\n')
          .replace(/(.{18,}),\s+(?=.{18,})/g, '$1,\n');
      }
      return t;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (stripLeadingIntro) {
    cleaned = cleaned.replace(/^\s*\[(intro|instrumental)[^\]]*\]\s*/i, '').trim();
  }

  if (!cleaned.includes('[')) {
    cleaned = `[Verse 1]\n${cleaned}`;
  }

  if (ensureIntroForCover && !/^\s*\[intro[^\]]*\]/i.test(cleaned)) {
    cleaned = `[Intro]\n\n${cleaned}`;
  }

  return cleaned;
}

function probeAudioDurationSec(filePath, fallbackSec) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const parsed = Math.round(parseFloat(out));
    if (parsed && parsed > 2) {
      return Math.min(parsed, MAX_SAFE_VRAM_DURATION);
    }
  } catch (_) {}
  return fallbackSec;
}

function runFfmpegConform(primaryArgs, fallbackArgs, outputPath) {
  const execPass = (ffArgs) => {
    const res = spawnSync('ffmpeg', ffArgs, { encoding: 'utf8' });
    const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    const ok = res.status === 0 && size > 1024;
    return { ok, status: res.status, stderr: (res.stderr || '').trim(), size };
  };

  const first = execPass(primaryArgs);
  if (first.ok) return;

  console.warn(`⚠️  ffmpeg primary conform failed (exit=${first.status}, bytes=${first.size}):`);
  if (first.stderr) console.warn(first.stderr);

  if (fallbackArgs) {
    console.warn(`🔄 Retrying ffmpeg reference conform without silenceremove...`);
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    const second = execPass(fallbackArgs);
    if (second.ok) {
      console.log(`✅ Fallback ffmpeg conform succeeded (${Math.round(second.size / 1024)} KB).`);
      return;
    }
    throw new Error(
      `ffmpeg fallback conform failed (exit=${second.status}): ${second.stderr || 'no stderr'}`
    );
  }

  throw new Error(
    `ffmpeg conform failed (exit=${first.status}): ${first.stderr || 'no stderr'}`
  );
}

// =========================================================================
// ABC VOCAL PROMOTION (Moves V: Ins melody bars into V: Vocal so YuE2 sings)
// =========================================================================
function hasPitchNotes(barStr) {
  if (!barStr) return false;
  // Strip quoted chord labels and !decorations! before testing for ABC note letters A-G / a-g
  const stripped = barStr.replace(/"[^"]*"/g, '').replace(/![^!]*!/g, '');
  return /[A-Ga-g]/.test(stripped);
}

function expandAbcBars(lineText) {
  const rawTokens = lineText
    .replace(/\r/g, '')
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const bars = [];
  for (const tok of rawTokens) {
    // Expand whole-bar multi-rests like Z4 -> ['Z', 'Z', 'Z', 'Z'] or Z -> ['Z']
    const zMatch = tok.match(/^Z(\d*)$/i);
    if (zMatch && /^Z\d*$/.test(tok)) {
      const count = zMatch[1] ? Math.max(1, parseInt(zMatch[1], 10)) : 1;
      for (let i = 0; i < count; i++) bars.push('Z');
    } else {
      bars.push(tok);
    }
  }
  return bars;
}

function compressAbcBars(bars) {
  if (!bars || bars.length === 0) return 'Z4|';
  const out = [];
  let zRun = 0;

  const flushZ = () => {
    if (zRun > 0) {
      out.push(zRun === 1 ? 'Z' : `Z${zRun}`);
      zRun = 0;
    }
  };

  for (const bar of bars) {
    const t = (bar || '').trim();
    if (!t || t === 'Z') {
      zRun++;
    } else {
      flushZ();
      out.push(t);
    }
  }
  flushZ();
  return out.join('|') + '|';
}

function promoteInsToVocal(rawAbc, { introSystems = 1, midBreak = true } = {}) {
  const lines = rawAbc.replace(/\r\n/g, '\n').split('\n');

  // Split header (up through K:) from body
  let kIdx = lines.findIndex(l => /^\s*K:/i.test(l));
  if (kIdx === -1) {
    return { abc: rawAbc, promotedBars: 0, totalBars: 0, vocalBarsBefore: 0, vocalBarsAfter: 0, systemCount: 0 };
  }

  const headerLines = lines.slice(0, kIdx + 1);
  const bodyLines = lines.slice(kIdx + 1);

  // Parse body into ordered voice blocks + attached comment lines
  const voiceEntries = []; // { voice: 'vocal'|'ins', headerLine, barsText, leadingComments }
  let pendingComments = [];
  let current = null;

  for (const line of bodyLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('%')) {
      if (current) {
        voiceEntries.push(current);
        current = null;
      }
      pendingComments.push(line);
      continue;
    }

    const vMatch = trimmed.match(/^V:\s*(.+)$/i);
    if (vMatch) {
      if (current) voiceEntries.push(current);
      const vName = vMatch[1].trim().toLowerCase();
      const voiceType = vName.startsWith('vocal') || vName === '1' ? 'vocal'
        : (vName.startsWith('ins') || vName === '2' ? 'ins' : 'other');
      current = {
        voice: voiceType,
        headerLine: trimmed,
        musicLines: [],
        leadingComments: pendingComments
      };
      pendingComments = [];
      continue;
    }

    if (current) {
      current.musicLines.push(trimmed);
    } else {
      headerLines.push(line);
    }
  }
  if (current) voiceEntries.push(current);

  // Pair consecutive (vocal, ins) blocks into systems
  const systems = [];
  let i = 0;
  while (i < voiceEntries.length) {
    const a = voiceEntries[i];
    const b = voiceEntries[i + 1];
    if (b && ((a.voice === 'vocal' && b.voice === 'ins') || (a.voice === 'ins' && b.voice === 'vocal'))) {
      const vocalEntry = a.voice === 'vocal' ? a : b;
      const insEntry = a.voice === 'ins' ? a : b;
      systems.push({
        comments: [...a.leadingComments, ...b.leadingComments],
        vocalHeader: vocalEntry.headerLine,
        insHeader: insEntry.headerLine,
        vocalBars: expandAbcBars(vocalEntry.musicLines.join(' ')),
        insBars: expandAbcBars(insEntry.musicLines.join(' '))
      });
      i += 2;
    } else {
      // Unpaired voice block (keep verbatim)
      systems.push({ standalone: a });
      i += 1;
    }
  }

  const pairedIndices = systems
    .map((s, idx) => (s.standalone ? -1 : idx))
    .filter(idx => idx !== -1);
  const totalSystems = pairedIndices.length;

  if (totalSystems === 0) {
    return { abc: rawAbc, promotedBars: 0, totalBars: 0, vocalBarsBefore: 0, vocalBarsAfter: 0, systemCount: 0 };
  }

  const effectiveIntro = Math.min(Math.max(0, introSystems), Math.max(0, totalSystems - 2));
  // Optional 1-system instrumental breather around ~58% through longer songs (between Chorus & Bridge)
  const midBreakOrderIdx = (midBreak && totalSystems >= 10)
    ? Math.max(effectiveIntro + 3, Math.min(totalSystems - 3, Math.round(totalSystems * 0.58)))
    : -1;

  let totalBars = 0;
  let vocalBarsBefore = 0;
  let vocalBarsAfter = 0;
  let promotedBars = 0;

  pairedIndices.forEach((sysIdx, orderIdx) => {
    const sys = systems[sysIdx];
    const nBars = Math.max(sys.vocalBars.length, sys.insBars.length);
    while (sys.vocalBars.length < nBars) sys.vocalBars.push('Z');
    while (sys.insBars.length < nBars) sys.insBars.push('Z');

    totalBars += nBars;
    for (let b = 0; b < nBars; b++) {
      if (hasPitchNotes(sys.vocalBars[b])) vocalBarsBefore++;
    }

    const isIntro = orderIdx < effectiveIntro;
    const isMidBreak = orderIdx === midBreakOrderIdx;

    if (!isIntro && !isMidBreak) {
      for (let b = 0; b < nBars; b++) {
        const vHasNotes = hasPitchNotes(sys.vocalBars[b]);
        const iHasNotes = hasPitchNotes(sys.insBars[b]);
        if (!vHasNotes && iHasNotes) {
          sys.vocalBars[b] = sys.insBars[b];
          sys.insBars[b] = 'Z';
          promotedBars++;
        }
      }
    }

    for (let b = 0; b < nBars; b++) {
      if (hasPitchNotes(sys.vocalBars[b])) vocalBarsAfter++;
    }
  });

  // Reconstruct ABC preserving SheetSage2's exact formatting
  const outLines = [...headerLines];
  pairedIndices.forEach((sysIdx, orderIdx) => {
    const sys = systems[sysIdx];
    if (sys.comments && sys.comments.length > 0) {
      outLines.push(...sys.comments);
    } else if (orderIdx === effectiveIntro && effectiveIntro > 0) {
      outLines.push('% verse');
    }
    outLines.push(sys.vocalHeader);
    outLines.push(compressAbcBars(sys.vocalBars));
    outLines.push(sys.insHeader);
    outLines.push(compressAbcBars(sys.insBars));
  });

  // Append any standalone blocks if present
  for (const sys of systems) {
    if (sys.standalone) {
      if (sys.standalone.leadingComments.length) outLines.push(...sys.standalone.leadingComments);
      outLines.push(sys.standalone.headerLine);
      outLines.push(...sys.standalone.musicLines);
    }
  }
  if (pendingComments.length > 0) outLines.push(...pendingComments);

  return {
    abc: outLines.join('\n').trim(),
    promotedBars,
    totalBars,
    vocalBarsBefore,
    vocalBarsAfter,
    systemCount: totalSystems,
    effectiveIntro,
    midBreakOrderIdx
  };
}

// =========================================================================
// COMFYUI WORKFLOW GRAPH HELPERS (2-Pass SheetSage2 -> YuE2GenerateMusic)
// =========================================================================
function findNodeIdsByClass(workflow, classNames) {
  const targets = new Set(Array.isArray(classNames) ? classNames : [classNames]);
  return Object.keys(workflow).filter(id => workflow[id] && targets.has(workflow[id].class_type));
}

function collectUpstreamIds(workflow, rootIds) {
  const visited = new Set();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = String(stack.pop());
    if (visited.has(id) || !workflow[id]) continue;
    visited.add(id);
    const inputs = workflow[id].inputs || {};
    for (const val of Object.values(inputs)) {
      if (Array.isArray(val) && val.length >= 2 && (typeof val[0] === 'string' || typeof val[0] === 'number')) {
        stack.push(String(val[0]));
      }
    }
  }
  return visited;
}

function buildPass1SheetSageWorkflow(baseWorkflow, sheetSageId, stagedRefAudio) {
  const upstreamIds = collectUpstreamIds(baseWorkflow, [sheetSageId]);
  const pass1 = {};
  for (const id of upstreamIds) {
    pass1[id] = JSON.parse(JSON.stringify(baseWorkflow[id]));
    const node = pass1[id];
    if (stagedRefAudio && node.inputs && (node.class_type === 'LoadAudio' || 'audio' in node.inputs)) {
      if (typeof node.inputs.audio === 'string') {
        node.inputs.audio = stagedRefAudio;
      }
    }
  }
  pass1["999999"] = {
    inputs: { source: [sheetSageId, 0] },
    class_type: "PreviewAny"
  };
  return pass1;
}

async function detectPreferredCotValue(desiredCot) {
  if (!desiredCot) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${COMFY_URL}/object_info/YuE2GenerateMusic`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const info = await res.json();
    const nodeSpec = info?.YuE2GenerateMusic?.input || {};
    const cotSpec = nodeSpec.required?.mode || nodeSpec.optional?.mode || nodeSpec.required?.cot || nodeSpec.optional?.cot;
    if (Array.isArray(cotSpec) && Array.isArray(cotSpec[0])) {
      const allowed = cotSpec[0];
      if (allowed.includes(desiredCot)) return desiredCot;
      const ciMatch = allowed.find(v => typeof v === 'string' && v.toLowerCase() === desiredCot.toLowerCase());
      if (ciMatch) return ciMatch;
    }
  } catch (_) {}
  return null;
}

async function freeComfyMemory() {
  try {
    await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true })
    });
  } catch (_) {}
}

function patchWorkflow(
  workflow,
  {
    style,
    lyrics,
    duration,
    seed,
    stagedRefAudio = null,
    cfgScale = DEFAULT_YUE_CFG_SCALE,
    samplerCfg = null,
    sheetSageIdToReplace = null,
    promotedAbc = null,
    cotValue = null
  }
) {
  const wf = JSON.parse(JSON.stringify(workflow));
  let patchedStyle = false;
  let patchedLyrics = false;
  let patchedAudio = false;
  let replacedAbcLinks = 0;
  let abcGeneratorId = null;

  // Step 1: If Pass 2 with promoted ABC, trace SheetSage2 -> any pass-through PreviewAny -> YuE2GenerateMusic.abc
  // and inject promotedAbc directly, then prune ONLY SheetSage2's exclusive upstream subgraph (never audio/save nodes!).
  if (sheetSageIdToReplace && promotedAbc) {
    const pass1Upstream = collectUpstreamIds(wf, [sheetSageIdToReplace]);

    // Find pass-through PreviewAny / ShowText nodes fed directly by SheetSage2 (e.g. 33:41 -> 33:44 -> 33:25.abc)
    const abcSourceIds = new Set([String(sheetSageIdToReplace)]);
    const passThroughIds = new Set();
    for (const [nodeId, node] of Object.entries(wf)) {
      if (!node || !node.inputs) continue;
      if (node.class_type === 'PreviewAny' || node.class_type === 'ShowText') {
        const src = node.inputs.source || node.inputs.text;
        if (Array.isArray(src) && src.length >= 2 && String(src[0]) === String(sheetSageIdToReplace)) {
          abcSourceIds.add(String(nodeId));
          passThroughIds.add(String(nodeId));
        }
      }
    }

    // Replace every consumer link pointing at SheetSage2 OR its PreviewAny relay with the literal promotedAbc string
    for (const [nodeId, node] of Object.entries(wf)) {
      if (!node || !node.inputs || passThroughIds.has(String(nodeId))) continue;
      for (const [key, val] of Object.entries(node.inputs)) {
        if (Array.isArray(val) && val.length >= 2 && abcSourceIds.has(String(val[0]))) {
          node.inputs[key] = promotedAbc;
          replacedAbcLinks++;
          console.log(`🎼 Injected promoted ABC directly into ${node.class_type} (${nodeId}).${key}`);
        }
      }
    }

    // Fallback: if YuE2GenerateMusic still has an unresolved link or missing abc, inject directly
    if (replacedAbcLinks === 0) {
      for (const [nodeId, node] of Object.entries(wf)) {
        if (node?.class_type === 'YuE2GenerateMusic' && node.inputs && 'abc' in node.inputs) {
          node.inputs.abc = promotedAbc;
          replacedAbcLinks++;
          console.log(`🎼 Injected promoted ABC directly into YuE2GenerateMusic (${nodeId}).abc`);
        }
      }
    }

    // Safe targeted prune: ONLY delete Pass-1 SheetSage2 nodes & its pass-through relays if nothing else references them.
    // All generation, sampling, VAE, and audio save nodes (e.g. SaveAudioAdvanced) remain untouched.
    if (replacedAbcLinks > 0) {
      const candidatesToDrop = new Set([...pass1Upstream, ...passThroughIds]);
      let changed = true;
      let pruned = 0;
      while (changed) {
        changed = false;
        for (const candId of [...candidatesToDrop]) {
          if (!wf[candId]) continue;
          let isReferenced = false;
          for (const [otherId, otherNode] of Object.entries(wf)) {
            if (otherId === candId || !otherNode?.inputs) continue;
            for (const val of Object.values(otherNode.inputs)) {
              if (Array.isArray(val) && val.length >= 2 && String(val[0]) === candId) {
                isReferenced = true;
                break;
              }
            }
            if (isReferenced) break;
          }
          if (!isReferenced) {
            delete wf[candId];
            candidatesToDrop.delete(candId);
            pruned++;
            changed = true;
          }
        }
      }
      if (pruned > 0) {
        console.log(`🧹 Safely pruned ${pruned} Pass-1 SheetSage2 node(s) (preserving all audio/save nodes).`);
      }
    }
  }

  // Step 2: Patch standard YuE2 parameters (preserve linked seed wires like SeedNode -> KSampler)
  for (const nodeId of Object.keys(wf)) {
    const node = wf[nodeId];
    if (!node || !node.inputs) continue;

    if (node.class_type === 'YuE2GenerateABC' || node.class_type === 'SheetSage2AudioToABC') {
      abcGeneratorId = nodeId;
    }

    if ('seed' in node.inputs && typeof node.inputs.seed === 'number') {
      node.inputs.seed = seed;
    }
    if ('style' in node.inputs) { node.inputs.style = style; patchedStyle = true; }
    if ('lyrics' in node.inputs) { node.inputs.lyrics = lyrics; patchedLyrics = true; }
    if ('max_duration' in node.inputs) node.inputs.max_duration = duration;
    if ('duration' in node.inputs && typeof node.inputs.duration === 'number') {
      node.inputs.duration = duration;
    }

    if (node.class_type === 'YuE2GenerateMusic') {
      if ('cfg_scale' in node.inputs) {
        node.inputs.cfg_scale = cfgScale;
        console.log(`🎛️  Set YuE2GenerateMusic.cfg_scale = ${cfgScale}`);
      }
      if (cotValue) {
        if ('mode' in node.inputs) {
          node.inputs.mode = cotValue;
          console.log(`🎛️  Set YuE2GenerateMusic.mode = "${cotValue}"`);
        } else if ('cot' in node.inputs) {
          node.inputs.cot = cotValue;
          console.log(`🎛️  Set YuE2GenerateMusic.cot = "${cotValue}"`);
        }
      }
    }

    if (node.class_type === 'KSampler' && samplerCfg !== null && 'cfg' in node.inputs) {
      node.inputs.cfg = samplerCfg;
      console.log(`🎛️  Set KSampler.cfg = ${samplerCfg}`);
    }

    if (stagedRefAudio && (node.class_type === 'LoadAudio' || 'audio' in node.inputs)) {
      if (typeof node.inputs.audio === 'string') {
        node.inputs.audio = stagedRefAudio;
        patchedAudio = true;
      }
    }
  }

  if (abcGeneratorId && !promotedAbc) {
    wf["999999"] = {
      inputs: { source: [abcGeneratorId, 0] },
      class_type: "PreviewAny"
    };
  }

  return { workflow: wf, patchedStyle, patchedLyrics, patchedAudio, replacedAbcLinks };
}

async function queueAndWaitComfy(workflow, { clientId = "yue2_prod", expectAudio = true, timeoutMs = 600000 } = {}) {
  const payload = { client_id: clientId, prompt: workflow };
  const res = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`ComfyUI Error: ${await res.text()}`);
  const { prompt_id } = await res.json();

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, expectAudio ? 3000 : 1200));

    const historyRes = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    const history = await historyRes.json();
    const record = history[prompt_id];

    const statusStr = record?.status?.status_str;
    if (statusStr === 'error') {
      const errMsgs = JSON.stringify(record?.status?.messages || []).slice(0, 400);
      throw new Error(`ComfyUI Node Error during job ${prompt_id}: ${errMsgs}`);
    }

    const outputs = record?.outputs || {};
    let foundAudio = null;
    let foundScore = null;

    for (const nodeId in outputs) {
      const out = outputs[nodeId];
      if (out?.audio?.length > 0) {
        foundAudio = out.audio[0];
      }
      const candidates = out?.text || out?.string || [];
      for (const candidate of candidates) {
        const candidateStr = String(candidate).trim();
        if (isValidAbc(candidateStr)) {
          foundScore = candidateStr;
        }
      }
    }

    if (expectAudio && foundAudio) {
      return { prompt_id, foundAudio, foundScore };
    }
    // Fail fast if ComfyUI marked the job completed without returning any audio output (prevents 600s silent hang)
    if (expectAudio && record?.status?.completed && !foundAudio) {
      const outputSummary = Object.entries(outputs)
        .map(([nid, o]) => `${nid}:[${Object.keys(o || {}).join(',')}]`)
        .join(' ');
      throw new Error(
        `ComfyUI job ${prompt_id} completed with NO audio output (status=${statusStr || 'done'}, outputs=${outputSummary || 'none'}).`
      );
    }
    if (!expectAudio && (foundScore || record?.status?.completed)) {
      return { prompt_id, foundAudio, foundScore };
    }
    process.stdout.write(".");
  }

  throw new Error(`Timeout waiting for ComfyUI job ${prompt_id}.`);
}

async function main() {
  let conformedRefPath = null;
  let stagedFilename = null;

  try {
    console.log("--- Starting YuE2 3B Generation ---");
    const args = process.argv.slice(2);

    const getArg = (flag) => {
      const idx = args.findIndex(a => a === flag);
      return idx !== -1 ? args[idx + 1] : null;
    };

    const stateFilePath = getArg('--state-file') || 'yue_state.json';
    const tags = getArg('--tags') || "Celtic Folk, Folk";
    const rawLyrics = getArg('--lyrics') || "";
    const requestedDuration = parseInt(getArg('--duration') || '128', 10);

    const refAudioPath = getArg('--ref-audio');
    const ttsAudioPath = getArg('--tts-audio');
    const stanzaFilesArg = getArg('--stanza-files');

    let stanzaPaths = [];
    if (stanzaFilesArg) {
      try {
        const parsed = JSON.parse(stanzaFilesArg);
        if (Array.isArray(parsed)) stanzaPaths = parsed.filter(p => p && fs.existsSync(p));
      } catch (_) {
        stanzaPaths = stanzaFilesArg.split(',').map(s => s.trim()).filter(p => p && fs.existsSync(p));
      }
    }

    const ttsMode = (getArg('--tts-mode') || 'loop').toLowerCase();
    const speechFirst = args.includes('--speech-first');
    const earlyMusicFlag = args.includes('--early-music');
    const refPocket = args.includes('--ref-pocket');
    const noPromoteVocals = args.includes('--no-promote-vocals');
    const noMidBreak = args.includes('--no-mid-break');
    const introSystemsArg = getArg('--intro-systems');
    const introSystems = introSystemsArg !== null
      ? Math.max(0, parseInt(introSystemsArg, 10) || 0)
      : (speechFirst ? 0 : 1);
    const explicitCot = getArg('--cot');

    const duckLevelArg = getArg('--duck-level');
    const ttsGainArg = getArg('--tts-gain');
    const duckLevel = duckLevelArg !== null ? Math.max(0.0, Math.min(1.0, parseFloat(duckLevelArg))) : DEFAULT_DUCK_LEVEL;
    const ttsGain = ttsGainArg !== null ? Math.max(0.1, Math.min(1.5, parseFloat(ttsGainArg))) : DEFAULT_TTS_GAIN;

    const hasInstRef = Boolean(refAudioPath && fs.existsSync(refAudioPath));
    const hasTtsGuide = Boolean(ttsAudioPath && fs.existsSync(ttsAudioPath));
    const hasStanzas = Boolean(hasInstRef && stanzaPaths.length > 0);
    const isCover = hasInstRef || hasTtsGuide;

    const cfgArg = getArg('--cfg');
    const samplerCfgArg = getArg('--sampler-cfg');
    const cfgScale = cfgArg !== null
      ? parseFloat(cfgArg)
      : (isCover ? DEFAULT_YUE_COVER_CFG_SCALE : DEFAULT_YUE_CFG_SCALE);
    const samplerCfg = samplerCfgArg !== null ? parseFloat(samplerCfgArg) : null;

    const seed = Math.floor(Math.random() * 1000000000);

    let selectedVoice = VOCAL_PROFILES[1];
    const lowerTags = tags.toLowerCase();
    if (lowerTags.includes('baritone') || lowerTags.includes('bass')) {
      selectedVoice = VOCAL_PROFILES[0];
    } else if (lowerTags.includes('dramatic soprano')) {
      selectedVoice = VOCAL_PROFILES[3];
    } else if (lowerTags.includes('tenor')) {
      selectedVoice = VOCAL_PROFILES[2];
    }

    // Only engage early-music chamber framing when explicitly flagged OR genuinely early-music tags are present
    // (Do NOT trigger on Australian Bush Band merely because it includes Folk / Celtic Folk)
    const isEarlyMusic =
      earlyMusicFlag ||
      /\b(early music|baroque|renaissance|harpsichord|lute|madrigal|cantata|aria|viola da gamba|continuo|recorder|consort|oswald|scots)\b/i.test(tags);

    const cleanedTags = isEarlyMusic
      ? tags
          .split(',')
          .map(t => t.trim())
          .filter(t => t && !/^classical$/i.test(t))
          .join(', ')
      : tags;

    const compositeStyle = dedupeStyleTags(
      isEarlyMusic
        ? `${selectedVoice.stylePrompt}, continuous melodic singing, lyrical sung early music ballad, Celtic Folk, Folk, modal acoustic melody, ${cleanedTags}, warm wooden chamber acoustics, rich stereo depth, natural hall resonance`
        : `${selectedVoice.stylePrompt}, continuous melodic singing, clear sung vocal melody, ${cleanedTags}, warm balanced acoustic mix, rich stereo depth`
    );

    const vocalsStartAtZero = speechFirst || (hasTtsGuide && !hasInstRef) || (introSystems === 0);
    const pureMusicalCover = hasInstRef && !hasStanzas && !speechFirst && introSystems > 0;
    const formattedLyrics = sanitizeLyrics(rawLyrics, {
      stripLeadingIntro: vocalsStartAtZero,
      ensureIntroForCover: pureMusicalCover
    });

    console.log(`🎼 Composite Style Prompt: "${compositeStyle}"`);

    const workflowFile = isCover
      ? path.join(WORKFLOWS_DIR, 'yue2_cover_api.json')
      : path.join(WORKFLOWS_DIR, 'yue2_text_to_music_api.json');

    if (!fs.existsSync(workflowFile)) {
      throw new Error(`Required ComfyUI API template not found: ${workflowFile}. Please export it from ComfyUI first.`);
    }

    let effectiveDuration = requestedDuration;
    if (!isCover && requestedDuration >= 90 && requestedDuration < DEFAULT_TEXT_TO_MUSIC_DURATION) {
      effectiveDuration = DEFAULT_TEXT_TO_MUSIC_DURATION;
      console.log(`⏱️ [Text-to-Music] Extending target duration from ${requestedDuration}s -> ${effectiveDuration}s for full lyric completion.`);
    } else if (hasInstRef) {
      effectiveDuration = probeAudioDurationSec(refAudioPath, DEFAULT_TEXT_TO_MUSIC_DURATION);
      console.log(`⏱️ [Cover Mode] Locking duration to reference track length: ${effectiveDuration}s`);
    } else if (hasTtsGuide) {
      effectiveDuration = Math.max(requestedDuration, DEFAULT_TEXT_TO_MUSIC_DURATION);
      console.log(`⏱️ [Pure Kokoro Cover Mode] Setting duration to ${effectiveDuration}s (mode: ${ttsMode})`);
    }

    const baseWorkflow = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));

    if (isCover) {
      // Stage as 16-bit PCM WAV (avoids FFmpeg FLAC encoder "invalid block size" crashes from variable-length silenceremove frames)
      conformedRefPath = path.join(os.tmpdir(), `yue_ref_${Date.now()}.wav`);
      const bachCleanFilter =
        'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-42dB:stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB,asetnsamples=n=4096:p=0';
      const refPocketFilter = refPocket ? ',equalizer=f=1800:t=q:w=1.2:g=-2.5' : '';
      const ttsSilenceStrip =
        'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-42dB,asetnsamples=n=4096:p=0';
      const fadeStart = Math.max(5, effectiveDuration - 4.5);
      const outCodecArgs = ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-t', String(effectiveDuration), conformedRefPath];

      if (hasStanzas) {
        const stanzas = stanzaPaths.map(p => {
          const out = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim();
          return { path: p, dur: Math.max(0.5, parseFloat(out) || 4.0) };
        });

        const N = stanzas.length;
        const totalSpeechDur = stanzas.reduce((acc, s) => acc + s.dur, 0);
        const usableDur = Math.max(totalSpeechDur + 4.0, effectiveDuration - 2.5);
        const gapDivisor = Math.max(1, speechFirst ? N : (N + 1));
        const bachGap = Math.max(1.5, (usableDur - totalSpeechDur) / gapDivisor);

        let cursor = speechFirst ? 0.0 : bachGap;
        const windows = [];
        for (const st of stanzas) {
          if (cursor + st.dur > effectiveDuration - 2.5) break;
          windows.push({ path: st.path, start: cursor, end: cursor + st.dur, dur: st.dur });
          cursor += st.dur + bachGap;
        }

        console.log(
          `🎚️  Interleaving ${windows.length} Kokoro stanzas over CONTINUOUS ducked music (${speechFirst ? 'Speech-First @ 0.00s' : 'Music-First'}, bed duck=${duckLevel}, tts gain=${ttsGain}):`
        );
        const inputArgs = ['-i', refAudioPath, ...windows.flatMap(w => ['-i', w.path])];
        const duckExprs = windows.map(w => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`).join('+');

        const buildStanzaFg = (cleanLead) => {
          const leadChain = cleanLead ? `${cleanLead}${refPocketFilter},` : (refPocket ? `${refPocketFilter.slice(1)},` : '');
          let fg = `[0:a]${leadChain}apad=whole_dur=${effectiveDuration},volume=${duckLevel}:enable='${duckExprs}':eval=frame[bach_ducked];`;
          const mixLabels = ['[bach_ducked]'];
          windows.forEach((w, idx) => {
            const inIdx = idx + 1;
            const delayMs = Math.round(w.start * 1000);
            const fadeOutSt = Math.max(0, w.dur - 0.08).toFixed(3);
            fg += `[${inIdx}:a]volume=${ttsGain},afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutSt}:d=0.08,adelay=${delayMs}|${delayMs}[st${idx}];`;
            mixLabels.push(`[st${idx}]`);
          });
          fg += `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,alimiter=limit=-1.2dB,afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;
          return fg;
        };

        runFfmpegConform(
          ['-v', 'error', '-y', ...inputArgs, '-filter_complex', buildStanzaFg(bachCleanFilter), ...outCodecArgs],
          ['-v', 'error', '-y', ...inputArgs, '-filter_complex', buildStanzaFg(''), ...outCodecArgs],
          conformedRefPath
        );
      } else if (hasTtsGuide && !hasInstRef) {
        const buildTtsFilter = (strip) => {
          const prefix = strip ? `${strip},` : '';
          return ttsMode === 'once'
            ? `[0:a]${prefix}apad=pad_dur=${effectiveDuration},atrim=0:${effectiveDuration}`
            : `[0:a]${prefix}apad=pad_dur=1.5,aloop=loop=-1:size=2e+09,afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;
        };

        console.log(`🎙️ Staging PURE Kokoro speech from t=0s (${ttsMode})...`);
        runFfmpegConform(
          ['-v', 'error', '-y', '-i', ttsAudioPath, '-filter_complex', buildTtsFilter(ttsSilenceStrip), ...outCodecArgs],
          ['-v', 'error', '-y', '-i', ttsAudioPath, '-filter_complex', buildTtsFilter(''), ...outCodecArgs],
          conformedRefPath
        );
      } else {
        const primaryFilter = `${bachCleanFilter}${refPocketFilter},afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;
        const fallbackFilter = `${refPocket ? `${refPocketFilter.slice(1)},` : ''}afade=t=out:st=${fadeStart}:d=2.5,apad=pad_dur=3,atrim=0:${effectiveDuration}`;
        console.log(`⚡ Conforming pure musical cover reference for [${selectedVoice.name}] (${effectiveDuration}s, cfg=${cfgScale}${refPocket ? ', temp ref-pocket ON' : ''})...`);
        runFfmpegConform(
          ['-v', 'error', '-y', '-i', refAudioPath, '-af', primaryFilter, ...outCodecArgs],
          ['-v', 'error', '-y', '-i', refAudioPath, '-af', fallbackFilter, ...outCodecArgs],
          conformedRefPath
        );
      }

      console.log(`📡 Staging reference audio into ComfyUI...`);
      const fileBuffer = fs.readFileSync(conformedRefPath);
      const formData = new FormData();
      formData.append('image', new Blob([fileBuffer]), path.basename(conformedRefPath));
      formData.append('overwrite', 'true');

      const uploadRes = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: formData });
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        stagedFilename = uploadData.name || path.basename(conformedRefPath);
        console.log(`✅ Staged audio in ComfyUI: "${stagedFilename}"`);
      } else {
        stagedFilename = path.basename(conformedRefPath);
      }
    }

    // =========================================================================
    // PASS 1 (Cover Mode): Run SheetSage2AudioToABC -> Promote V: Ins -> V: Vocal
    // =========================================================================
    let sheetSageIdToReplace = null;
    let promotedAbc = null;
    let cotValue = explicitCot || null;

    const sheetSageIds = isCover ? findNodeIdsByClass(baseWorkflow, 'SheetSage2AudioToABC') : [];
    const shouldRunTwoPass = Boolean(isCover && !noPromoteVocals && sheetSageIds.length > 0);

    if (shouldRunTwoPass) {
      const sheetSageId = sheetSageIds[0];
      console.log(`🔎 [Pass 1/2] Running SheetSage2AudioToABC (${sheetSageId}) to transcribe reference melody...`);
      try {
        const pass1Workflow = buildPass1SheetSageWorkflow(baseWorkflow, sheetSageId, stagedFilename);
        const pass1Res = await queueAndWaitComfy(pass1Workflow, {
          clientId: "yue2_sheetsage_pass1",
          expectAudio: false,
          timeoutMs: 180000
        });
        console.log("");

        if (pass1Res.foundScore) {
          const promo = promoteInsToVocal(pass1Res.foundScore, {
            introSystems,
            midBreak: !noMidBreak
          });
          console.log(
            `🎤 [Vocal Promotion] V: Vocal bars: ${promo.vocalBarsBefore}/${promo.totalBars} -> ${promo.vocalBarsAfter}/${promo.totalBars} ` +
            `(promoted ${promo.promotedBars} bars from V: Ins | systems=${promo.systemCount}, intro=${promo.effectiveIntro}, midBreak=${promo.midBreakOrderIdx >= 0 ? promo.midBreakOrderIdx + 1 : 'off'})`
          );

          if (promo.vocalBarsAfter > 0) {
            sheetSageIdToReplace = sheetSageId;
            promotedAbc = promo.abc;
            // Prefer mode="melody" for promoted covers so YuE2 freely orchestrates accompaniment while singing the promoted melody
            if (!cotValue) {
              cotValue = await detectPreferredCotValue('melody');
            }
          } else {
            console.warn(`⚠️ SheetSage2 returned no melodic bars; falling back to standard single-pass Cover graph.`);
          }
        } else {
          console.warn(`⚠️ Pass 1 returned no ABC transcription; falling back to standard single-pass Cover graph.`);
        }
      } catch (p1Err) {
        console.warn(`⚠️ Pass 1 SheetSage2 pre-pass failed (${p1Err.message}); falling back to standard single-pass Cover graph.`);
      } finally {
        console.log(`🧹 Unloading SheetSage2 from VRAM before Pass 2...`);
        await freeComfyMemory();
      }
    }

    // =========================================================================
    // PASS 2 (or Single-Pass Text-to-Music / Fallback): Run YuE2GenerateMusic
    // =========================================================================
    const { workflow, replacedAbcLinks } = patchWorkflow(baseWorkflow, {
      style: compositeStyle,
      lyrics: formattedLyrics,
      duration: effectiveDuration,
      seed: seed,
      stagedRefAudio: stagedFilename,
      cfgScale,
      samplerCfg,
      sheetSageIdToReplace,
      promotedAbc,
      cotValue
    });

    const modeLabel = !isCover
      ? 'Text-to-Music'
      : replacedAbcLinks > 0
      ? '2-Pass Promoted Vocal Cover'
      : (hasStanzas ? 'Cover+Kokoro' : 'Single-Pass Cover');

    console.log(`🚀 [${replacedAbcLinks > 0 ? 'Pass 2/2' : 'Single Pass'}] Queuing YuE2 [Mode: ${modeLabel} | CFG: ${cfgScale} | Max Duration: ${effectiveDuration}s]`);

    const { foundAudio, foundScore: pass2Score } = await queueAndWaitComfy(workflow, {
      clientId: "yue2_prod",
      expectAudio: true,
      timeoutMs: 600000
    });
    console.log("");

    const foundScore = promotedAbc || pass2Score || null;

    if (!foundAudio) throw new Error("Timeout: YuE2 generation produced no audio.");

    const dlRes = await fetch(`${COMFY_URL}/view?filename=${foundAudio.filename}&subfolder=${foundAudio.subfolder}&type=${foundAudio.type}`);
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const savePath = path.join(OUTPUT_DIR, foundAudio.filename);
    const buffer = await dlRes.arrayBuffer();
    fs.writeFileSync(savePath, Buffer.from(buffer));

    const actualGeneratedDuration = probeAudioDurationSec(savePath, effectiveDuration);

    let abcFilename = null;
    let midiFilename = null;
    let midiReadyAbc = null;
    let trioAbcFilename = null;
    let trioAbcScore = '';

    if (foundScore) {
      const baseSlug = foundAudio.filename.replace(/\.[^.]+$/, '');
      abcFilename = `${baseSlug}.abc`;
      midiFilename = `${baseSlug}.mid`;
      trioAbcFilename = `${baseSlug}_trio.abc`;

      const rawAbcPath = path.join(OUTPUT_DIR, abcFilename);
      const rawMidiPath = path.join(OUTPUT_DIR, midiFilename);
      const rawTrioAbcPath = path.join(OUTPUT_DIR, trioAbcFilename);

      midiReadyAbc = foundScore.replace(/%%MIDI[^\r\n]*/g, '').trim();

      const v1Lines = midiReadyAbc.split('\n').filter(l => /^[ \t]*(\[?V:\s*1\b|[^V%A-Z:][^:]*\|)/.test(l));
      let barCount = 0;
      for (const line of v1Lines) {
        const matches = line.match(/\|/g);
        if (matches) barCount += matches.length;
      }

      const meterMatch = midiReadyAbc.match(/^[ \t]*M:\s*(\d+)\/(\d+)/m);
      const beatsPerBar = meterMatch ? (parseInt(meterMatch[1], 10) * (4 / parseInt(meterMatch[2], 10))) : 4;
      const totalBeats = Math.max(16, (barCount || 32) * beatsPerBar);

      let targetBpm = Math.round((totalBeats / actualGeneratedDuration) * 60);
      if (targetBpm < 60) targetBpm = 60;
      if (targetBpm > 180) targetBpm = 180;

      const globalHeaders = `%%MIDI gchord off\nQ: 1/4=${targetBpm}`;
      const v1Block = 'V:1 name="Vocal" snm="Vocal"\n%%MIDI channel 1\n%%MIDI program 73';
      const v2Block = 'V:2 name="Inst." snm="Inst."\n%%MIDI channel 2\n%%MIDI program 71';

      if (/^[ \t]*V:\s*1\b[^\r\n]*/m.test(midiReadyAbc)) {
        midiReadyAbc = midiReadyAbc.replace(/^[ \t]*V:\s*1\b[^\r\n]*/m, v1Block);
      }
      if (/^[ \t]*V:\s*2\b[^\r\n]*/m.test(midiReadyAbc)) {
        midiReadyAbc = midiReadyAbc.replace(/^[ \t]*V:\s*2\b[^\r\n]*/m, v2Block);
      }

      if (!midiReadyAbc.includes('%%MIDI program 73')) {
        if (/^[ \t]*K:[^\r\n]*/m.test(midiReadyAbc)) {
          midiReadyAbc = midiReadyAbc.replace(/(^[ \t]*K:[^\r\n]*)/m, `$1\n${globalHeaders}\n${v1Block}\n${v2Block}`);
        } else {
          midiReadyAbc = `${globalHeaders}\n${v1Block}\n${v2Block}\n${midiReadyAbc}`;
        }
      } else {
        midiReadyAbc = midiReadyAbc.replace(/(^[ \t]*K:[^\r\n]*)/m, `$1\n${globalHeaders}`);
      }

      fs.writeFileSync(rawAbcPath, midiReadyAbc, 'utf8');

      try {
        execSync(`abc2midi "${rawAbcPath}" -o "${rawMidiPath}"`, { stdio: 'pipe' });
      } catch (_) {}

      if (fs.existsSync(rawMidiPath)) {
        console.log(`🎹 Generated Wind Duo MIDI: ${midiFilename}`);

        try {
          execSync(`midi2abc "${rawMidiPath}" -o "${rawTrioAbcPath}"`, { stdio: 'pipe' });

          if (fs.existsSync(rawTrioAbcPath)) {
            let trioContent = fs.readFileSync(rawTrioAbcPath, 'utf8');

            trioContent = trioContent
              .replace(/^T:\s*from images\/[^\r\n]*/m, 'T: Chamber Trio (Flute, Piano, Clarinet)')
              .replace(/(^[ \t]*V:\s*1\b)[^\r\n]*/m, '$1 clef=treble name="Flute (73)" snm="Fl."')
              .replace(/(^[ \t]*V:\s*2\b)[^\r\n]*/m, '$1 clef=bass name="Piano (0)" snm="Pno."')
              .replace(/(^[ \t]*V:\s*3\b)[^\r\n]*/m, '$1 clef=treble name="Clarinet (71)" snm="Cl."');

            fs.writeFileSync(rawTrioAbcPath, trioContent, 'utf8');
            trioAbcScore = trioContent;
            console.log(`🎼 Generated Full Trio ABC Score with Staff Labels: ${trioAbcFilename}`);
          }
        } catch (m2aErr) {
          console.warn(`⚠️ midi2abc decompile failed: ${m2aErr.message}`);
        }
      } else {
        console.warn(`⚠️ abc2midi failed to create MIDI file: ${midiFilename}`);
      }

      const astroPublicDir = path.join(process.cwd(), 'site/public/images');
      if (fs.existsSync(astroPublicDir)) {
        try {
          if (fs.existsSync(rawAbcPath)) {
            fs.copyFileSync(rawAbcPath, path.join(astroPublicDir, abcFilename));
          }
          if (fs.existsSync(rawMidiPath)) {
            fs.copyFileSync(rawMidiPath, path.join(astroPublicDir, midiFilename));
            console.log(`📡 Mirrored MIDI to site/public/images/${midiFilename}`);
          }
          if (fs.existsSync(rawTrioAbcPath)) {
            fs.copyFileSync(rawTrioAbcPath, path.join(astroPublicDir, trioAbcFilename));
            console.log(`📡 Mirrored Trio ABC to site/public/images/${trioAbcFilename}`);
          }
        } catch (_) {}
      }
    }

    const outputInfo = {
      savedFilePath: savePath,
      filename: foundAudio.filename,
      duration: actualGeneratedDuration,
      vocalProfile: selectedVoice.name,
      promotedVocals: replacedAbcLinks > 0,
      abcScore: midiReadyAbc || foundScore || '',
      abcFilename: abcFilename,
      midiFilename: (midiFilename && fs.existsSync(path.join(OUTPUT_DIR, midiFilename))) ? midiFilename : '',
      trioAbcFilename: (trioAbcFilename && fs.existsSync(path.join(OUTPUT_DIR, trioAbcFilename))) ? trioAbcFilename : '',
      trioAbcScore: trioAbcScore || ''
    };

    fs.writeFileSync(stateFilePath, JSON.stringify(outputInfo, null, 2));

  } catch (e) {
    console.error(`\n❌ Run Failed: ${e.message}`);
    process.exit(1);
  } finally {
    if (conformedRefPath && fs.existsSync(conformedRefPath)) {
      try { fs.unlinkSync(conformedRefPath); } catch (_) {}
    }
  }
}

main();
