const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  createProfile: (name) => ipcRenderer.invoke('create-profile', name),
  switchProfile: (id) => ipcRenderer.invoke('switch-profile', id),
  removeProfile: (id) => ipcRenderer.invoke('remove-profile', id),
  stopProfile: (id) => ipcRenderer.invoke('stop-profile', id),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),

  newTab: (profileId, url) => ipcRenderer.invoke('new-tab', { profileId, url }),
  switchTab: (profileId, tabId) => ipcRenderer.invoke('switch-tab', { profileId, tabId }),
  closeTab: (profileId, tabId) => ipcRenderer.invoke('close-tab', { profileId, tabId }),
  reorderTabs: (profileId, fromIdx, toIdx) => ipcRenderer.invoke('reorder-tabs', { profileId, fromIdx, toIdx }),

  navigate: (profileId, tabId, url) => ipcRenderer.invoke('navigate', { profileId, tabId, url }),
  navBack: (profileId, tabId) => ipcRenderer.invoke('nav-back', { profileId, tabId }),
  navForward: (profileId, tabId) => ipcRenderer.invoke('nav-forward', { profileId, tabId }),
  navRefresh: (profileId, tabId) => ipcRenderer.invoke('nav-refresh', { profileId, tabId }),

  overlayVisible: (visible) => ipcRenderer.invoke('overlay-visible', visible),

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
  pastePlainText: (text) => ipcRenderer.invoke('paste-plain-text', text),
  pasteAtCoords: (text, x, y) => ipcRenderer.invoke('paste-at-coords', { text, x, y }),
  onShortcutCloseTab: (cb) => {
    const l = () => cb(); ipcRenderer.on('shortcut-close-tab', l)
    return () => ipcRenderer.removeListener('shortcut-close-tab', l)
  },
  onShortcutNextTab: (cb) => {
    const l = () => cb(); ipcRenderer.on('shortcut-next-tab', l)
    return () => ipcRenderer.removeListener('shortcut-next-tab', l)
  },
  onShortcutPrevTab: (cb) => {
    const l = () => cb(); ipcRenderer.on('shortcut-prev-tab', l)
    return () => ipcRenderer.removeListener('shortcut-prev-tab', l)
  },
  onShortcutFocusAddress: (cb) => {
    const l = () => cb(); ipcRenderer.on('shortcut-focus-address', l)
    return () => ipcRenderer.removeListener('shortcut-focus-address', l)
  },
  onShortcutNewTab: (cb) => {
    const l = () => cb(); ipcRenderer.on('shortcut-new-tab', l)
    return () => ipcRenderer.removeListener('shortcut-new-tab', l)
  },

  // VS Code panel
  vscodeSetPanelState: (visible, width) => ipcRenderer.invoke('vscode:set-panel-state', { visible, width }),
  vscodeGetPanelState: () => ipcRenderer.invoke('vscode:get-panel-state'),
  vscodeLoadUrl: (url) => ipcRenderer.invoke('vscode:load-url', url),
  vscodeGetUrl: () => ipcRenderer.invoke('vscode:get-url'),
  vscodeSetZoom: (factor) => ipcRenderer.invoke('vscode:set-zoom', factor),
  vscodeGetZoom: () => ipcRenderer.invoke('vscode:get-zoom'),

  zoomIn: () => ipcRenderer.invoke('browser:zoom-in'),
  zoomOut: () => ipcRenderer.invoke('browser:zoom-out'),
  zoomReset: () => ipcRenderer.invoke('browser:zoom-reset')
})

contextBridge.exposeInMainWorld(
  'diagnostics',
  {
    ping: () => 'pong'
  }
)