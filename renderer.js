(() => {

  console.log('[Renderer] Loaded');

  window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded');
    console.log('window.api =', window.api);
    if (window.diagnostics) {
      console.log('window.diagnostics.ping() =', window.diagnostics.ping());
    } else {
      console.error('window.diagnostics is NOT available!');
    }
  });

  const api = window.api

  const state = {
    profiles: [],
    activeProfileId: null,
    activeTabId: null,
    filesPanelVisible: false,
    filesPanelWidth: 260,
    overlayVisible: false
  }

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

  function setShift() {
    const w = state.filesPanelVisible ? state.filesPanelWidth : 0
    document.documentElement.style.setProperty('--panel-w', w + 'px')
    $('toolbar').classList.toggle('shifted', state.filesPanelVisible)
    $('tabbar').classList.toggle('shifted', state.filesPanelVisible)
    $('overlay').classList.toggle('shifted', state.filesPanelVisible)
    $('files-panel').style.width = w + 'px'
    api.setFilesPanelState(state.filesPanelVisible, w)
  }

  // Номер профиля "как в MoreLogin": берём готовое поле от бэкенда, если оно
  // есть (number / seqNo / no), иначе — позиция в списке (fallback для локальных
  // профилей без явного номера).
  function getProfileNumber(p, idx) {
    if (p.number != null) return p.number
    if (p.seqNo != null) return p.seqNo
    if (p.no != null) return p.no
    return idx + 1
  }

  function renderProfiles() {
    const left = $('titlebar-left')
    left.innerHTML = ''
    // Кнопка файловой панели в titlebar
    left.appendChild(el('button', {
      class: 'tb-btn icon',
      onclick: toggleFilesPanel,
      title: 'Файлы (Ctrl+B)'
    }, '≡'))

    // Сортировка по возрастанию номера профиля
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
          // Toggle red highlight on right-click; show menu only if not toggling
          const wasRed = p._redHighlight
          p._redHighlight = !p._redHighlight
          // Re-render to update color immediately, then show menu only on non-highlight click
          renderProfiles()
          if (!wasRed) return // first right-click just marks red, no menu
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

  // Имя профиля показываем только рядом с адресной строкой — после его открытия
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
    // Visual feedback: soft red highlight on right-click
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

  function toggleFilesPanel() {
    state.filesPanelVisible = !state.filesPanelVisible
    $('files-panel').classList.toggle('hidden', !state.filesPanelVisible)
    setShift()
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

      // Assign to window.api.diagnostics for manual console access as requested
      const originalDiag = window.api.diagnostics;
      window.api.diagnostics = async () => {
        const r = await originalDiag();
        return { renderer: true, ...r };
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

  // ── Автозагрузка профилей из MoreLogin при старте (как в project1/mlInit) ──
  // Показывает splash, грузит список профилей, автоматически импортирует новые
  // (ещё не импортированные) — лениво, без запуска антидетект-браузера.
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

    // Показываем splash только если есть смысл — если уже есть локальные профили с envId,
    // всё равно пробежимся по списку ML, чтобы подтянуть новые.
    const hasExistingML = state.profiles.some((p) => p.envId)
    if (!hasExistingML) showSplash('Загрузка профилей MoreLogin…', `Подключаюсь к ${apiAddr}`)

    // Резолвим skip
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

    // Авто-импорт тех, которых ещё нет
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

    // Если до этого не было активного профиля — выберем первый
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

  function setupResize() {
    const handle = $('files-panel-resize')
    let dragging = false
    let startX = 0
    let startW = 0
    handle.addEventListener('mousedown', (e) => {
      dragging = true
      startX = e.clientX
      startW = state.filesPanelWidth
      document.body.style.cursor = 'ew-resize'
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return
      state.filesPanelWidth = Math.max(180, Math.min(480, startW + (e.clientX - startX)))
      setShift()
    })
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; document.body.style.cursor = '' }
    })
  }

  const fileTree = {
    root: null,          // текущий активный корень
    roots: [],           // список всех добавленных корней
    expanded: new Set(),
    cache: new Map(),
    selectedPath: null,
    selectedPaths: new Set(),
    folderSizeCache: new Map()
  }

  function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return ''
    if (bytes < 1024) return bytes + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let v = bytes / 1024
    for (let i = 0; i < units.length; i++) {
      if (v < 1024 || i === units.length - 1) return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[i]
      v /= 1024
    }
    return bytes + ' B'
  }

  function getDirName(p) {
    if (!p) return ''
    const parts = p.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || p
  }

  function getParentPath(p) {
    if (!p) return null
    const sep = p.includes('\\') ? '\\' : '/'
    const parts = p.split(sep).filter(Boolean)
    if (parts.length <= 1) return null
    parts.pop()
    return parts.join(sep)
  }

  function updateCrumbs(rootPath) {
    const el = $('files-crumbs')
    if (!rootPath) {
      el.innerHTML = '<span>Корень не выбран</span>'
      return
    }
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const parts = rootPath.split(sep).filter(Boolean)
    let html = ''
    let acc = rootPath.startsWith(sep) ? sep : (rootPath.includes(':') ? parts[0] + sep : '')
    for (let i = (rootPath.match(/^[A-Za-z]:/) ? 1 : 0); i < parts.length; i++) {
      if (i > (rootPath.match(/^[A-Za-z]:/) ? 1 : 0)) acc += sep
      acc += parts[i]
      const isLast = i === parts.length - 1
      html += `<span class="${isLast ? 'cur' : ''}">${escapeHtml(parts[i])}</span>`
      if (!isLast) html += '<span> / </span>'
    }
    el.innerHTML = html
    el.title = rootPath
  }

  function setTreeEmpty(msg) {
    const c = $('files-panel-content')
    c.innerHTML = ''
    const e = document.createElement('div')
    e.className = 'tree-empty'
    e.textContent = msg
    c.appendChild(e)
  }

  function setTreeLoading() {
    const c = $('files-panel-content')
    c.innerHTML = '<div class="tree-loading">Загрузка...</div>'
  }

  function buildRow(entry, depth, kind) {
    const row = document.createElement('div')
    row.className = 'tree-row'
    row.dataset.path = entry.path
    row.dataset.kind = kind
    row.dataset.depth = String(depth)
    row.style.paddingLeft = (4 + depth * 14) + 'px'

    const twisty = document.createElement('span')
    twisty.className = 'twisty' + (kind === 'file' || (kind === 'folder' && !entry.hasChildren) ? ' leaf' : '')
    twisty.textContent = kind === 'folder' ? (fileTree.expanded.has(entry.path) ? '▾' : '▸') : ''
    row.appendChild(twisty)

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = entry.name
    name.title = entry.path
    row.appendChild(name)

    const sizeEl = document.createElement('span')
    sizeEl.className = 'size'
    if (kind === 'file' && typeof entry.size === 'number') {
      sizeEl.textContent = formatSize(entry.size)
    } else if (kind === 'folder') {
      if (fileTree.folderSizeCache.has(entry.path)) {
        sizeEl.textContent = formatSize(fileTree.folderSizeCache.get(entry.path))
      } else {
        sizeEl.textContent = '…'
        api.fsGetFolderSize(entry.path).then(r => {
          if (r.ok) {
            fileTree.folderSizeCache.set(entry.path, r.size)
            sizeEl.textContent = formatSize(r.size)
          } else { sizeEl.textContent = '' }
        }).catch(() => { sizeEl.textContent = '' })
      }
    }
    row.appendChild(sizeEl)

    if (kind === 'folder') {
      const actions = document.createElement('span')
      actions.className = 'actions-inline'
      const arch = document.createElement('button')
      arch.textContent = '⎌'
      arch.title = 'Архивировать в .zip'
      arch.addEventListener('click', (e) => {
        e.stopPropagation()
        const sel = getSelectedPaths()
        if (sel.length > 1) archiveMultipleAction(sel)
        else archiveFolderAction(entry.path)
      })
      actions.appendChild(arch)
      const del = document.createElement('button')
      del.textContent = '✕'
      del.title = 'Удалить'
      del.style.color = '#f48771'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        const sel = getSelectedPaths()
        const targets = sel.length > 1 ? sel : [entry.path]
        if (!confirm(`Удалить ${targets.length} элем.?`)) return
        api.fsDeletePaths(targets).then(() => refreshTree())
      })
      actions.appendChild(del)
      row.appendChild(actions)
    }

    // ── Drag из файловой панели ──────────────────────────────────────────
    // WebContentsView — отдельный процесс рендеринга, нативный OS-drag туда не попадает.
    // Решение: при dragend над зоной webview читаем файл через IPC и вставляем текст
    // через уже рабочий механизм pastePlainText (тот же что Ctrl+V).
    const setupDrag = (isFolder) => {
      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy'
        const sel = getSelectedPaths()
        const paths = sel.length > 1 ? sel : [entry.path]
        e.dataTransfer.setData('text/plain', paths[0])
        window._draggingFilePaths = paths
        window._draggingIsFolder = isFolder
      })
      row.addEventListener('dragend', async (e) => {
        const paths = window._draggingFilePaths
        const draggingIsFolder = window._draggingIsFolder
        window._draggingFilePaths = null
        window._draggingIsFolder = null
        if (!paths || !paths.length) return

        // Проверяем попал ли drop в зону WebContentsView
        const panelW = state.filesPanelVisible ? state.filesPanelWidth : 0
        const chromeH = 96 // TITLEBAR(32) + TOOLBAR(36) + TABBAR(28)
        if (e.clientX <= panelW || e.clientY <= chromeH) return
        if (!state.activeProfileId) return

        for (const filePath of paths) {
          // Always insert the file NAME (basename), not the full content.
          // Full content insert only if user explicitly opens via context menu.
          const fileName = filePath.split(/[\\/]/).pop() || filePath
          const text = fileName
          const viewX = Math.round(e.clientX - panelW)
          const viewY = Math.round(e.clientY - chromeH)
          await api.pasteAtCoords(text, viewX, viewY)
        }
      })
    }

    if (kind === 'folder') {
      twisty.addEventListener('click', (e) => { e.stopPropagation(); toggleFolder(entry.path, row) })
      row.addEventListener('click', (e) => { selectRow(row, e.ctrlKey || e.metaKey); if (!e.ctrlKey && !e.metaKey) toggleFolder(entry.path, row) })
      setupDrag(true)
    } else {
      row.addEventListener('click', (e) => { selectRow(row, e.ctrlKey || e.metaKey) })
      setupDrag(false)
    }

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!fileTree.selectedPaths.has(entry.path)) selectRow(row, e.ctrlKey || e.metaKey)
      showFsContextMenu(e.clientX, e.clientY, entry, kind)
    })

    return row
  }

  function selectRow(row, ctrlKey) {
    if (ctrlKey) {
      const p = row.dataset.path
      if (fileTree.selectedPaths.has(p)) {
        fileTree.selectedPaths.delete(p)
        row.classList.remove('selected')
      } else {
        fileTree.selectedPaths.add(p)
        row.classList.add('selected')
      }
      fileTree.selectedPath = p
    } else {
      document.querySelectorAll('#files-panel-content .tree-row.selected').forEach((r) => r.classList.remove('selected'))
      fileTree.selectedPaths.clear()
      row.classList.add('selected')
      fileTree.selectedPath = row.dataset.path
      fileTree.selectedPaths.add(row.dataset.path)
    }
  }

  function getSelectedPaths() {
    return fileTree.selectedPaths.size > 0 ? Array.from(fileTree.selectedPaths) : (fileTree.selectedPath ? [fileTree.selectedPath] : [])
  }

  async function toggleFolder(folderPath, rowEl) {
    if (fileTree.expanded.has(folderPath)) {
      fileTree.expanded.delete(folderPath)
      const children = rowEl.nextElementSibling
      if (children && children.classList && children.classList.contains('tree-children')) children.remove()
      const twisty = rowEl.querySelector('.twisty')
      if (twisty) twisty.textContent = '▸'
      const icon = rowEl.querySelector('.icon')
      if (icon) icon.textContent = '📁'
      return
    }
    await expandFolder(folderPath, rowEl)
  }

  async function expandFolder(folderPath, rowEl) {
    const data = await loadFolder(folderPath)
    if (!data) return
    fileTree.expanded.add(folderPath)
    const twisty = rowEl.querySelector('.twisty')
    if (twisty) twisty.textContent = '▾'
    const icon = rowEl.querySelector('.icon')
    if (icon) icon.textContent = '📂'
    const depth = parseInt(rowEl.dataset.depth, 10) + 1
    const wrap = document.createElement('div')
    wrap.className = 'tree-children'
    for (const f of data.folders) wrap.appendChild(buildRow(f, depth, 'folder'))
    for (const f of data.files) wrap.appendChild(buildRow(f, depth, 'file'))
    rowEl.parentNode.insertBefore(wrap, rowEl.nextSibling)
  }

  async function loadFolder(folderPath) {
    if (!folderPath) return null
    if (fileTree.cache.has(folderPath)) return fileTree.cache.get(folderPath)
    const res = await api.fsListFolder(folderPath)
    if (!res.ok) {
      setTreeEmpty('Ошибка: ' + (res.error || 'unknown'))
      return null
    }
    fileTree.cache.set(folderPath, res)
    return res
  }

  function renderRoot(rootPath, data) {
    fileTree.expanded = new Set([rootPath])
    fileTree.cache = new Map([[rootPath, data]])
    const c = $('files-panel-content')
    c.innerHTML = ''
    for (const f of data.folders) c.appendChild(buildRow(f, 0, 'folder'))
    for (const f of data.files) c.appendChild(buildRow(f, 0, 'file'))
  }

  async function refreshTree() {
    if (!fileTree.root) return
    setTreeLoading()
    fileTree.cache.delete(fileTree.root)
    fileTree.selectedPaths.clear()
    fileTree.selectedPath = null
    const data = await loadFolder(fileTree.root)
    if (data) {
      renderRoot(fileTree.root, data)
      updateCrumbs(fileTree.root)
    } else {
      setTreeEmpty('Не удалось прочитать папку')
    }
  }

  async function pickDirectory() {
    await addDirectory()
  }

  async function archiveFolderAction(folderPath) {
    const res = await api.fsArchiveFolder(folderPath, null)
    if (!res.ok) alert('Ошибка архивации: ' + (res.error || 'unknown'))
  }

  async function archiveMultipleAction(paths) {
    const res = await api.fsArchiveMultiple({ paths, destPath: null })
    if (!res.ok) alert('Ошибка архивации: ' + (res.error || 'unknown'))
  }

  function hideFsContextMenu() {
    const m = $('fs-context-menu')
    m.classList.remove('visible')
    m.innerHTML = ''
  }

  function showFsContextMenu(x, y, entry, kind) {
    const m = $('fs-context-menu')
    m.innerHTML = ''
    const make = (label, cb) => {
      const i = document.createElement('div')
      i.className = 'item'
      i.textContent = label
      i.addEventListener('click', () => { hideFsContextMenu(); cb() })
      m.appendChild(i)
    }
    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s) }
    const sel = getSelectedPaths()
    const multi = sel.length > 1
    make('Открыть в проводнике', () => api.fsRevealInFolder(entry.path))
    make('Скопировать путь', () => api.fsCopyPath(entry.path))
    if (kind === 'file' && !multi) make('Открыть в браузере', () => api.fsOpenPath(entry.path))
    sep()
    if (kind === 'folder' || multi) {
      make(multi ? `Архивировать ${sel.length} элем.` : 'Архивировать в .zip', () => {
        if (multi) archiveMultipleAction(sel)
        else archiveFolderAction(entry.path)
      })
    }
    make(multi ? `Удалить ${sel.length} элем.` : 'Удалить', async () => {
      const targets = multi ? sel : [entry.path]
      if (!confirm(`Удалить ${targets.length} элем.?`)) return
      await api.fsDeletePaths(targets)
      fileTree.selectedPaths.clear()
      fileTree.selectedPath = null
      await refreshTree()
    })
    if (!multi) { sep(); make('Открыть через систему', () => api.fsOpenPath(entry.path)) }

    m.classList.add('visible')
    const rect = m.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - 4
    const maxY = window.innerHeight - rect.height - 4
    m.style.left = Math.min(x, maxX) + 'px'
    m.style.top = Math.min(y, maxY) + 'px'
  }

  function renderRootTabs() {
    const bar = $('files-roots-tabs')
    if (!bar) return
    if (fileTree.roots.length <= 1) { bar.style.display = 'none'; return }
    bar.style.display = 'flex'
    bar.innerHTML = ''
    fileTree.roots.forEach((rootPath, idx) => {
      const name = getDirName(rootPath)
      const isActive = rootPath === fileTree.root
      const tab = document.createElement('div')
      tab.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px 4px 0 0;cursor:pointer;font-size:11px;background:${isActive ? '#2a2a2a' : '#1a1a1a'};color:${isActive ? '#fff' : '#888'};border:1px solid ${isActive ? '#3a3a3a' : 'transparent'};`
      tab.textContent = name
      tab.title = rootPath
      tab.addEventListener('click', () => switchRoot(rootPath))
      const rm = document.createElement('span')
      rm.textContent = '×'
      rm.style.cssText = 'opacity:0.5;cursor:pointer;padding:0 2px;'
      rm.title = 'Удалить из панели'
      rm.addEventListener('click', (e) => { e.stopPropagation(); removeRoot(rootPath) })
      tab.appendChild(rm)
      bar.appendChild(tab)
    })
  }

  async function switchRoot(rootPath) {
    fileTree.root = rootPath
    fileTree.cache = new Map()
    fileTree.selectedPaths.clear()
    fileTree.selectedPath = null
    const data = await loadFolder(rootPath)
    if (data) { renderRoot(rootPath, data); updateCrumbs(rootPath) }
    renderRootTabs()
  }

  function removeRoot(rootPath) {
    fileTree.roots = fileTree.roots.filter(r => r !== rootPath)
    if (fileTree.root === rootPath) {
      if (fileTree.roots.length > 0) switchRoot(fileTree.roots[0])
      else {
        fileTree.root = null
        $('files-panel-content').innerHTML = '<div class="tree-empty">Добавьте папку через + в заголовке</div>'
        updateCrumbs(null)
      }
    }
    renderRootTabs()
  }

  async function addDirectory() {
    const res = await api.fsPickDirectory()
    if (!res.ok) { if (!res.canceled) setTreeEmpty('Ошибка: ' + (res.error || 'unknown')); return }
    if (!fileTree.roots.includes(res.path)) fileTree.roots.push(res.path)
    fileTree.root = res.path
    fileTree.cache.set(res.path, res)
    renderRoot(res.path, res)
    updateCrumbs(res.path)
    renderRootTabs()
  }

  async function initFileTree() {
    const r = await api.fsGetRoot()
    if (r.ok && r.path && r.folder) {
      fileTree.root = r.path
      if (!fileTree.roots.includes(r.path)) fileTree.roots.push(r.path)
      fileTree.expanded = new Set([r.path])
      fileTree.cache = new Map([[r.path, r.folder]])
      const c = $('files-panel-content')
      c.innerHTML = ''
      for (const f of r.folder.folders) c.appendChild(buildRow(f, 0, 'folder'))
      for (const f of r.folder.files) c.appendChild(buildRow(f, 0, 'file'))
      updateCrumbs(r.path)
    }
    $('btn-add-dir').onclick = addDirectory
    $('btn-pick-dir').onclick = async () => {
      // «Заменить» текущий корень на новую папку
      const res = await api.fsPickDirectory()
      if (!res.ok) { if (!res.canceled) setTreeEmpty('Ошибка: ' + (res.error || 'unknown')); return }
      if (fileTree.root && !fileTree.roots.includes(res.path)) {
        const idx = fileTree.roots.indexOf(fileTree.root)
        if (idx !== -1) fileTree.roots[idx] = res.path
        else fileTree.roots.push(res.path)
      } else if (!fileTree.roots.includes(res.path)) {
        fileTree.roots.push(res.path)
      }
      fileTree.root = res.path
      fileTree.cache.set(res.path, res)
      renderRoot(res.path, res)
      updateCrumbs(res.path)
      renderRootTabs()
    }
    $('btn-refresh-tree').onclick = refreshTree
    $('btn-close-files').onclick = toggleFilesPanel
    renderRootTabs()
    document.addEventListener('click', (e) => {
      const m = $('fs-context-menu')
      if (!m.contains(e.target)) hideFsContextMenu()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideFsContextMenu()
    })
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

  async function init() {
    const fpState = await api.getFilesPanelState()
    state.filesPanelVisible = fpState.visible
    state.filesPanelWidth = fpState.width
    if (state.filesPanelVisible) {
      $('files-panel').classList.remove('hidden')
    }
    setShift()

    const data = await api.listProfiles()
    state.profiles = (data && data.profiles) || data || []
    state.activeProfileId = (data && data.activeProfileId) || (state.profiles[0] && state.profiles[0].id) || null
    state.activeTabId = (state.profiles.find(p => p.id === state.activeProfileId) || {}).activeTabId || null
    renderProfiles()
    renderTabs()

    // ── Автозагрузка профилей из MoreLogin при старте (если включено) ──
    // Берём конфиг из settings; если autoLoad === false — пропускаем.
    api.getSettings().then((cfg) => {
      if (cfg && cfg.autoLoad !== false) {
        autoLoadMLProfiles().catch((e) => console.error('autoLoadML:', e))
      }
    }).catch((e) => console.error('getSettings:', e))

    $('btn-min').onclick = () => api.minimize()
    $('btn-max').onclick = toggleFullScreen
    $('btn-close').onclick = () => api.close()
    $('btn-settings').onclick = toggleOverlay  // теперь в titlebar-right
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

    setupResize()
    await initFileTree()

    api.onShortcutCloseTab(() => { if (state.activeTabId) closeTab(state.activeTabId) })
    api.onShortcutNewTab(() => newTab())
    api.onShortcutToggleFiles(() => toggleFilesPanel())
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
        if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleFilesPanel() }
        else if (e.key === 't' || e.key === 'T') { e.preventDefault(); newTab() }
        else if (e.key === 'e' || e.key === 'E') {
          e.preventDefault()
          const bar = $('address-bar'); if (bar) { bar.focus(); bar.select() }
        }
        else if (e.key === 'w' || e.key === 'W') {
          // Ctrl+W closes only the active browser tab, never the Electron window
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

})();