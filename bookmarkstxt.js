const fs = require('fs');
const path = require('path');

// Editable constants
const RECENT_SLICE = 35;
const BOOKMARKS_PATH = path.join(
  process.env.HOME || '/home',
  '.config/google-chrome-unstable/Default/Bookmarks'   // CachyOS / standard Chrome location
);

function collect(node, list = []) {
  if (node.type === 'url' && node.url) {
    list.push({ url: node.url, date_added: BigInt(node.date_added || 0) });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, list);
  }
  return list;
}

const raw = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, 'utf8'));
const all = [];
for (const root of Object.values(raw.roots || {})) {
  collect(root, all);
}

all.sort((a, b) => (a.date_added < b.date_added ? 1 : a.date_added > b.date_added ? -1 : 0));
const recent = all.slice(0, RECENT_SLICE);

const text = recent.map(b => b.url).join('\n\n') + '\n';
fs.writeFileSync('recent_urls.txt', text);
console.log(`Wrote ${recent.length} URLs → recent_urls.txt`);