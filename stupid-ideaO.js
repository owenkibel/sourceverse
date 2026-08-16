/**
 * Carville-style Random Stupid Idea Generator
 * Inspired by James Carville’s 8 Aug 2026 observation
 * that certain factions appear to be consulting an
 * “AI random stupid idea generator.”
 *
 * Usage: node stupid-idea.js   (or bun stupid-idea.js)
 * Requires: ideas1.txt  ideas2.txt  ideas3.txt
 */

const fs = require('fs');
const path = require('path');

function loadList(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const list1 = loadList('idea1O.txt'); // subjects / targets
const list2 = loadList('idea2O.txt'); // verbs / actions
const list3 = loadList('idea3O.txt'); // justifications / outcomes

console.log('=== Carville Random Stupid Idea Generator ===\n');

for (let i = 1; i <= 10; i++) {
  const idea = `We should ${pick(list2)} ${pick(list1)} because ${pick(list3)}.`;
  console.log(`${i.toString().padStart(2, '0')}. ${idea}`);
}

console.log('\n(Re-run for a fresh batch of ideas no human would invent unaided)');