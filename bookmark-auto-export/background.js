let timer = null;

function toChromeNode(node) {
  const out = {
    id: node.id,
    name: node.title || '',
    date_added: String(node.dateAdded || 0),
    type: node.url ? 'url' : 'folder'
  };
  if (node.url) {
    out.url = node.url;
  } else {
    out.children = (node.children || []).map(toChromeNode);
  }
  return out;
}

function scheduleExport() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const tree = await chrome.bookmarks.getTree();
    const topFolders = (tree[0] && tree[0].children) || [];
    const findFolder = (idx, pattern) =>
      topFolders.find(f => pattern.test(f.title || '')) ||
      topFolders[idx] ||
      { id: String(idx + 1), title: '', children: [] };

    const payload = {
      checksum: '',
      version: 1,
      roots: {
        bookmark_bar: toChromeNode(findFolder(0, /bookmarks bar/i)),
        other: toChromeNode(findFolder(1, /other bookmarks/i)),
        synced: toChromeNode(findFolder(2, /(mobile|synced) bookmarks/i))
      }
    };

    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    await chrome.downloads.download({
      url,
      filename: 'chrome-bookmarks.json',
      conflictAction: 'overwrite',
      saveAs: false
    });
  }, 1500);
}

chrome.runtime.onInstalled.addListener(scheduleExport);
chrome.runtime.onStartup.addListener(scheduleExport);
chrome.bookmarks.onCreated.addListener(scheduleExport);
chrome.bookmarks.onRemoved.addListener(scheduleExport);
chrome.bookmarks.onChanged.addListener(scheduleExport);
chrome.bookmarks.onMoved.addListener(scheduleExport);
