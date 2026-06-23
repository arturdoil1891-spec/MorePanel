const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const WebSocket = require('ws')
const archiver = require('archiver')
require('dotenv').config()

const ProfileService = require('./src/services/profileService.js')

app.disableHardwareAcceleration()

const TITLEBAR_HEIGHT = 36
const TOOLBAR_HEIGHT = 44
const TABBAR_HEIGHT = 36
const CHROME_HEIGHT = TITLEBAR_HEIGHT + TOOLBAR_HEIGHT + TABBAR_HEIGHT
const FILES_PANEL_DEFAULT_WIDTH = 260
const FILES_PANEL_MIN_WIDTH = 180
const FILES_PANEL_MAX_WIDTH = 480
const SUSPEND_TIMEOUT = 2 * 60 * 1000
const ARCHIVE_LEVEL = 9
const DEFAULT_EXCLUSIONS = [
  'node_modules', '.git', '.DS_Store', '$RECYCLE.BIN', 'System Volume Information',
  '.cache', 'dist', 'build', 'target', '.next', '.nuxt', '.parcel-cache',
  '.turbo', '.vercel', '.idea', '.vscode', '__pycache__', 'Thumbs.db'
]

let cdpIdCounter = 0

let mainWindow = null
let activeView = null
let activeProfileId = null
let filesPanelVisible = false
let filesPanelWidth = FILES_PANEL_DEFAULT_WIDTH
let filesPanelRoot = null
let overlayVisible = false
let devtoolsOpen = false
let isFullscreen = false

const profiles = new Map()
const tabsByProfile = new Map()
const addedViews = new WeakSet()
const suspendTimers = new Map()
let saveStateTimer = null

const DRAG_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAS0lEQVR4nGNgGAWjYBSMghENGP///8/AwMDw//8fBgYGBob/X0DGgQGGgYHhPxMDAwMDzP8wY0D6gRmD0T+YAUUa0GkAVhgAALDpQHzLcr3pAAAAAElFTkSuQmCC'
let dragIcon = null
function getDragIcon() {
  if (!dragIcon) {
    try { dragIcon = nativeImage.createFromDataURL(DRAG_ICON_DATA_URL) } catch (e) { dragIcon = nativeImage.createEmpty() }
  }
  return dragIcon
}

const settings = {
  mlHost: process.env.MORELOGIN_LOCAL_HOST || '127.0.0.1',
  mlPort: parseInt(process.env.MORELOGIN_LOCAL_PORT || '40000', 10),
  pageSize: parseInt(process.env.MORELOGIN_PAGE_SIZE || '50', 10),
  autoLoad: (process.env.MORELOGIN_AUTO_LOAD || 'true') !== 'false',
  headlessStart: (process.env.MORELOGIN_HEADLESS_START || 'true') !== 'false',
  debugLogs: (process.env.MORELOGIN_DEBUG || 'false') === 'true',
  archiveExclusions: DEFAULT_EXCLUSIONS.slice(),
  apiMode: process.env.API_MODE || 'auto',
  apiId: process.env.MORELOGIN_API_ID || '',
  apiKey: process.env.MORELOGIN_API_KEY || ''
}

const profileService = new ProfileService(settings)

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function getStateFilePath() {
  try { return path.join(app.getPath('userData'), 'app-state.json') }
  catch (e) { return null }
}

function saveAppStateNow() {
  const file = getStateFilePath()
  if (!file) return
  try {
    const data = {
      activeProfileId,
      profiles: Array.from(profiles.values()).map((p) => ({
        id: p.id,
        name: p.name,
        envId: p.envId,
        activeTabId: p.activeTabId,
        tabs: (tabsByProfile.get(p.id) || []).map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title
        }))
      }))
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (e) {
    if (settings.debugLogs) console.error('save state:', e.message)
  }
}

function scheduleAppStateSave() {
  if (saveStateTimer) clearTimeout(saveStateTimer)
  saveStateTimer = setTimeout(() => { saveStateTimer = null; saveAppStateNow() }, 400)
}

function getSettingsFilePath() {
  try { return path.join(app.getPath('userData'), 'app-settings.json') }
  catch (e) { return null }
}

function loadSettings() {
  const file = getSettingsFilePath()
  if (!file || !fs.existsSync(file)) return
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (typeof data.mlHost === 'string') settings.mlHost = data.mlHost
    if (typeof data.mlPort === 'number' && data.mlPort > 0) settings.mlPort = data.mlPort
    if (typeof data.pageSize === 'number' && data.pageSize > 0) settings.pageSize = data.pageSize
    if (typeof data.autoLoad === 'boolean') settings.autoLoad = data.autoLoad
    if (typeof data.headlessStart === 'boolean') settings.headlessStart = data.headlessStart
    if (typeof data.debugLogs === 'boolean') settings.debugLogs = data.debugLogs
    if (Array.isArray(data.archiveExclusions)) settings.archiveExclusions = data.archiveExclusions.filter((x) => typeof x === 'string')
    if (typeof data.apiMode === 'string') settings.apiMode = data.apiMode
    if (typeof data.apiId === 'string') settings.apiId = data.apiId
    if (typeof data.apiKey === 'string') settings.apiKey = data.apiKey
    if (typeof data.lastFolder === 'string' && fs.existsSync(data.lastFolder)) filesPanelRoot = data.lastFolder
    profileService.updateSettings(settings)
  } catch (e) {
    if (settings.debugLogs) console.error('load settings:', e.message)
  }
}

function saveSettings() {
  const file = getSettingsFilePath()
  if (!file) return
  try { fs.writeFileSync(file, JSON.stringify(settings, null, 2)) }
  catch (e) { if (settings.debugLogs) console.error('save settings:', e.message) }
}

function isExcludedName(name) {
  if (!name) return false
  return settings.archiveExclusions.includes(name)
}

function safeStat(p) {
  try { return fs.statSync(p) } catch (e) { return null }
}

