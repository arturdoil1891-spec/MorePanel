const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf-8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');

if (scriptStart !== -1 && scriptEnd !== -1) {
    fs.writeFileSync('renderer.js', html.substring(scriptStart + 8, scriptEnd));
    fs.writeFileSync('index.html', html.substring(0, scriptStart) + '<script src="renderer.js"></script>' + html.substring(scriptEnd + 9));
    console.log('Done');
} else {
    console.log('Not found');
}
