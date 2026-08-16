/**
 * Limerick Seed Generator
 * Architecture mirrors party-namer.js / stupid-idea.js
 * Draws from three lists to create a tight three-fold seed:
 *   1. Setup (first two lines potential)
 *   2. Development (next two lines potential)
 *   3. Devastating twist (final line potential)
 *
 * Usage: bun limerick-seed.js   (or node)
 * Files required: list1L.txt  list2L.txt  list3L.txt
 */

const fs = require('fs');
const path = require('path');

function loadList(filename) {
  return fs
    .readFileSync(path.join(__dirname, filename), 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const list1 = loadList('list1L.txt'); // Setup / subject
const list2 = loadList('list2L.txt'); // Development / situation
const list3 = loadList('list3L.txt'); // Twist / devastating close

console.log('=== Limerick Seed Generator (Fig & Orchard Edition) ===\n');

for (let i = 1; i <= 12; i++) {
  const seed = {
    setup: pick(list1),
    development: pick(list2),
    twist: pick(list3)
  };
  console.log(`${i.toString().padStart(2, '0')}.`);
  console.log(`   Setup:       ${seed.setup}`);
  console.log(`   Development: ${seed.development}`);
  console.log(`   Twist:       ${seed.twist}`);
  console.log('');
}

console.log('(Re-run for a fresh batch of seeds ready for LLM expansion)');