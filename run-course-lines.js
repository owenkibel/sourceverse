#!/usr/bin/env bun
/**
 * run-course-lines.js
 *
 * Run a training text file line by line (blank lines and # comments skipped).
 * Pauses between commands so the xAI API can recover.
 *
 *   bun run-course-lines.js --file=devine-both.txt
 *   bun run-course-lines.js --file=devine-both.txt --pause=12
 *   bun run-course-lines.js --file=devine-both.txt --pause=12 --from=3
 */

import fs from 'fs';
import { spawn } from 'child_process';

const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith('--file='))?.slice(7);
const pauseSec = Math.max(0, parseInt(args.find((a) => a.startsWith('--pause='))?.slice(8) || '12', 10) || 12);
const fromN = Math.max(1, parseInt(args.find((a) => a.startsWith('--from='))?.slice(7) || '1', 10) || 1);
const stopOnError = !args.includes('--keep-going');

if (!fileArg) {
  console.error('Required: --file=devine-both.txt');
  process.exit(1);
}

const raw = fs.readFileSync(fileArg, 'utf8');
const lines = raw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

if (!lines.length) {
  console.error(`No commands in ${fileArg}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runLine(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${cmd}`));
    });
  });
}

console.log(`📋 ${fileArg} · ${lines.length} commands · pause ${pauseSec}s · start at ${fromN}`);

for (let i = fromN - 1; i < lines.length; i++) {
  const cmd = lines[i];
  console.log(`\n—— ${i + 1}/${lines.length} ——`);
  console.log(cmd);
  try {
    await runLine(cmd);
  } catch (err) {
    console.error(`🚫 ${err.message}`);
    if (stopOnError) {
      console.error(`Resume with: bun run-course-lines.js --file=${fileArg} --pause=${pauseSec} --from=${i + 1}`);
      process.exit(1);
    }
  }
  if (i < lines.length - 1 && pauseSec > 0) {
    console.log(`⏳ pause ${pauseSec}s`);
    await sleep(pauseSec * 1000);
  }
}

console.log(`\n✅ finished ${fileArg}`);