function listFolder(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath) throw new Error('Invalid path')
  const resolved = path.resolve(folderPath)
  const stat = safeStat(resolved)
  if (!stat || !stat.isDirectory()) throw new Error('Path is not a directory')
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const folders = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue
    if (isExcludedName(entry.name)) continue
    const full = path.join(resolved, entry.name)
    if (entry.isDirectory()) {
      let hasChildren = false
      try {
        const sub = fs.readdirSync(full)
        hasChildren = sub.some((n) => !isExcludedName(n) && !n.startsWith('.'))
      } catch (e) { }
      folders.push({ name: entry.name, path: full, hasChildren })
    } else if (entry.isFile()) {
      try {
        const s = fs.statSync(full)
        files.push({ name: entry.name, path: full, size: s.size })
      } catch (e) { }
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { path: resolved, folders, files }
}

function archiveFolderTo(srcDir, destZip) {
  return new Promise((resolve, reject) => {
    const stat = safeStat(srcDir)
    if (!stat || !stat.isDirectory()) return reject(new Error('Source is not a directory'))
    const out = fs.createWriteStream(destZip)
    const archive = archiver('zip', { zlib: { level: ARCHIVE_LEVEL } })
    let settled = false
    out.on('close', () => { if (!settled) { settled = true; resolve({ path: destZip, bytes: archive.pointer() }) } })
    out.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
    archive.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
    archive.on('warning', (e) => { if (settings.debugLogs) console.error('archive warning:', e.message) })
    archive.pipe(out)
    archive.directory(srcDir, false, (entry) => {
      const name = entry.name || ''
      const parts = name.split('/').filter(Boolean)
      if (parts.some(isExcludedName)) return false
      return entry
    })
    archive.finalize().catch((e) => { if (!settled) { settled = true; reject(e) } })
  })
}

function loadAppState() {
  const file = getStateFilePath()
  if (!file || !fs.existsSync(file)) return
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const data = JSON.parse(raw)
    for (const p of (data.profiles || [])) {
      if (!p.id) continue
      const profile = {
        id: p.id,
        name: p.name || 'Профиль',
        envId: p.envId || null,
        debugPort: null,
        activeTabId: p.activeTabId || null,
        suspended: true,
        launching: false,
        mlError: null,
        createdAt: Date.now()
      }
      profiles.set(p.id, profile)
      const tabs = (p.tabs || []).filter((t) => t && t.id).map((t) => ({
        id: t.id,
        url: t.url || 'about:blank',
        title: t.title || '',
        view: null
      }))
      tabsByProfile.set(p.id, tabs)
    }
    if (data.activeProfileId && profiles.has(data.activeProfileId)) {
      activeProfileId = data.activeProfileId
    } else if (!activeProfileId && profiles.size > 0) {
      activeProfileId = profiles.keys().next().value
    }
  } catch (e) {
    if (settings.debugLogs) console.error('load state:', e.message)
  }
}

function getContentBounds() {
  if (!mainWindow) return { x: 0, y: 0, width: 1, height: 1 }
  const [w, h] = mainWindow.getContentSize()
  const left = filesPanelVisible ? filesPanelWidth : 0
  return {
    x: left,
    y: CHROME_HEIGHT,
    width: Math.max(w - left, 100),
    height: Math.max(h - CHROME_HEIGHT, 100)
  }
}

function updateActiveViewBounds() {
  if (!activeView || activeView.webContents.isDestroyed()) return
  if (overlayVisible) {
    activeView.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    return
  }
  activeView.setBounds(getContentBounds())
}

function showView(view) {
  if (!view || !mainWindow || view.webContents.isDestroyed()) return
  if (activeView && activeView !== view && !activeView.webContents.isDestroyed()) {
    activeView.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  }
  if (!addedViews.has(view)) {
    try { mainWindow.contentView.addChildView(view) } catch { }
    addedViews.add(view)
  }
  activeView = view
  updateActiveViewBounds()
  if (!view.webContents.isDestroyed()) view.webContents.focus()
}

function createView(partition) {
  const sess = session.fromPartition(partition)
  const view = new WebContentsView({
    webPreferences: {
      session: sess,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  attachDevToolsListeners(view)
  return view
}

function serializeTab(tab) {
  return { id: tab.id, url: tab.url, title: tab.title }
}

function serializeProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    envId: profile.envId,
    debugPort: profile.debugPort,
    tabs: (tabsByProfile.get(profile.id) || []).map(serializeTab),
    activeTabId: profile.activeTabId,
    suspended: profile.suspended,
    launching: !!profile.launching,
    mlError: profile.mlError || null
  }
}

function attachTabHandlers(profileId, tab) {
  const view = tab.view
  view.webContents.on('page-title-updated', (_e, title) => {
    tab.title = title
    scheduleAppStateSave()
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('tab-updated', { profileId, tab: serializeTab(tab) })
    }
  })
  view.webContents.on('did-navigate', (_e, url) => {
    tab.url = url
    scheduleAppStateSave()
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('tab-updated', { profileId, tab: serializeTab(tab) })
    }
    // Синхронизируем URL с MoreLogin Chrome для корректного автозаполнения паролей
    const profile = profiles.get(profileId)
    if (profile && profile.debugPort) {
      navigateMLChrome(profile.debugPort, url).catch(() => { })
    }
  })
  view.webContents.on('did-finish-load', () => {
    updateActiveViewBounds()
    trySyncMLStorage(profileId, view).catch(() => { })
  })
  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    const u = openUrl || 'about:blank'
    const tabs = tabsByProfile.get(profileId) || []
    const profile = profiles.get(profileId)
    const partition = profile && profile.envId ? `persist:ml-${profile.envId}` : `persist:${profileId}`
    const newTab = {
      id: uid(),
      url: u,
      title: 'Новая вкладка',
      view: createView(partition)
    }
    newTab.view.webContents.loadURL(u)
    tabs.push(newTab)
    if (profile) profile.activeTabId = newTab.id
    attachTabHandlers(profileId, newTab)
    if (profileId === activeProfileId) showView(newTab.view)
    scheduleAppStateSave()
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('tab-opened', { profileId, tab: serializeTab(newTab) })
    }
    return { action: 'deny' }
  })
}

