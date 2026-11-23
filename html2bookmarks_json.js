// html2bookmarks_json.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const inputHtml = process.argv[2] || path.join(process.env.HOME, 'bookmarks.html');
const outputJson = process.argv[3] || path.join(process.env.HOME, 'bookmarks.json');

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function toWebkitTimestamp(unixSecStr) {
  const sec = BigInt(parseInt(unixSecStr || '0', 10) || Math.floor(Date.now() / 1000));
  return ((sec + 11644473600n) * 1000000n).toString();
}

function getAttr(attrStr, name) {
  const m = attrStr.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

const html = fs.readFileSync(inputHtml, 'utf8');
let nextId = 4;
let urlCount = 0;

const rootItems = [];
const stack = [{ children: rootItems }];
let pendingFolder = null;

// Tokenize Netscape bookmark tags in document order
const tokenRegex = /<(H3|A)\b([^>]*)>([\s\S]*?)<\/\1>|<(DL)\b[^>]*>|<\/(DL)>/gi;
let match;

while ((match = tokenRegex.exec(html)) !== null) {
  const tag = (match[1] || match[4] || (match[5] ? '/DL' : '')).toUpperCase();

  if (tag === 'H3') {
    const attrs = match[2] || '';
    const folder = {
      children: [],
      date_added: toWebkitTimestamp(getAttr(attrs, 'ADD_DATE')),
      date_last_used: '0',
      date_modified: toWebkitTimestamp(getAttr(attrs, 'LAST_MODIFIED')),
      guid: crypto.randomUUID(),
      id: String(nextId++),
      name: decodeHtml((match[3] || '').trim()),
      type: 'folder',
      _isToolbar: /PERSONAL_TOOLBAR_FOLDER="true"/i.test(attrs)
    };
    stack[stack.length - 1].children.push(folder);
    pendingFolder = folder;
  } else if (tag === 'A') {
    const attrs = match[2] || '';
    stack[stack.length - 1].children.push({
      date_added: toWebkitTimestamp(getAttr(attrs, 'ADD_DATE')),
      date_last_used: '0',
      guid: crypto.randomUUID(),
      id: String(nextId++),
      name: decodeHtml((match[3] || '').trim()),
      type: 'url',
      url: decodeHtml(getAttr(attrs, 'HREF'))
    });
    urlCount++;
  } else if (tag === 'DL') {
    if (pendingFolder) {
      stack.push(pendingFolder);
      pendingFolder = null;
    }
  } else if (tag === '/DL') {
    if (stack.length > 1) stack.pop();
  }
}

const nowWebkit = toWebkitTimestamp();
const bookmarkBarChildren = [];
const otherChildren = [];
const syncedChildren = [];

for (const item of rootItems) {
  const isToolbar = item._isToolbar || /^bookmarks bar$/i.test(item.name);
  delete item._isToolbar;

  if (item.type === 'folder' && isToolbar) {
    bookmarkBarChildren.push(...item.children);
  } else if (item.type === 'folder' && /^other bookmarks$/i.test(item.name)) {
    otherChildren.push(...item.children);
  } else if (item.type === 'folder' && /^(mobile|synced) bookmarks$/i.test(item.name)) {
    syncedChildren.push(...item.children);
  } else {
    otherChildren.push(item);
  }
}

const chromeBookmarksJson = {
  checksum: '',
  roots: {
    bookmark_bar: {
      children: bookmarkBarChildren,
      date_added: nowWebkit,
      date_last_used: '0',
      date_modified: nowWebkit,
      guid: crypto.randomUUID(),
      id: '1',
      name: 'Bookmarks bar',
      type: 'folder'
    },
    other: {
      children: otherChildren,
      date_added: nowWebkit,
      date_last_used: '0',
      date_modified: '0',
      guid: crypto.randomUUID(),
      id: '2',
      name: 'Other bookmarks',
      type: 'folder'
    },
    synced: {
      children: syncedChildren,
      date_added: nowWebkit,
      date_last_used: '0',
      date_modified: '0',
      guid: crypto.randomUUID(),
      id: '3',
      name: 'Mobile bookmarks',
      type: 'folder'
    }
  },
  version: 1
};

fs.writeFileSync(outputJson, JSON.stringify(chromeBookmarksJson, null, 2), 'utf8');
console.log(`✅ Converted ${urlCount} bookmarks from ${inputHtml} -> ${outputJson}`);