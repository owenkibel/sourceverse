javascript:(function() {
    const title = document.title;
    const url = document.URL;
    const fileName = `${title.replace(/[^a-zA-Z0-9]/g, '').substring(0, 24)}.json`;
    const obj = { name: title, url: url };
    const data = encodeURIComponent(JSON.stringify(obj));
    const downloadLink = `data:application/json;charset=utf-8,${data}`;
 // Inject a link that triggers the download
    const link = document.createElement('a');
    link.href = downloadLink;
    link.download = fileName;
    link.click();
})();