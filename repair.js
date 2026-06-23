const fs = require('fs');
const { execSync } = require('child_process');

try {
  // get head
  const original = execSync('git show HEAD:main.js').toString('utf8');
  
  // prepare replacement logic
  const startDragMultiIdx = original.indexOf("ipcMain.on('fs:start-drag-multiple'");
  if (startDragMultiIdx === -1) throw new Error('Not found');
  
  const startDragMultiEndIdx = original.indexOf('})', startDragMultiIdx) + 3;
  
  const replacement = `ipcMain.on('fs:start-drag-multiple', (e, { filePaths }) => {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return
  const resolvedPaths = filePaths.filter((p) => typeof p === 'string' && fs.existsSync(p)).map((p) => path.resolve(p))
  if (resolvedPaths.length === 0) return
  try {
    e.sender.startDrag({
      file: resolvedPaths[0],
      files: resolvedPaths,
      icon: getDragIcon()
    })
  } catch (err) {
    if (settings.debugLogs) console.error('startDrag multi error:', err.message)
  }
})
`;

  const newContent = original.substring(0, startDragMultiIdx) + replacement + original.substring(startDragMultiEndIdx);
  
  fs.writeFileSync('main.js', newContent, 'utf8');
  console.log('Successfully patched main.js based on git HEAD');
} catch (e) {
  console.error(e);
}
