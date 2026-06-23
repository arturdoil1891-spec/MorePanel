const { contextBridge, ipcRenderer } = require('electron')

console.log('[Preload] Loaded');

contextBridge.exposeInMainWorld('api', {
  createProfile: (name) => ipcRenderer.invoke('create-profile', name),
  switchProfile: (id) => ipcRenderer.invoke('switch-profile', id),
  removeProfile: (id) => ipcRenderer.invoke('remove-profile', id),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),

  newTab: (profileId, url) => ipcRenderer.invoke('new-tab', { profileId, url }),
  switchTab: (profileId, tabId) => ipcRenderer.invoke('switch-tab', { profileId, tabId }),
  closeTab: (profileId, tabId) => ipcRenderer.invoke('close-tab', { profileId, tabId }),
  reorderTabs: (profileId, fromIdx, toIdx) => ipcRenderer.invoke('reorder-tabs', { profileId, fromIdx, toIdx }),

  navigate: (profileId, tabId, url) => ipcRenderer.invoke('navigate', { profileId, tabId, url }),
  navBack: (profileId, tabId) => ipcRenderer.invoke('nav-back', { profileId, tabId }),
  navForward: (profileId, tabId) => ipcRenderer.invoke('nav-forward', { profileId, tabId }),
  navRefresh: (profileId, tabId) => ipcRenderer.invoke('nav-refresh', { profileId, tabId }),

  setFilesPanelState: (visible, width) => ipcRenderer.invoke('set-files-panel-state', { visible, width }),
  getFilesPanelState: () => ipcRenderer.invoke('get-files-panel-state'),
  overlayVisible: (visible) => ipcRenderer.invoke('overlay-visible', visible),

  fsListFolder: (folderPath) => ipcRenderer.invoke('fs:list-folder', folderPath),
  fsPickDirectory: () => ipcRenderer.invoke('fs:pick-directory'),
  fsSetRoot: (folderPath) => ipcRenderer.invoke('fs:set-root', folderPath),
  fsGetRoot: () => ipcRenderer.invoke('fs:get-root'),
  fsArchiveFolder: (folderPath, destPath) => ipcRenderer.invoke('fs:archive-folder', { folderPath, destPath }),
  fsRevealInFolder: (filePath) => ipcRenderer.invoke('fs:reveal-in-folder', filePath),
  fsOpenPath: (filePath) => ipcRenderer.invoke('fs:open-path', filePath),
  fsCopyPath: (filePath) => ipcRenderer.invoke('fs:copy-path', filePath),
  fsStartDrag: (filePath, isFolder) => ipcRenderer.send('fs:start-drag', { filePath, isFolder }),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('save-settings', payload),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  testMLConnection: () => ipcRenderer.invoke('ml:test-connection'),

  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),
  toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  exitFullScreen: () => ipcRenderer.invoke('exit-fullscreen'),
  getDevToolsState: () => ipcRenderer.invoke('get-devtools-state'),
  getFullScreenState: () => ipcRenderer.invoke('get-fullscreen-state'),

  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),

  mlList: () => ipcRenderer.invoke('ml:list'),
  mlImport: (envId) => ipcRenderer.invoke('ml:import', envId),
  mlSyncCookies: (profileId) => ipcRenderer.invoke('ml:sync-cookies', profileId),
  mlClose: (profileId) => ipcRenderer.invoke('ml:close', profileId),
  mlRelaunch: (profileId) => ipcRenderer.invoke('ml:relaunch', profileId),

  onTabUpdated: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('tab-updated', listener)
    return () => ipcRenderer.removeListener('tab-updated', listener)
  },
  onTabOpened: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('tab-opened', listener)
    return () => ipcRenderer.removeListener('tab-opened', listener)
  },
  onProfileUpdated: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('profile-updated', listener)
    return () => ipcRenderer.removeListener('profile-updated', listener)
  },
  onProfileLaunched: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('profile-launched', listener)
    return () => ipcRenderer.removeListener('profile-launched', listener)
  },
  onCookiesSynced: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ml-cookies-synced', listener)
    return () => ipcRenderer.removeListener('ml-cookies-synced', listener)
  },
  onMLListUpdated: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('ml-list-updated', listener)
    return () => ipcRenderer.removeListener('ml-list-updated', listener)
  },
  diagnostics: () => ipcRenderer.invoke('run-diagnostics'),
  pastePlainText: (text) => ipcRenderer.invoke('paste-plain-text', text)
})

contextBridge.exposeInMainWorld(
  'diagnostics',
  {
    ping: () => 'pong'
  }
)