function moreloginRequest(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null
    const req = http.request({
      hostname: settings.mlHost,
      port: settings.mlPort,
      path: reqPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0
      },
      timeout: 15000
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        let json = null
        try { json = text ? JSON.parse(text) : {} } catch (e) {
          return reject(new Error(`MoreLogin invalid JSON (${res.statusCode}): ${text.slice(0, 200)}`))
        }
        if (json && (json.code === 0 || json.code === 200 || json.code === '0' || json.code === '200')) {
          resolve(json.data !== undefined ? json.data : json)
        } else {
          reject(new Error((json && (json.msg || json.message)) || `MoreLogin error ${res.statusCode}`))
        }
      })
    })
    req.on('error', (e) => reject(new Error(`MoreLogin connection failed: ${e.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('MoreLogin timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

function cdpHttpGetJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP http timeout')) })
  })
}

function cdpWs(wsUrl, method, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const id = ++cdpIdCounter
    const timer = setTimeout(() => {
      try { ws.close() } catch { }
      reject(new Error(`CDP timeout: ${method}`))
    }, timeout)
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) {
          clearTimeout(timer)
          ws.close()
          if (msg.error) reject(new Error(msg.error.message || 'CDP error'))
          else resolve(msg.result || {})
        }
      } catch (e) { }
    })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function getCdpTabs(debugPort) {
  return cdpHttpGetJson(debugPort, '/json')
}

async function waitForCdp(debugPort, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tabs = await getCdpTabs(debugPort)
      const target = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('chrome-error://'))
      if (target) return target
    } catch (e) { }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`CDP not ready on port ${debugPort}`)
}

async function syncCookies(debugPort, electronSession) {
  const target = await waitForCdp(debugPort)
  await cdpWs(target.webSocketDebuggerUrl, 'Network.enable')
  const { cookies } = await cdpWs(target.webSocketDebuggerUrl, 'Network.getAllCookies', {}, 15000)
  let count = 0
  for (const c of cookies || []) {
    try {
      const domain = (c.domain || '').replace(/^\./, '')
      if (!domain) continue
      const url = `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`
      const opts = {
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite === 'None' ? 'no_restriction' : (c.sameSite === 'Lax' || c.sameSite === 'Strict') ? c.sameSite.toLowerCase() : 'unspecified'
      }
      if (c.expires && c.expires > 0 && c.expires < 1e12) opts.expirationDate = c.expires
      await electronSession.cookies.set(opts)
      count++
    } catch (e) {
      if (settings.debugLogs) console.error('cookie sync error:', e.message)
    }
  }
  return count
}

async function syncStorageForOrigin(debugPort) {
  const target = await waitForCdp(debugPort)
  await cdpWs(target.webSocketDebuggerUrl, 'Runtime.enable')
  const { result } = await cdpWs(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: `(() => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        try { ls[k] = localStorage.getItem(k); } catch(e) {}
      }
      const ss = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        try { ss[k] = sessionStorage.getItem(k); } catch(e) {}
      }
      return JSON.stringify({ localStorage: ls, sessionStorage: ss, origin: location.origin });
    })()`,
    returnByValue: true
  })
  try { return JSON.parse(result.value || '{}') }
  catch (e) { return { localStorage: {}, sessionStorage: {} } }
}

async function injectStorage(view, storage) {
  if (!view || view.webContents.isDestroyed()) return false
  const ls = storage.localStorage || {}
  const ss = storage.sessionStorage || {}
  if (Object.keys(ls).length === 0 && Object.keys(ss).length === 0) return false
  const expr = `(() => {
    try {
${Object.entries(ls).map(([k, v]) => `      localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')}
${Object.entries(ss).map(([k, v]) => `      sessionStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')}
      return 'ok';
    } catch (e) { return 'err:' + e.message; }
  })()`
  const res = await view.webContents.executeJavaScript(expr)
  return res === 'ok'
}

async function trySyncMLStorage(profileId, view) {
  const profile = profiles.get(profileId)
  if (!profile || !profile.envId || !profile.debugPort) return
  if (!view || view.webContents.isDestroyed()) return
  try {
    const url = view.webContents.getURL()
    if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return
    const tabs = await getCdpTabs(profile.debugPort).catch(() => [])
    const mlTarget = (tabs || []).find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'))
    const mlUrl = mlTarget ? mlTarget.url : ''
    if (!mlUrl || mlUrl.startsWith('about:')) return
    let mlOrigin, viewOrigin
    try { mlOrigin = new URL(mlUrl).origin } catch (e) { return }
    try { viewOrigin = new URL(url).origin } catch (e) { return }
    if (mlOrigin !== viewOrigin) return
    const storage = await syncStorageForOrigin(profile.debugPort)
    await injectStorage(view, storage)
  } catch (e) {
    if (settings.debugLogs) console.error('ML storage sync error:', e.message)
  }
}

// Синхронизируем навигацию: при переходе в Electron — открываем тот же URL в MoreLogin Chrome
// чтобы работало автозаполнение паролей из его профиля
async function navigateMLChrome(debugPort, url) {
  if (!debugPort || !url || url.startsWith('about:')) return
  try {
    const tabs = await getCdpTabs(debugPort).catch(() => [])
    const target = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl &&
      !t.url.startsWith('chrome-extension://'))
    if (!target) return
    await cdpWs(target.webSocketDebuggerUrl, 'Page.navigate', { url }, 8000)
  } catch (e) {
    if (settings.debugLogs) console.error('navigateMLChrome error:', e.message)
  }
}

async function loadMoreLoginProfiles() {
  return profileService.getProfiles()
}

async function launchMLProfile(envId) {
  const data = await moreloginRequest('POST', '/api/env/start', { envId, isHeadless: settings.headlessStart })
  const debugPort = data && (data.debugPort || data.port || data.debug_port)
  if (!debugPort) throw new Error('MoreLogin не вернул debugPort')
  return Number(debugPort)
}

async function closeMLProfile(envId) {
  try { await moreloginRequest('POST', '/api/env/close', { envId }) }
  catch (e) { if (settings.debugLogs) console.error('ML close error:', e.message) }
}

async function launchMLProfileFull(profileId, envId, mlName) {
  const profile = profiles.get(profileId)
  if (!profile) throw new Error('Profile not found')
  profile.launching = true
  profile.mlError = null
  notifyProfileChange(profileId)

  try {
    const debugPort = await launchMLProfile(envId)
    profile.debugPort = debugPort

    await waitForCdp(debugPort)
    const tabs = await getCdpTabs(debugPort)
    // Фильтруем extension-страницу MoreLogin и служебные страницы
    const isUsablePage = (t) =>
      t.type === 'page' &&
      t.url &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('chrome-error://') &&
      !t.url.startsWith('about:')
    const pageTab = tabs.find(isUsablePage) || tabs.find((t) => t.type === 'page')
    const initialUrl = (pageTab && pageTab.url && isUsablePage(pageTab)) ? pageTab.url : 'about:blank'

    const partition = `persist:ml-${envId}`
    const electronSession = session.fromPartition(partition)
    const cookieCount = await syncCookies(debugPort, electronSession)

    const tab = {
      id: uid(),
      url: initialUrl,
      title: pageTab ? (pageTab.title || mlName || 'MoreLogin') : (mlName || 'MoreLogin'),
      view: createView(partition)
    }
    const tabsArr = tabsByProfile.get(profileId) || []
    tabsArr.push(tab)
    tabsByProfile.set(profileId, tabsArr)
    profile.activeTabId = tab.id
    profile.suspended = false
    profile.launching = false
    attachTabHandlers(profileId, tab)
    tab.view.webContents.loadURL(tab.url)

    if (profileId === activeProfileId) showView(tab.view)

    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('ml-cookies-synced', { profileId, count: cookieCount })
      mainWindow.webContents.send('profile-launched', { profileId, profile: serializeProfile(profile) })
    }
    scheduleAppStateSave()
    return { cookieCount }
  } catch (e) {
    profile.launching = false
    profile.mlError = e.message
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('profile-launched', { profileId, profile: serializeProfile(profile) })
    }
    throw e
  }
}

function notifyProfileChange(profileId) {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return
  const profile = profiles.get(profileId)
  if (profile) mainWindow.webContents.send('profile-updated', { profileId, profile: serializeProfile(profile) })
}

function clearSuspendCountdown(profileId) {
  if (suspendTimers.has(profileId)) {
    clearTimeout(suspendTimers.get(profileId))
    suspendTimers.delete(profileId)
  }
}

function startSuspendCountdown(profileId) {
  clearSuspendCountdown(profileId)
  if (profileId === activeProfileId) return
  const profile = profiles.get(profileId)
  if (!profile || profile.suspended) return
  const timer = setTimeout(() => {
    suspendTimers.delete(profileId)
    suspendProfile(profileId).catch((e) => { if (settings.debugLogs) console.error('suspend error:', e.message) })
  }, SUSPEND_TIMEOUT)
  suspendTimers.set(profileId, timer)
}

async function suspendProfile(profileId) {
  const profile = profiles.get(profileId)
  if (!profile) return
  if (profileId === activeProfileId) return
  if (profile.suspended) return

  const tabs = tabsByProfile.get(profileId) || []
  for (const t of tabs) {
    if (t.view && !t.view.webContents.isDestroyed()) {
      try { t.url = t.view.webContents.getURL() } catch (e) { }
      try { mainWindow.contentView.removeChildView(t.view) } catch (e) { }
      addedViews.delete(t.view)
      try { t.view.webContents.close() } catch (e) { }
    }
    t.view = null
  }

  if (profile.envId && profile.debugPort) {
    closeMLProfile(profile.envId).catch(() => { })
    profile.debugPort = null
  }

  profile.suspended = true
  notifyProfileChange(profileId)
  scheduleAppStateSave()
}

function resumeProfile(profileId, makeActive) {
  const profile = profiles.get(profileId)
  if (!profile) return

  const showActiveTab = () => {
    if (!makeActive) return
    const tabs = tabsByProfile.get(profileId) || []
    const tab = tabs.find((t) => t.id === profile.activeTabId) || tabs[0]
    if (tab && tab.view) showView(tab.view)
  }

  if (!profile.suspended) {
    showActiveTab()
    return
  }

  if (profile.envId) {
    profile.launching = true
    notifyProfileChange(profileId)
    launchMLProfileFull(profileId, profile.envId, profile.name).then(showActiveTab).catch(() => { })
    return
  }

  profile.suspended = false
  const tabs = tabsByProfile.get(profileId) || []
  const activeTabId = profile.activeTabId || (tabs[0] && tabs[0].id)
  const tab = tabs.find((t) => t.id === activeTabId)
  if (tab && !tab.view) {
    tab.view = createView(`persist:${profileId}`)
    tab.view.webContents.loadURL(tab.url || 'about:blank')
    attachTabHandlers(profileId, tab)
  }
  showActiveTab()
  notifyProfileChange(profileId)
  scheduleAppStateSave()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  console.log('[Main] Window created');

  mainWindow.loadFile('index.html')
  // DevTools открываются только если включён debug-лог (через .env MORELOGIN_DEBUG=true)
  if (settings.debugLogs) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  // Перехватываем Ctrl+V для вставки plain text в активную вкладку
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if ((input.control || input.meta) && input.key === 'v' && input.type === 'keyDown') {
      if (activeView && !activeView.webContents.isDestroyed()) {
        const { clipboard } = require('electron')
        const text = clipboard.readText()
        if (text) {
          ipcMain.emit('paste-plain-text', null, text)
          // Вставляем напрямую в view
          const escaped = JSON.stringify(text)
          activeView.webContents.executeJavaScript(`
            (() => {
              const el = document.activeElement;
              if (!el) return;
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
                const plain = ${escaped};
                if (el.isContentEditable) {
                  document.execCommand('insertText', false, plain);
                } else {
                  const s = el.selectionStart, e2 = el.selectionEnd, v = el.value;
                  el.value = v.slice(0, s) + plain + v.slice(e2);
                  el.selectionStart = el.selectionEnd = s + plain.length;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }
            })()
          `).catch(() => { })
        }
      }
    }
  })

  mainWindow.on('resize', updateActiveViewBounds)
  mainWindow.on('maximize', updateActiveViewBounds)
  mainWindow.on('unmaximize', updateActiveViewBounds)
  mainWindow.on('enter-full-screen', () => { isFullscreen = true })
  mainWindow.on('leave-full-screen', () => { isFullscreen = false; updateActiveViewBounds() })
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (activeProfileId && profiles.has(activeProfileId)) {
        resumeProfile(activeProfileId, true)
      }
    }, 50)
  })
}

app.whenReady().then(() => {
  loadSettings()
  loadAppState()
  createWindow()
})

app.on('window-all-closed', () => {
  saveAppStateNow()
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('before-quit', () => { saveAppStateNow() })

ipcMain.handle('create-profile', async (_e, name) => {
  const id = uid()
  const profile = {
    id,
    name: name || 'Профиль',
    envId: null,
    debugPort: null,
    activeTabId: null,
    suspended: false,
    launching: false,
    mlError: null,
    createdAt: Date.now()
  }
  profiles.set(id, profile)
  tabsByProfile.set(id, [])

  const tab = {
    id: uid(),
    url: 'about:blank',
    title: 'about:blank',
    view: createView(`persist:${id}`)
  }
  tabsByProfile.get(id).push(tab)
  profile.activeTabId = tab.id
  attachTabHandlers(id, tab)
  tab.view.webContents.loadURL(tab.url)

  if (activeProfileId === id) showView(tab.view)
  scheduleAppStateSave()
  return serializeProfile(profile)
})

ipcMain.handle('switch-profile', async (_e, profileId) => {
  const profile = profiles.get(profileId)
  if (!profile) return null
  if (activeProfileId === profileId) {
    clearSuspendCountdown(profileId)
    return serializeProfile(profile)
  }

  const oldActiveId = activeProfileId
  if (oldActiveId) {
    const oldProfile = profiles.get(oldActiveId)
    if (oldProfile) {
      const tabs = tabsByProfile.get(oldActiveId) || []
      for (const t of tabs) {
        if (t.view && !t.view.webContents.isDestroyed()) {
          try { t.url = t.view.webContents.getURL() } catch (e) { }
          t.view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
        }
      }
    }
    startSuspendCountdown(oldActiveId)
  }

  if (profile.suspended) resumeProfile(profileId, false)

  activeProfileId = profileId
  clearSuspendCountdown(profileId)

  const tabs = tabsByProfile.get(profileId) || []
  const targetId = profile.activeTabId || (tabs[0] && tabs[0].id)
  const tab = tabs.find((t) => t.id === targetId)

  if (tab) {
    if (!tab.view) {
      const partition = profile.envId ? `persist:ml-${profile.envId}` : `persist:${profileId}`
      tab.view = createView(partition)
      tab.view.webContents.loadURL(tab.url || 'about:blank')
      attachTabHandlers(profileId, tab)
    }
    profile.activeTabId = tab.id
    showView(tab.view)
  }
  scheduleAppStateSave()
  return serializeProfile(profile)
})

ipcMain.handle('new-tab', async (_e, { profileId, url }) => {
  const profile = profiles.get(profileId)
  if (!profile) return null
  if (profile.suspended) resumeProfile(profileId, profileId === activeProfileId)
  const tabs = tabsByProfile.get(profileId) || []
  const partition = profile.envId ? `persist:ml-${profile.envId}` : `persist:${profileId}`
  const tab = {
    id: uid(),
    url: url || 'about:blank',
    title: 'Новая вкладка',
    view: createView(partition)
  }
  tabs.push(tab)
  tabsByProfile.set(profileId, tabs)
  profile.activeTabId = tab.id
  attachTabHandlers(profileId, tab)
  tab.view.webContents.loadURL(tab.url)
  if (profileId === activeProfileId) showView(tab.view)
  scheduleAppStateSave()
  return serializeTab(tab)
})

ipcMain.handle('switch-tab', async (_e, { profileId, tabId }) => {
  const profile = profiles.get(profileId)
  if (!profile) return null
  if (profile.suspended) resumeProfile(profileId, profileId === activeProfileId)
  const tabs = tabsByProfile.get(profileId) || []
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return null
  if (!tab.view) {
    const partition = profile.envId ? `persist:ml-${profile.envId}` : `persist:${profileId}`
    tab.view = createView(partition)
    tab.view.webContents.loadURL(tab.url || 'about:blank')
    attachTabHandlers(profileId, tab)
  }
  profile.activeTabId = tabId
  if (profileId === activeProfileId) showView(tab.view)
  scheduleAppStateSave()
  return serializeTab(tab)
})

ipcMain.handle('close-tab', async (_e, { profileId, tabId }) => {
  const tabs = tabsByProfile.get(profileId) || []
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return null
  const tab = tabs[idx]
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    if (activeView === tab.view) activeView = null
    try { mainWindow.contentView.removeChildView(tab.view) } catch { }
    addedViews.delete(tab.view)
    tab.view.webContents.close()
  }
  tabs.splice(idx, 1)
  const profile = profiles.get(profileId)
  if (profile && profile.activeTabId === tabId) {
    const next = tabs[idx] || tabs[idx - 1] || tabs[0]
    profile.activeTabId = next ? next.id : null
    if (next && next.view && !next.view.webContents.isDestroyed() && profileId === activeProfileId) showView(next.view)
  }
  scheduleAppStateSave()
  return profile ? profile.activeTabId : null
})

ipcMain.handle('reorder-tabs', async (_e, { profileId, fromIdx, toIdx }) => {
  const tabs = tabsByProfile.get(profileId)
  if (!tabs) return null
  if (fromIdx < 0 || fromIdx >= tabs.length || toIdx < 0 || toIdx >= tabs.length || fromIdx === toIdx) {
    return tabs.map(serializeTab)
  }
  const [moved] = tabs.splice(fromIdx, 1)
  tabs.splice(toIdx, 0, moved)
  scheduleAppStateSave()
  return tabs.map(serializeTab)
})

ipcMain.handle('remove-profile', async (_e, profileId) => {
  const profile = profiles.get(profileId)
  clearSuspendCountdown(profileId)
  const tabs = tabsByProfile.get(profileId) || []
  for (const t of tabs) {
    if (t.view && !t.view.webContents.isDestroyed()) {
      if (activeView === t.view) activeView = null
      try { mainWindow.contentView.removeChildView(t.view) } catch { }
      addedViews.delete(t.view)
      t.view.webContents.close()
    }
  }
  if (profile && profile.envId && profile.debugPort) {
    closeMLProfile(profile.envId).catch(() => { })
  }
  profiles.delete(profileId)
  tabsByProfile.delete(profileId)

  if (activeProfileId === profileId) {
    activeProfileId = null
    activeView = null
    const firstId = profiles.keys().next().value
    if (firstId) {
      const p = profiles.get(firstId)
      const tabs2 = tabsByProfile.get(firstId) || []
      const targetId = p.activeTabId || (tabs2[0] && tabs2[0].id)
      const t = tabs2.find((x) => x.id === targetId)
      if (t) {
        activeProfileId = firstId
        if (!t.view && !p.suspended) {
          const partition = p.envId ? `persist:ml-${p.envId}` : `persist:${firstId}`
          t.view = createView(partition)
          t.view.webContents.loadURL(t.url || 'about:blank')
          attachTabHandlers(firstId, t)
        }
        if (t.view && !p.suspended) showView(t.view)
      }
    }
  }
  scheduleAppStateSave()
  return Array.from(profiles.values()).map(serializeProfile)
})

ipcMain.handle('list-profiles', async () => ({
  profiles: Array.from(profiles.values()).map(serializeProfile),
  activeProfileId
}))

ipcMain.handle('set-files-panel-state', async (_e, { visible, width }) => {
  filesPanelVisible = !!visible
  if (typeof width === 'number') {
    filesPanelWidth = Math.max(FILES_PANEL_MIN_WIDTH, Math.min(FILES_PANEL_MAX_WIDTH, width))
  }
  updateActiveViewBounds()
  return { visible: filesPanelVisible, width: filesPanelWidth }
})

ipcMain.handle('get-files-panel-state', async () => ({ visible: filesPanelVisible, width: filesPanelWidth }))

ipcMain.handle('overlay-visible', async (_e, visible) => {
  overlayVisible = !!visible
  updateActiveViewBounds()
  return overlayVisible
})

ipcMain.handle('navigate', async (_e, { profileId, tabId, url }) => {
  const tabs = tabsByProfile.get(profileId) || []
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || !tab.view) return null
  let u = url
  if (u && !/^https?:\/\//i.test(u) && !u.startsWith('about:') && !u.startsWith('file:') && !u.startsWith('chrome:')) {
    u = 'https://' + u
  }
  tab.view.webContents.loadURL(u)
  tab.url = u
  scheduleAppStateSave()
  return { url: u }
})

ipcMain.handle('nav-back', async (_e, { profileId, tabId }) => {
  const tabs = tabsByProfile.get(profileId) || []
  const tab = tabs.find((t) => t.id === tabId)
  if (tab && tab.view && tab.view.webContents.canGoBack()) tab.view.webContents.goBack()
})

ipcMain.handle('nav-forward', async (_e, { profileId, tabId }) => {
  const tabs = tabsByProfile.get(profileId) || []
  const tab = tabs.find((t) => t.id === tabId)
  if (tab && tab.view && tab.view.webContents.canGoForward()) tab.view.webContents.goForward()
})

ipcMain.handle('nav-refresh', async (_e, { profileId, tabId }) => {
  const tabs = tabsByProfile.get(profileId) || []
  const tab = tabs.find((t) => t.id === tabId)
  if (tab && tab.view) tab.view.webContents.reload()
})

ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close() })

ipcMain.handle('ml:list', async () => {
  try {
    const cached = profileService.getCachedProfiles()
    if (cached && cached.length > 0) {
      // Fetch fresh in background
      profileService.getProfiles().then(profiles => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('ml-list-updated', { profiles })
        }
      }).catch(e => {
        if (settings.debugLogs) console.error('Background profile update failed:', e.message)
      })
      return { ok: true, profiles: cached }
    }
    const profiles = await profileService.getProfiles()
    return { ok: true, profiles }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('run-diagnostics', async () => {
  if (settings.debugLogs) console.log('Diagnostics requested from renderer')
  try {
    const diag = await profileService.runDiagnostics()
    return {
      preload: true,
      ipc: true,
      ...diag
    }
  } catch (e) {
    return {
      preload: true,
      ipc: true,
      profileService: false,
      moreloginConnection: false,
      moreloginResponse: { error: e.message },
      profilesFound: 0
    }
  }
})

ipcMain.handle('ml:import', async (_e, envId) => {
  try {
    let mlList = []
    try { mlList = await loadMoreLoginProfiles() } catch (e) { }
    const mlInfo = mlList.find((p) => p.envId === String(envId))
    if (!mlInfo) throw new Error(`Профиль envId=${envId} не найден в MoreLogin`)

    const id = uid()
    const profile = {
      id,
      name: mlInfo.name,
      envId: String(envId),
      debugPort: null,
      activeTabId: null,
      suspended: false,
      launching: true,
      mlError: null,
      createdAt: Date.now()
    }
    profiles.set(id, profile)
    tabsByProfile.set(id, [])

    launchMLProfileFull(id, String(envId), mlInfo.name).catch((e) => {
      if (settings.debugLogs) console.error('ML launch full error:', e)
    })

    scheduleAppStateSave()
    return { ok: true, profile: serializeProfile(profile) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('ml:sync-cookies', async (_e, profileId) => {
  const profile = profiles.get(profileId)
  if (!profile || !profile.envId || !profile.debugPort) return { ok: false, error: 'Profile not running' }
  try {
    const sess = session.fromPartition(`persist:ml-${profile.envId}`)
    const count = await syncCookies(profile.debugPort, sess)
    return { ok: true, count }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('ml:close', async (_e, profileId) => {
  const profile = profiles.get(profileId)
  if (!profile) return { ok: false, error: 'Profile not found' }
  if (profile.envId) await closeMLProfile(profile.envId)
  profile.debugPort = null
  profile.suspended = true
  for (const t of (tabsByProfile.get(profileId) || [])) {
    if (t.view && !t.view.webContents.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(t.view) } catch { }
      addedViews.delete(t.view)
      t.view.webContents.close()
    }
  }
  tabsByProfile.set(profileId, [])
  profile.activeTabId = null
  if (activeProfileId === profileId) activeView = null
  notifyProfileChange(profileId)
  scheduleAppStateSave()
  return { ok: true }
})

ipcMain.handle('ml:relaunch', async (_e, profileId) => {
  const profile = profiles.get(profileId)
  if (!profile || !profile.envId) return { ok: false, error: 'Not an ML profile' }
  if (profile.launching) return { ok: false, error: 'Already launching' }
  launchMLProfileFull(profileId, profile.envId, profile.name).catch((e) => {
    if (settings.debugLogs) console.error('ML relaunch error:', e)
  })
  return { ok: true, profile: serializeProfile(profile) }
})

ipcMain.handle('fs:list-folder', async (_e, folderPath) => {
  try { return { ok: true, ...listFolder(folderPath) } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle('fs:pick-directory', async () => {
  if (!mainWindow) return { ok: false, error: 'No window' }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: filesPanelRoot || os.homedir()
  })
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
  const picked = result.filePaths[0]
  filesPanelRoot = picked
  settings.lastFolder = picked
  saveSettings()
  return { ok: true, path: picked, ...listFolder(picked) }
})

ipcMain.handle('fs:set-root', async (_e, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) return { ok: false, error: 'Invalid path' }
  const resolved = path.resolve(folderPath)
  const stat = safeStat(resolved)
  if (!stat || !stat.isDirectory()) return { ok: false, error: 'Path is not a directory' }
  filesPanelRoot = resolved
  settings.lastFolder = resolved
  saveSettings()
  return { ok: true, ...listFolder(resolved) }
})

ipcMain.handle('fs:get-root', async () => ({
  ok: true,
  path: filesPanelRoot,
  folder: filesPanelRoot ? listFolder(filesPanelRoot) : null
}))

ipcMain.handle('fs:archive-folder', async (_e, { folderPath, destPath }) => {
  try {
    if (typeof folderPath !== 'string' || !folderPath) throw new Error('Invalid folder path')
    const src = path.resolve(folderPath)
    const stat = safeStat(src)
    if (!stat || !stat.isDirectory()) throw new Error('Source is not a directory')
    const target = destPath && typeof destPath === 'string'
      ? path.resolve(destPath)
      : path.join(path.dirname(src), path.basename(src) + '.zip')
    if (fs.existsSync(target)) {
      try { fs.unlinkSync(target) } catch (e) { }
    }
    const result = await archiveFolderTo(src, target)
    return { ok: true, path: result.path, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Архивация нескольких файлов/папок в один zip (максимальное сжатие)
ipcMain.handle('fs:archive-multiple', async (_e, { paths, destPath }) => {
  try {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('No paths provided')
    const resolvedPaths = paths.map((p) => path.resolve(p)).filter((p) => fs.existsSync(p))
    if (resolvedPaths.length === 0) throw new Error('None of the paths exist')

    const target = destPath && typeof destPath === 'string'
      ? path.resolve(destPath)
      : path.join(path.dirname(resolvedPaths[0]), 'archive_' + Date.now() + '.zip')

    if (fs.existsSync(target)) { try { fs.unlinkSync(target) } catch (e) { } }

    const result = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target)
      const archive = archiver('zip', { zlib: { level: ARCHIVE_LEVEL } })
      let settled = false
      out.on('close', () => { if (!settled) { settled = true; resolve({ path: target, bytes: archive.pointer() }) } })
      out.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
      archive.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
      archive.pipe(out)
      for (const p of resolvedPaths) {
        const stat = safeStat(p)
        if (!stat) continue
        if (stat.isDirectory()) {
          archive.directory(p, path.basename(p), (entry) => {
            const parts = entry.name.split('/').filter(Boolean)
            if (parts.some(isExcludedName)) return false
            return entry
          })
        } else {
          archive.file(p, { name: path.basename(p) })
        }
      }
      archive.finalize().catch((e) => { if (!settled) { settled = true; reject(e) } })
    })
    return { ok: true, path: result.path, bytes: result.bytes }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.on('fs:start-drag', (e, { filePath, isFolder }) => {
  if (typeof filePath !== 'string' || !filePath) return
  if (!fs.existsSync(filePath)) return
  if (isFolder) {
    const baseName = path.basename(filePath)
    const zipPath = path.join(path.dirname(filePath), baseName + '.drag.zip')
    archiveFolderTo(filePath, zipPath).then(() => {
      try {
        if (e.sender && !e.sender.isDestroyed()) {
          e.sender.startDrag({ file: zipPath, icon: getDragIcon() })
        }
      } catch (err) {
        if (settings.debugLogs) console.error('startDrag folder error:', err.message)
        try { fs.unlinkSync(zipPath) } catch (e2) { }
      }
    }).catch((err) => {
      if (settings.debugLogs) console.error('archive for drag error:', err.message)
    })
  } else {
    try { e.sender.startDrag({ file: filePath, icon: getDragIcon() }) }
    catch (err) { if (settings.debugLogs) console.error('startDrag file error:', err.message) }
  }
})

ipcMain.handle('fs:reveal-in-folder', async (_e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid path')
    if (!fs.existsSync(filePath)) throw new Error('Path does not exist')
    shell.showItemInFolder(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:open-path', async (_e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid path')
    if (!fs.existsSync(filePath)) throw new Error('Path does not exist')
    const err = await shell.openPath(filePath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('fs:copy-path', async (_e, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid path')
    const { clipboard } = require('electron')
    clipboard.writeText(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('get-settings', async () => ({
  mlHost: settings.mlHost,
  mlPort: settings.mlPort,
  pageSize: settings.pageSize,
  autoLoad: settings.autoLoad,
  headlessStart: settings.headlessStart,
  debugLogs: settings.debugLogs,
  archiveExclusions: settings.archiveExclusions.slice(),
  defaults: {
    archiveExclusions: DEFAULT_EXCLUSIONS.slice(),
    mlHost: '127.0.0.1',
    mlPort: 40000,
    pageSize: 50
  }
}))

ipcMain.handle('save-settings', async (_e, payload) => {
  try {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload')
    if (typeof payload.mlHost === 'string' && payload.mlHost.trim()) {
      settings.mlHost = payload.mlHost.trim()
    }
    if (typeof payload.mlPort === 'number' && payload.mlPort > 0 && payload.mlPort < 65536) {
      settings.mlPort = Math.floor(payload.mlPort)
    } else if (typeof payload.mlPort === 'string' && parseInt(payload.mlPort, 10) > 0) {
      settings.mlPort = parseInt(payload.mlPort, 10)
    }
    if (typeof payload.pageSize === 'number' && payload.pageSize > 0 && payload.pageSize <= 1000) {
      settings.pageSize = Math.floor(payload.pageSize)
    } else if (typeof payload.pageSize === 'string' && parseInt(payload.pageSize, 10) > 0) {
      settings.pageSize = parseInt(payload.pageSize, 10)
    }
    if (typeof payload.autoLoad === 'boolean') settings.autoLoad = payload.autoLoad
    if (typeof payload.headlessStart === 'boolean') settings.headlessStart = payload.headlessStart
    if (typeof payload.debugLogs === 'boolean') settings.debugLogs = payload.debugLogs
    if (Array.isArray(payload.archiveExclusions)) {
      settings.archiveExclusions = payload.archiveExclusions
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim())
    }
    saveSettings()
    return {
      ok: true, settings: {
        mlHost: settings.mlHost,
        mlPort: settings.mlPort,
        pageSize: settings.pageSize,
        autoLoad: settings.autoLoad,
        headlessStart: settings.headlessStart,
        debugLogs: settings.debugLogs,
        archiveExclusions: settings.archiveExclusions.slice()
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('reset-settings', async () => {
  settings.mlHost = process.env.MORELOGIN_LOCAL_HOST || '127.0.0.1'
  settings.mlPort = parseInt(process.env.MORELOGIN_LOCAL_PORT || '40000', 10)
  settings.pageSize = parseInt(process.env.MORELOGIN_PAGE_SIZE || '50', 10)
  settings.autoLoad = (process.env.MORELOGIN_AUTO_LOAD || 'true') !== 'false'
  settings.headlessStart = (process.env.MORELOGIN_HEADLESS_START || 'true') !== 'false'
  settings.debugLogs = (process.env.MORELOGIN_DEBUG || 'false') === 'true'
  settings.archiveExclusions = DEFAULT_EXCLUSIONS.slice()
  saveSettings()
  return {
    ok: true, settings: {
      mlHost: settings.mlHost,
      mlPort: settings.mlPort,
      pageSize: settings.pageSize,
      autoLoad: settings.autoLoad,
      headlessStart: settings.headlessStart,
      debugLogs: settings.debugLogs,
      archiveExclusions: settings.archiveExclusions.slice()
    }
  }
})

// Вставка текста как plain text (без форматирования) в активный WebContentsView
ipcMain.handle('paste-plain-text', async (_e, text) => {
  if (!activeView || activeView.webContents.isDestroyed()) return { ok: false }
  try {
    const escaped = JSON.stringify(String(text))
    await activeView.webContents.executeJavaScript(`
      (() => {
        const el = document.activeElement;
        if (!el) return;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
          const plain = ${escaped};
          if (el.isContentEditable) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
              sel.deleteFromDocument();
              const node = document.createTextNode(plain);
              sel.getRangeAt(0).insertNode(node);
              sel.collapseToEnd();
            } else {
              document.execCommand('insertText', false, plain);
            }
          } else {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const val = el.value;
            el.value = val.slice(0, start) + plain + val.slice(end);
            el.selectionStart = el.selectionEnd = start + plain.length;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      })()
    `)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('ml:test-connection', async () => {
  try {
    const list = await loadMoreLoginProfiles()
    return { ok: true, count: list.length, host: settings.mlHost, port: settings.mlPort }
  } catch (err) {
    return { ok: false, error: err.message, host: settings.mlHost, port: settings.mlPort }
  }
})

function attachDevToolsListeners(view) {
  if (!view || view.webContents.isDestroyed()) return
  view.webContents.on('devtools-opened', () => {
    devtoolsOpen = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setAlwaysOnTop(true) } catch (e) { }
    }
  })
  view.webContents.on('devtools-closed', () => {
    devtoolsOpen = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setAlwaysOnTop(false) } catch (e) { }
    }
  })
}

ipcMain.handle('toggle-devtools', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const target = (activeView && !activeView.webContents.isDestroyed())
    ? activeView
    : (() => {
      const profileId = activeProfileId
      if (!profileId) return null
      const tabs = tabsByProfile.get(profileId) || []
      for (const t of tabs) {
        if (t.view && !t.view.webContents.isDestroyed()) return t.view
      }
      return null
    })()
  const wc = target ? target.webContents : mainWindow.webContents
  if (!wc || wc.isDestroyed()) return false
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools()
  } else {
    wc.openDevTools({ mode: 'detach' })
  }
  return wc.isDevToolsOpened()
})

ipcMain.handle('toggle-fullscreen', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  isFullscreen = !mainWindow.isFullScreen()
  mainWindow.setFullScreen(isFullscreen)
  return isFullscreen
})

ipcMain.handle('exit-fullscreen', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(false)
    isFullscreen = false
  }
  return false
})

ipcMain.handle('get-devtools-state', async () => devtoolsOpen)
ipcMain.handle('get-fullscreen-state', async () => isFullscreen)