(() => {

  const api = window.api

  const state = {
    profiles: [],
    activeProfileId: null,
    activeTabId: null,
    overlayVisible: false
  }

  // VS Code panel state
  let vscodePanelVisible = true
  let vscodePanelWidth = 500
  let vscodeZoom = 1.0
  const VSCODE_MIN_WIDTH = 200
  const VSCODE_MAX_WIDTH = 1200

  const $ = (id) => document.getElementById(id)

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag)
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k]
      else if (k === 'onclick') e.onclick = attrs[k]
      else if (k === 'onmousedown') e.onmousedown = attrs[k]
      else if (k === 'oncontextmenu') e.oncontextmenu = attrs[k]
      else if (k === 'title' || k.startsWith('data-')) e.setAttribute(k, attrs[k])
      else e[k] = attrs[k]
    }
    for (const c of children) {
      if (c == null) continue
      if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)))
      else e.appendChild(c)
    }
    return e
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function getProfileNumber(p, idx) {
    if (p.number != null) return p.number
    if (p.seqNo != null) return p.seqNo
    if (p.no != null) return p.no
    return idx + 1
  }

  function renderProfiles() {
    const left = $('titlebar-left')
    left.innerHTML = ''

    const ordered = state.profiles
      .map((p, idx) => ({ p, num: getProfileNumber(p, idx) }))
      .sort((a, b) => a.num - b.num)

    ordered.forEach(({ p, num }) => {
      const isActive = p.id === state.activeProfileId
      const isRunning = !p.suspended
      const classes = ['profile-tab']
      if (isActive) classes.push('active')
      if (p.envId) classes.push('ml')
      if (p.launching) classes.push('launching')
      if (p.suspended && !p.launching) classes.push('suspended')
      if (isRunning && !p.launching) classes.push('running')
      if (p._redHighlight) classes.push('red-highlight')
      const tooltip = p.name
        + (p.envId ? ` (envId: ${p.envId})` : '')
        + (p.launching ? ' — запуск...' : (isRunning ? ' — запущен' : ' — остановлен'))
      const tab = el('div', {
        class: classes.join(' '),
        title: tooltip,
        onclick: (e) => { if (!e.target.classList.contains('close')) selectProfile(p.id) },
        oncontextmenu: (e) => {
          e.preventDefault()
          const wasRed = p._redHighlight
          p._redHighlight = !p._redHighlight
          renderProfiles()
          if (!wasRed) return
          showProfileMenu(p, e)
        }
      },
        el('span', { class: 'pnum' }, String(num)),
        p.launching ? el('span', { class: 'spin', title: 'Запуск...' }) : null,
        el('span', {
          class: 'close',
          onclick: (e) => { e.stopPropagation(); stopProfile(p.id) },
          title: 'Закрыть профиль (сохранить сессию)'
        }, '×')
      )
      left.appendChild(tab)
    })

    left.appendChild(el('button', {
      class: 'tb-btn icon',
      onclick: createProfile,
      title: 'Новый профиль'
    }, '+'))
    left.appendChild(el('button', {
      class: 'tb-btn icon',
      onclick: showMLModal,
      title: 'Импорт из MoreLogin'
    }, '↓'))

    renderProfileCounts()
    updateActiveProfileName()
    $('empty-state').classList.toggle('visible', state.profiles.length === 0)
  }

  function renderProfileCounts() {
    const box = $('profile-counts')
    if (!box) return
    const total = state.profiles.length
    const running = state.profiles.filter(p => !p.suspended).length
    box.innerHTML = ''
    box.appendChild(el('span', {}, 'Всего: '))
    box.appendChild(el('b', {}, String(total)))
    box.appendChild(el('span', {}, '  ·  Запущено: '))
    box.appendChild(el('b', {}, String(running)))
  }

  function updateActiveProfileName() {
    const nameEl = $('active-profile-name')
    if (!nameEl) return
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    nameEl.textContent = profile ? profile.name : ''
    nameEl.title = profile ? profile.name : ''
  }

  function renderTabs() {
    const strip = $('tab-strip')
    strip.innerHTML = ''
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    if (!profile) return
    const tabs = profile.tabs || []
    tabs.forEach((t, idx) => {
      const isActive = t.id === state.activeTabId
      const tab = el('div', {
        class: 'tab' + (isActive ? ' active' : ''),
        draggable: 'true',
        'data-idx': String(idx),
        onclick: (e) => { if (!e.target.classList.contains('close')) selectTab(t.id) }
      },
        el('span', { class: 'title', title: t.url || '' }, t.title || 'New Tab'),
        el('span', {
          class: 'close',
          onclick: (e) => { e.stopPropagation(); closeTab(t.id) }
        }, '×')
      )
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(idx))
        tab.classList.add('dragging')
      })
      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging')
        strip.querySelectorAll('.tab').forEach(el => {
          el.classList.remove('drag-over-left', 'drag-over-right')
        })
      })
      tab.addEventListener('dragover', (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = tab.getBoundingClientRect()
        const before = (e.clientX - rect.left) < rect.width / 2
        tab.classList.toggle('drag-over-left', before)
        tab.classList.toggle('drag-over-right', !before)
      })
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right')
      })
      tab.addEventListener('drop', async (e) => {
        e.preventDefault()
        tab.classList.remove('drag-over-left', 'drag-over-right')
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10)
        if (isNaN(fromIdx) || fromIdx === idx) return
        const rect = tab.getBoundingClientRect()
        const before = (e.clientX - rect.left) < rect.width / 2
        let toIdx = before ? idx : idx + 1
        if (fromIdx < toIdx) toIdx -= 1
        if (fromIdx === toIdx) return
        const tabsNow = (state.profiles.find(p => p.id === state.activeProfileId) || {}).tabs || []
        if (toIdx < 0 || toIdx >= tabsNow.length) return
        const result = await api.reorderTabs(state.activeProfileId, fromIdx, toIdx)
        if (result && state.activeProfileId) {
          const profile = state.profiles.find(p => p.id === state.activeProfileId)
          if (profile) {
            profile.tabs = result
            profile.activeTabId = state.activeTabId
          }
          renderTabs()
        }
      })
      strip.appendChild(tab)
    })
    const addBtn = el('button', { class: 'new-tab-inline', onclick: newTab, title: 'Новая вкладка (Ctrl+T)' }, '+')
    strip.appendChild(addBtn)
    updateAddressBar()
  }

  function updateAddressBar() {
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    if (!profile) { $('address-bar').value = ''; return }
    const tab = (profile.tabs || []).find(t => t.id === state.activeTabId)
    $('address-bar').value = (tab && tab.url && !tab.url.startsWith('about:')) ? tab.url : ''
    $('btn-refresh').disabled = !state.activeTabId
    $('btn-back').disabled = !state.activeTabId
    $('btn-forward').disabled = !state.activeTabId
  }

  function showProfileMenu(p, evt) {
    const allTabs = document.querySelectorAll('.profile-tab')
    allTabs.forEach(t => t.classList.remove('ctx-active'))
    if (evt && evt.currentTarget) evt.currentTarget.classList.add('ctx-active')

    const isML = !!p.envId
    const menu = isML
      ? `Профиль ML: ${p.name}\n\n1 — Удалить навсегда\n2 — Переименовать\n3 — Пересинхронизировать cookies\n4 — Перезапустить ML\n5 — Закрыть в ML\n6 — Отмена`
      : `Профиль: ${p.name}\n\n1 — Удалить навсегда\n2 — Переименовать\n3 — Отмена`
    const choice = prompt(menu, isML ? '6' : '3')
    if (choice === '1') removeProfile(p.id)
    else if (choice === '2') {
      const newName = prompt('Новое имя:', p.name)
      if (newName && newName.trim()) {
        p.name = newName.trim()
        renderProfiles()
      }
    } else if (isML && choice === '3') {
      api.mlSyncCookies(p.id).then(r => {
        if (r.ok) console.log(`Synced ${r.count} cookies`)
      })
    } else if (isML && choice === '4') {
      api.mlRelaunch(p.id)
    } else if (isML && choice === '5') {
      api.mlClose(p.id).then(() => {
        p.debugPort = null
        p.suspended = true
        p.tabs = []
        p.activeTabId = null
        renderProfiles()
        renderTabs()
      })
    }
  }

  async function createProfile() {
    const name = prompt('Имя профиля:', 'Профиль ' + (state.profiles.length + 1))
    if (!name || !name.trim()) return
    const profile = await api.createProfile(name.trim())
    state.profiles.push(profile)
    state.activeProfileId = profile.id
    state.activeTabId = profile.activeTabId
    renderProfiles()
    renderTabs()
    if (state.activeProfileId !== profile.id) await selectProfile(profile.id)
  }

  async function selectProfile(id) {
    if (state.activeProfileId === id) return
    const profile = await api.switchProfile(id)
    if (!profile) return
    state.activeProfileId = id
    state.activeTabId = profile.activeTabId
    const existing = state.profiles.find(p => p.id === id)
    if (existing) {
      existing.tabs = profile.tabs
      existing.activeTabId = profile.activeTabId
      existing.suspended = profile.suspended
      existing.launching = profile.launching
    }
    renderProfiles()
    renderTabs()
  }

  async function stopProfile(id) {
    const res = await api.stopProfile(id)
    if (res && res.ok) {
      const p = state.profiles.find(p => p.id === id)
      if (p) Object.assign(p, res.profile)
      if (state.activeProfileId === id) {
        const next = state.profiles.find(p => p.id !== id)
        if (next) {
          await selectProfile(next.id)
          return
        } else {
          state.activeTabId = null
        }
      }
      renderProfiles()
      renderTabs()
    }
  }

  async function removeProfile(id) {
    if (!confirm('Удалить профиль?')) return
    const result = await api.removeProfile(id)
    state.profiles = result.profiles || result
    state.activeProfileId = result.activeProfileId || (state.profiles[0] && state.profiles[0].id) || null
    state.activeTabId = (state.profiles.find(p => p.id === state.activeProfileId) || {}).activeTabId || null
    renderProfiles()
    renderTabs()
  }

  async function newTab() {
    if (!state.activeProfileId) return
    const tab = await api.newTab(state.activeProfileId, 'about:blank')
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    if (profile) {
      profile.tabs = profile.tabs || []
      profile.tabs.push(tab)
      profile.activeTabId = tab.id
      state.activeTabId = tab.id
    }
    renderTabs()
  }

  async function selectTab(tabId) {
    if (!state.activeProfileId) return
    const tab = await api.switchTab(state.activeProfileId, tabId)
    if (!tab) return
    state.activeTabId = tabId
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    if (profile) profile.activeTabId = tabId
    renderTabs()
  }

  async function closeTab(tabId) {
    if (!state.activeProfileId) return
    const newActive = await api.closeTab(state.activeProfileId, tabId)
    const profile = state.profiles.find(p => p.id === state.activeProfileId)
    if (profile) {
      profile.tabs = (profile.tabs || []).filter(t => t.id !== tabId)
      profile.activeTabId = newActive
      state.activeTabId = newActive
    }
    renderTabs()
  }

  function toggleOverlay() {
    state.overlayVisible = !state.overlayVisible
    $('overlay').classList.toggle('visible', state.overlayVisible)
    api.overlayVisible(state.overlayVisible)
    if (state.overlayVisible) loadSettingsUI()
  }

  let statusHideTimer = null
  function showStatus(msg, kind = 'info') {
    const bar = $('status-bar')
    bar.textContent = msg
    bar.classList.add('visible')
    if (statusHideTimer) clearTimeout(statusHideTimer)
    statusHideTimer = setTimeout(() => {
      bar.classList.remove('visible')
      statusHideTimer = null
    }, 2200)
  }

  async function toggleDevTools() {
    const result = await api.toggleDevTools()
    $('btn-devtools').classList.toggle('devtools-active', !!result)
    showStatus(result ? '🐞 DevTools открыты' : '🐞 DevTools закрыты', 'info')
  }

  async function toggleFullScreen() {
    const result = await api.toggleFullScreen()
    $('btn-max').classList.toggle('fullscreen-active', !!result)
    showStatus(result ? '⛶ Полный экран' : '⛶ Оконный режим', 'info')
  }

  let settingsFormLoaded = false
  async function loadSettingsUI() {
    if (settingsFormLoaded) return
    const data = await api.getSettings()
    if (!data) return
    $('set-ml-host').value = data.mlHost || ''
    $('set-ml-port').value = data.mlPort || 40000
    $('set-page-size').value = data.pageSize || 50
    $('set-auto-load').checked = !!data.autoLoad
    $('set-headless').checked = !!data.headlessStart
    $('set-debug').checked = !!data.debugLogs
    $('set-exclusions').value = (data.archiveExclusions || []).join('\n')
    $('set-api-mode').value = data.apiMode || 'auto'
    $('set-api-id').value = data.apiId || ''
    $('set-api-key').value = data.apiKey || ''
    settingsFormLoaded = true
  }

  function setSettingsMsg(msg, kind) {
    const m = $('settings-msg')
    m.textContent = msg
    m.className = kind || ''
  }

  function parseExclusions(text) {
    if (!text) return []
    return text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  }

  async function saveSettingsUI() {
    const payload = {
      mlHost: $('set-ml-host').value.trim() || '127.0.0.1',
      mlPort: parseInt($('set-ml-port').value, 10) || 40000,
      pageSize: parseInt($('set-page-size').value, 10) || 50,
      autoLoad: $('set-auto-load').checked,
      headlessStart: $('set-headless').checked,
      debugLogs: $('set-debug').checked,
      archiveExclusions: parseExclusions($('set-exclusions').value),
      apiMode: $('set-api-mode').value,
      apiId: $('set-api-id').value.trim(),
      apiKey: $('set-api-key').value.trim()
    }
    const btn = $('btn-save-settings')
    btn.disabled = true
    setSettingsMsg('Сохранение…', 'info')
    const res = await api.saveSettings(payload)
    btn.disabled = false
    if (res && res.ok) {
      setSettingsMsg('✅ Настройки сохранены. Изменения применятся при следующем подключении к MoreLogin.', 'success')
    } else {
      setSettingsMsg('❌ Ошибка: ' + ((res && res.error) || 'unknown'), 'error')
    }
  }

  async function resetSettingsUI() {
    if (!confirm('Сбросить настройки к значениям по умолчанию?')) return
    const res = await api.resetSettings()
    if (res && res.ok) {
      settingsFormLoaded = false
      await loadSettingsUI()
      setSettingsMsg('🔄 Настройки сброшены к умолчаниям.', 'success')
    } else {
      setSettingsMsg('❌ Ошибка сброса', 'error')
    }
  }

  async function testConnection() {
    const btn = $('btn-test-connection')
    btn.disabled = true
    setSettingsMsg(`Подключение к ${$('set-ml-host').value.trim() || '127.0.0.1'}:${$('set-ml-port').value || 40000}…`, 'info')
    const res = await api.testMLConnection()
    btn.disabled = false
    if (res && res.ok) {
      setSettingsMsg(`✅ Соединение успешно. Найдено профилей: ${res.count}. Хост: ${res.host}:${res.port}`, 'success')
    } else {
      setSettingsMsg(`❌ Не удалось подключиться: ${(res && res.error) || 'unknown'} (${(res && res.host) || '?'}:${(res && res.port) || '?'})`, 'error')
    }
  }

  async function runDiagnosticsUI() {
    const modal = $('diag-modal')
    const content = $('diag-modal-content')
    modal.classList.add('visible')

    const log = (msg) => {
      content.textContent += msg + '\n'
      content.scrollTop = content.scrollHeight
    }

    content.textContent = '--- RUNNING DIAGNOSTICS ---\n'
    log('1. Renderer initialized: OK')
    log('2. Requesting preload -> IPC -> ProfileService -> MoreLogin API...')

    try {
      const rawRes = await api.diagnostics()
      const finalRes = { renderer: true, ...rawRes }
      log('\n--- DIAGNOSTICS RESULT ---')
      log(JSON.stringify(finalRes, null, 2))
      const originalDiag = window.api.diagnostics
      window.api.diagnostics = async () => {
        const r = await originalDiag()
        return { renderer: true, ...r }
      }
    } catch (e) {
      log('\n--- DIAGNOSTICS FATAL ERROR ---')
      log(e.message)
    }
  }

  async function showMLModal() {
    const modal = $('ml-modal')
    const list = $('ml-modal-list')
    modal.classList.add('visible')
    list.innerHTML = '<div class="ml-loading"><div class="spin"></div>Загрузка профилей из MoreLogin...</div>'

    const result = await api.mlList()
    if (!result.ok) {
      list.innerHTML = `<div class="ml-error">❌ Не удалось загрузить профили</div>`
      return
    }
    renderMLList(result.profiles)
  }

  function renderMLList(profiles) {
    const list = $('ml-modal-list')
    if (!profiles.length) {
      list.innerHTML = '<div class="ml-empty">В MoreLogin нет профилей.<br>Создайте профиль в MoreLogin и обновите список.</div>'
      return
    }

    const imported = new Set(state.profiles.filter(p => p.envId).map(p => p.envId))
    list.innerHTML = ''
    for (const p of profiles) {
      const isImported = imported.has(p.envId)
      const item = el('div', { class: 'ml-item' + (isImported ? ' imported' : '') },
        el('div', { class: 'ml-name' }, p.name + (isImported ? '  ✓ импортирован' : '')),
        el('div', { class: 'ml-meta' },
          el('span', {}, 'envId: ' + p.envId),
          p.groupName ? el('span', { class: 'group' }, p.groupName) : null,
          isImported ? el('span', { class: 'ok' }, '● активен') : null,
          p._source ? el('span', { class: 'source', style: 'color:#888;margin-left:8px;' }, '[' + p._source + ']') : null
        )
      )
      if (!isImported) {
        item.onclick = async () => {
          item.innerHTML = '<div class="ml-loading" style="padding:14px;"><div class="spin" style="margin:0 auto 8px;"></div>Запуск профиля и синхронизация cookies...</div>'
          const importRes = await api.mlImport(p.envId)
          if (importRes.ok) {
            state.profiles.push(importRes.profile)
            state.activeProfileId = importRes.profile.id
            state.activeTabId = importRes.profile.activeTabId
            hideMLModal()
            renderProfiles()
            renderTabs()
          } else {
            item.innerHTML = `<div class="ml-error">❌ ${escapeHtml(importRes.error)}</div>`
          }
        }
      }
      list.appendChild(item)
    }
  }

  function hideMLModal() {
    $('ml-modal').classList.remove('visible')
  }

  function showSplash(title, desc) {
    const splash = $('splash')
    if (!splash) return
    $('splash-title').textContent = title || ''
    $('splash-desc').textContent = desc || ''
    const err = $('splash-error')
    if (err) { err.style.display = 'none'; err.textContent = '' }
    const skip = $('splash-skip')
    if (skip) skip.style.display = 'none'
    splash.classList.add('visible')
  }

  function updateSplash(title, desc, errMsg) {
    if (title) $('splash-title').textContent = title
    if (desc !== undefined) $('splash-desc').textContent = desc
    if (errMsg) {
      const err = $('splash-error')
      if (err) { err.textContent = errMsg; err.style.display = 'block' }
    }
  }

  function hideSplash() {
    const splash = $('splash')
    if (splash) splash.classList.remove('visible')
  }

  async function autoLoadMLProfiles() {
    const settings = await api.getSettings()
    const cfg = settings || {}
    const host = cfg.mlHost || '127.0.0.1'
    const port = cfg.mlPort || 40000
    const apiAddr = `${host}:${port}`

    const hasExistingML = state.profiles.some((p) => p.envId)
    if (!hasExistingML) showSplash('Загрузка профилей MoreLogin…', `Подключаюсь к ${apiAddr}`)

    const skipBtn = $('splash-skip')
    if (skipBtn) {
      skipBtn.style.display = 'inline-block'
      skipBtn.onclick = () => {
        hideSplash()
        api.diagnostics().catch(() => { })
      }
    }

    let result
    try {
      result = await api.mlList()
    } catch (e) {
      updateSplash('MoreLogin недоступен', `Не удалось подключиться к ${apiAddr}`, String(e && e.message || e))
      setTimeout(hideSplash, 4000)
      return
    }

    if (!result || !result.ok) {
      updateSplash('Ошибка API MoreLogin', `POST http://${apiAddr}/api/env/page`, (result && result.error) || 'неизвестная ошибка')
      setTimeout(hideSplash, 4000)
      return
    }

    const mlProfiles = result.profiles || []
    if (!mlProfiles.length) {
      updateSplash('Профили не найдены', 'MoreLogin вернул пустой список. Создайте профиль в MoreLogin и обновите.')
      setTimeout(hideSplash, 2500)
      return
    }

    const importedEnvIds = new Set(state.profiles.filter((p) => p.envId).map((p) => String(p.envId)))
    const toImport = mlProfiles.filter((p) => !importedEnvIds.has(String(p.envId)))

    if (toImport.length === 0) {
      updateSplash('Профили загружены', `Все ${mlProfiles.length} профилей уже импортированы`)
      setTimeout(hideSplash, 1200)
      return
    }

    updateSplash('Импорт профилей…', `Найдено новых: ${toImport.length} из ${mlProfiles.length}`)

    let ok = 0
    let fail = 0
    for (const p of toImport) {
      try {
        const r = await api.mlImport(p.envId)
        if (r && r.ok && r.profile) {
          state.profiles.push(r.profile)
          ok++
        } else {
          fail++
        }
      } catch (e) {
        fail++
      }
      updateSplash('Импорт профилей…', `OK: ${ok}, ошибок: ${fail} из ${toImport.length}`)
    }

    if (!state.activeProfileId && state.profiles.length) {
      state.activeProfileId = state.profiles[0].id
      state.activeTabId = state.profiles[0].activeTabId
    }

    renderProfiles()
    renderTabs()

    if (fail === 0) {
      updateSplash('✅ Готово', `Импортировано ${ok} профилей`)
      setTimeout(hideSplash, 1500)
    } else {
      updateSplash('Импорт завершён с ошибками', `OK: ${ok}, ошибок: ${fail}. Импортированные можно перезапустить вручную.`)
      setTimeout(hideSplash, 4000)
    }
  }

  async function navigate(url) {
    if (!state.activeProfileId || !state.activeTabId) return
    let u = url.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u) && !u.startsWith('about:') && !u.startsWith('file:')) {
      if (u.includes('.') && !u.includes(' ')) u = 'https://' + u
      else u = 'https://www.google.com/search?q=' + encodeURIComponent(u)
    }
    const res = await api.navigate(state.activeProfileId, state.activeTabId, u)
    if (res) $('address-bar').value = res.url
  }

  function applyVscodePanelLayout() {
    const panel = document.getElementById('vscode-panel')
    const splitter = document.getElementById('vscode-splitter')
    if (!panel || !splitter) return
    if (vscodePanelVisible) {
      panel.classList.remove('hidden')
      panel.style.width = vscodePanelWidth + 'px'
      splitter.style.right = vscodePanelWidth + 'px'
      splitter.style.display = 'block'
    } else {
      panel.classList.add('hidden')
      splitter.style.display = 'none'
    }
    // Сообщаем main process об изменении — он пересчитает bounds WebContentsView
    if (window.api && window.api.vscodeSetPanelState) {
      window.api.vscodeSetPanelState(vscodePanelVisible, vscodePanelWidth)
    }
  }

  function initVscodePanel() {
    const btnToggle = document.getElementById('btn-toggle-vscode')
    const btnHide = document.getElementById('vscode-hide')
    const splitter = document.getElementById('vscode-splitter')
    const urlInput = document.getElementById('vscode-url-input')
    const btnGo = document.getElementById('vscode-go')
    const btnZoomIn = document.getElementById('vscode-zoom-in')
    const btnZoomOut = document.getElementById('vscode-zoom-out')
    const btnZoomReset = document.getElementById('vscode-zoom-reset')
    const zoomInfo = document.getElementById('vscode-zoom-info')

    // Восстановить состояние из main
    if (window.api && window.api.vscodeGetPanelState) {
      window.api.vscodeGetPanelState().then(s => {
        if (s) {
          vscodePanelVisible = s.visible
          vscodePanelWidth = s.width || 500
          applyVscodePanelLayout()
        }
      })
    }

    // Кнопка в тайтлбаре
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        vscodePanelVisible = !vscodePanelVisible
        applyVscodePanelLayout()
      })
    }

    // Кнопка скрыть в заголовке панели
    if (btnHide) {
      btnHide.addEventListener('click', () => {
        vscodePanelVisible = false
        applyVscodePanelLayout()
      })
    }

    // URL bar — перейти
    const goToUrl = () => {
      const url = (urlInput && urlInput.value.trim()) || ''
      if (!url) return
      let finalUrl = url
      if (!/^https?:\/\//i.test(finalUrl)) finalUrl = 'http://' + finalUrl
      if (window.api && window.api.vscodeLoadUrl) {
        window.api.vscodeLoadUrl(finalUrl)
      }
    }
    if (btnGo) btnGo.addEventListener('click', goToUrl)
    if (urlInput) {
      urlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); goToUrl() }
      })
    }

    // Масштаб
    const updateZoomInfo = () => {
      if (zoomInfo) zoomInfo.textContent = Math.round(vscodeZoom * 100) + '%'
    }
    const setZoom = (factor) => {
      vscodeZoom = Math.max(0.3, Math.min(3.0, factor))
      updateZoomInfo()
      if (window.api && window.api.vscodeSetZoom) window.api.vscodeSetZoom(vscodeZoom)
    }
    if (btnZoomIn) btnZoomIn.addEventListener('click', () => setZoom(vscodeZoom + 0.1))
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => setZoom(vscodeZoom - 0.1))
    if (btnZoomReset) btnZoomReset.addEventListener('click', () => setZoom(1.0))
    updateZoomInfo()

    // Splitter - drag to resize with live IPC throttle
    if (splitter) {
      let dragging = false
      let startX = 0
      let startWidth = 0
      let ipcThrottle = null

      const sendSplitterIpc = (w) => {
        if (ipcThrottle) return
        ipcThrottle = setTimeout(() => {
          ipcThrottle = null
          if (window.api && window.api.vscodeSetPanelState) {
            window.api.vscodeSetPanelState(vscodePanelVisible, w)
          }
        }, 16)
      }

      splitter.addEventListener('mousedown', e => {
        e.preventDefault()
        dragging = true
        startX = e.clientX
        startWidth = vscodePanelWidth
        splitter.classList.add('dragging')
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      })

      document.addEventListener('mousemove', e => {
        if (!dragging) return
        const delta = startX - e.clientX
        const newWidth = Math.max(VSCODE_MIN_WIDTH, Math.min(VSCODE_MAX_WIDTH, startWidth + delta))
        vscodePanelWidth = newWidth
        const panel = document.getElementById('vscode-panel')
        if (panel) panel.style.width = newWidth + 'px'
        splitter.style.right = newWidth + 'px'
        sendSplitterIpc(newWidth)
      })

      document.addEventListener('mouseup', () => {
        if (!dragging) return
        dragging = false
        splitter.classList.remove('dragging')
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (ipcThrottle) { clearTimeout(ipcThrottle); ipcThrottle = null }
        applyVscodePanelLayout()
      })
    }

    // Track mouse position to know which window to zoom
    let mouseOverVscode = false
    document.addEventListener('mousemove', e => {
      if (!vscodePanelVisible) { mouseOverVscode = false; return }
      mouseOverVscode = e.clientX >= (window.innerWidth - vscodePanelWidth)
    })

    // Ctrl+K - toggle VS Code panel
    // Ctrl+/-/0 - zoom the window under cursor
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return
        e.preventDefault()
        vscodePanelVisible = !vscodePanelVisible
        applyVscodePanelLayout()
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
          e.preventDefault()
          if (vscodePanelVisible && mouseOverVscode) {
            // Zoom VS Code panel
            if (e.key === '+' || e.key === '=') setZoom(vscodeZoom + 0.1)
            else if (e.key === '-') setZoom(vscodeZoom - 0.1)
            else if (e.key === '0') setZoom(1.0)
          } else {
            // Zoom main browser view
            if (window.api) {
              if (e.key === '+' || e.key === '=') window.api.zoomIn && window.api.zoomIn()
              else if (e.key === '-') window.api.zoomOut && window.api.zoomOut()
              else if (e.key === '0') window.api.zoomReset && window.api.zoomReset()
            }
          }
        }
      }
    })
  }

  async function init() {
    const data = await api.listProfiles()
    state.profiles = (data && data.profiles) || data || []
    state.activeProfileId = (data && data.activeProfileId) || (state.profiles[0] && state.profiles[0].id) || null
    state.activeTabId = (state.profiles.find(p => p.id === state.activeProfileId) || {}).activeTabId || null
    renderProfiles()
    renderTabs()

    api.getSettings().then((cfg) => {
      if (cfg && cfg.autoLoad !== false) {
        autoLoadMLProfiles().catch((e) => console.error('autoLoadML:', e))
      }
    }).catch((e) => console.error('getSettings:', e))

    $('btn-min').onclick = () => api.minimize()
    $('btn-max').onclick = toggleFullScreen
    $('btn-close').onclick = () => api.close()
    $('btn-settings').onclick = toggleOverlay
    const btnDevtools = $('btn-devtools')
    if (btnDevtools) btnDevtools.onclick = toggleDevTools
    $('btn-close-settings').onclick = toggleOverlay
    $('btn-save-settings').onclick = saveSettingsUI
    $('btn-reset-settings').onclick = resetSettingsUI
    $('btn-test-connection').onclick = testConnection
    $('btn-run-diagnostics').onclick = runDiagnosticsUI
    $('new-tab-btn').onclick = newTab
    $('ml-modal-close').onclick = hideMLModal
    $('ml-modal').onclick = (e) => { if (e.target.id === 'ml-modal') hideMLModal() }
    $('diag-modal-close').onclick = () => $('diag-modal').classList.remove('visible')
    $('diag-modal').onclick = (e) => { if (e.target.id === 'diag-modal') $('diag-modal').classList.remove('visible') }

    api.onMLListUpdated(({ profiles }) => {
      const modal = $('ml-modal')
      if (modal.classList.contains('visible')) {
        renderMLList(profiles)
      }
    })
    $('btn-back').onclick = () => state.activeTabId && api.navBack(state.activeProfileId, state.activeTabId)
    $('btn-forward').onclick = () => state.activeTabId && api.navForward(state.activeProfileId, state.activeTabId)
    $('btn-refresh').onclick = () => state.activeTabId && api.navRefresh(state.activeProfileId, state.activeTabId)
    $('address-bar').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') navigate(e.target.value)
    })

    api.onTabUpdated(({ profileId, tab }) => {
      const p = state.profiles.find(p => p.id === profileId)
      if (p) {
        const t = (p.tabs || []).find(t => t.id === tab.id)
        if (t) {
          if (typeof tab.title === 'string') t.title = tab.title
          if (typeof tab.url === 'string') t.url = tab.url
        }
      }
      if (profileId === state.activeProfileId) renderTabs()
    })

    api.onTabOpened(({ profileId, tab }) => {
      const p = state.profiles.find(p => p.id === profileId)
      if (p) {
        p.tabs = p.tabs || []
        if (!p.tabs.find(t => t.id === tab.id)) p.tabs.push(tab)
        p.activeTabId = tab.id
        if (profileId === state.activeProfileId) {
          state.activeTabId = tab.id
          renderTabs()
        }
      }
    })

    api.onProfileUpdated(({ profileId, profile }) => {
      const p = state.profiles.find(p => p.id === profileId)
      if (p) Object.assign(p, profile)
      renderProfiles()
      if (profileId === state.activeProfileId) renderTabs()
    })

    api.onProfileLaunched(({ profileId, profile }) => {
      const p = state.profiles.find(p => p.id === profileId)
      if (p) {
        Object.assign(p, profile)
        if ((!p.tabs || !p.tabs.length) && profile.tabs && profile.tabs.length) {
          p.tabs = profile.tabs
          p.activeTabId = profile.activeTabId
          state.activeTabId = profile.activeTabId
        }
        renderProfiles()
        if (profileId === state.activeProfileId) renderTabs()
        if (p.mlError) {
          console.error('ML profile error:', p.mlError)
        }
      }
    })

    api.onCookiesSynced(({ profileId, count }) => {
      if (profileId === state.activeProfileId) {
        console.log(`Synced ${count} cookies for active profile`)
      }
    })

    api.onShortcutCloseTab(() => { if (state.activeTabId) closeTab(state.activeTabId) })
    api.onShortcutNewTab(() => newTab())
    api.onShortcutFocusAddress(() => {
      const bar = $('address-bar')
      if (bar) { bar.focus(); bar.select() }
    })
    api.onShortcutNextTab(() => {
      const profile = state.profiles.find(p => p.id === state.activeProfileId)
      if (!profile || !profile.tabs || !profile.tabs.length) return
      const idx = profile.tabs.findIndex(t => t.id === state.activeTabId)
      const next = profile.tabs[(idx + 1) % profile.tabs.length]
      if (next) selectTab(next.id)
    })
    api.onShortcutPrevTab(() => {
      const profile = state.profiles.find(p => p.id === state.activeProfileId)
      if (!profile || !profile.tabs || !profile.tabs.length) return
      const idx = profile.tabs.findIndex(t => t.id === state.activeTabId)
      const prev = profile.tabs[(idx - 1 + profile.tabs.length) % profile.tabs.length]
      if (prev) selectTab(prev.id)
    })

    document.addEventListener('keydown', async (e) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i'))) {
        e.preventDefault()
        toggleDevTools()
        return
      }
      if (e.key === 'F5') {
        e.preventDefault()
        state.activeTabId && api.navRefresh(state.activeProfileId, state.activeTabId)
        return
      }
      if (e.key === 'F11') {
        e.preventDefault()
        toggleFullScreen()
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === 't' || e.key === 'T') { e.preventDefault(); newTab() }
        else if (e.key === 'e' || e.key === 'E') {
          e.preventDefault()
          const bar = $('address-bar'); if (bar) { bar.focus(); bar.select() }
        }
        else if (e.key === 'w' || e.key === 'W') {
          e.preventDefault()
          if (state.activeTabId) closeTab(state.activeTabId)
        }
      } else if (e.key === 'Escape') {
        if ($('ml-modal').classList.contains('visible')) { hideMLModal(); return }
        if (state.overlayVisible) { toggleOverlay(); return }
        const fsState = await api.getFullScreenState()
        if (fsState) { await api.exitFullScreen(); $('btn-max').classList.remove('fullscreen-active'); showStatus('⛶ Оконный режим', 'info'); return }
      }
    })

    $('titlebar').addEventListener('dblclick', (e) => {
      if (e.target.closest('.tb-btn') || e.target.closest('.profile-tab')) return
      api.maximize()
    })
  }

  init()
  initVscodePanel()

})()