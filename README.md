# MoreLogin Browser Manager — v2.7

Electron-приложение для работы с антидетект-браузером MoreLogin через Local API.  
Имеет встроенную файловую панель и встроенный VS Code (через WSL + code-server) в правой панели.

---

## Стек и версии

| Компонент | Версия |
|-----------|--------|
| Electron | 42.x |
| Node.js | 18+ (рекомендуется 20 LTS) |
| code-server | 4.125.0 (через WSL) |
| WSL | Ubuntu 26.04 LTS |
| MoreLogin Desktop | Local API на `127.0.0.1:40000` |

---

## Структура проекта

```
morelogin-browser-manager/
├── main.js                  # Main process: окно, WebContentsView, IPC, профили, CDP, VS Code панель
├── preload.js               # contextBridge: exposeInMainWorld('api', ...) — мост renderer↔main
├── renderer.js              # Renderer process: весь UI — titlebar, tabs, файловая панель, VS Code панель
├── index.html               # HTML разметка + весь CSS (inline, один файл)
├── src/
│   └── services/
│       └── profileService.js  # Local API + Cloud API MoreLogin, кэш профилей, диагностика
├── package.json
├── .env                     # Переменные окружения (не коммитить)
├── .env.example             # Шаблон .env
└── README.md
```

---

## Архитектура

### Слои

```
┌─────────────────────────────────────────────────────┐
│  BrowserWindow (index.html)                          │
│  ┌─────────────┐  ┌──────────────┐                  │
│  │  Titlebar   │  │   Toolbar    │  ← renderer.js   │
│  ├─────────────┴──┴──────────────┤                  │
│  │           Tabbar              │  ← renderer.js   │
│  ├───────────────────┬───────────┤                  │
│  │                   │           │                  │
│  │  WebContentsView  │  VSCode   │  ← main.js       │
│  │  (activeView)     │  Panel    │                  │
│  │                   │ (vscode-  │                  │
│  │  ← браузерные     │  View)    │                  │
│  │    профили        │           │                  │
│  └───────────────────┴───────────┘                  │
│       ↑ filesPanelWidth    ↑ vscodePanelWidth        │
└─────────────────────────────────────────────────────┘
```

### Константы хрома (main.js)

```js
TITLEBAR_HEIGHT = 32
TOOLBAR_HEIGHT  = 36
TABBAR_HEIGHT   = 28
CHROME_HEIGHT   = 96  // сумма трёх
```

### Панели и bounds

В `main.js` есть три зоны контента:

- **Левая** — файловая панель (`filesPanelVisible`, `filesPanelWidth`, min=180, max=480, default=260)
- **Центральная** — `activeView` (WebContentsView браузера) — занимает всё оставшееся место
- **Правая** — VS Code панель (`vscodePanelVisible`, `vscodePanelWidth`, min=200, max=1200, default=500)

`getContentBounds()` считает bounds для `activeView`:
```js
x = filesPanelVisible ? filesPanelWidth : 0
width = windowWidth - left - (vscodePanelVisible ? vscodePanelWidth : 0)
y = CHROME_HEIGHT
height = windowHeight - CHROME_HEIGHT
```

`getVscodePanelBounds()` считает bounds для `vscodeView`:
```js
x = windowWidth - vscodePanelWidth
width = vscodePanelWidth
y = CHROME_HEIGHT
height = windowHeight - CHROME_HEIGHT
```

---

## Файлы — подробно

### main.js (2200+ строк)

**Глобальные переменные:**
```js
mainWindow          // BrowserWindow
activeView          // WebContentsView текущей вкладки
activeProfileId     // string
filesPanelVisible   // bool
filesPanelWidth     // number
vscodePanelVisible  // bool (default: true)
vscodePanelWidth    // number (default: 500)
vscodeView          // WebContentsView для VS Code
codeServerProcess   // child_process для WSL code-server
profiles            // Map<id, profile>
tabsByProfile       // Map<profileId, tab[]>
```

**Ключевые функции:**
| Функция | Что делает |
|---------|-----------|
| `getContentBounds()` | Считает bounds для activeView с учётом обеих панелей |
| `getVscodePanelBounds()` | Bounds для vscodeView |
| `updateActiveViewBounds()` | Применяет bounds к activeView + вызывает updateVscodeViewBounds() |
| `updateVscodeViewBounds()` | Применяет bounds к vscodeView |
| `showView(view)` | Переключает активный WebContentsView |
| `createView(partition)` | Создаёт WebContentsView с нужной сессией |
| `attachViewShortcuts(view)` | Ctrl+W, Ctrl+T, Ctrl+Tab, F12, Ctrl+/-, F11 на уровне view |
| `launchMLProfileFull()` | Запускает MoreLogin профиль: порт CDP → синк cookies → создаёт views |
| `suspendProfile()` | Приостанавливает профиль: убивает views, сохраняет историю |
| `resumeProfile()` | Возобновляет профиль |
| `syncCookies()` | CDP → Electron session (при запуске профиля) |
| `pushCookiesToML()` | Electron session → CDP (при suspend/close) |
| `captureTabHistory()` | Снимок navigationHistory для восстановления |
| `createWindow()` | Создаёт BrowserWindow, запускает WSL code-server, создаёт vscodeView |

**IPC handlers (59 штук):**
- `create-profile`, `switch-profile`, `remove-profile`, `stop-profile`, `list-profiles`
- `new-tab`, `switch-tab`, `close-tab`, `reorder-tabs`
- `navigate`, `nav-back`, `nav-forward`, `nav-refresh`
- `set-files-panel-state`, `get-files-panel-state`
- `overlay-visible`
- `window-minimize`, `window-maximize`, `window-close`
- `toggle-devtools`, `toggle-fullscreen`, `exit-fullscreen`, `get-devtools-state`, `get-fullscreen-state`
- `ml:list`, `ml:import`, `ml:sync-cookies`, `ml:close`, `ml:relaunch`, `ml:test-connection`
- `fs:list-folder`, `fs:pick-directory`, `fs:set-root`, `fs:get-root`
- `fs:archive-folder`, `fs:archive-multiple`
- `fs:start-drag-sync` (synchronous IPC)
- `fs:get-folder-size`, `fs:insert-text-to-view`, `fs:read-file`, `fs:insert-to-view`
- `fs:delete-paths`, `fs:reveal-in-folder`, `fs:open-path`, `fs:copy-path`
- `get-settings`, `save-settings`, `reset-settings`
- `paste-plain-text`, `paste-at-coords`
- `run-diagnostics`
- `vscode:set-panel-state`, `vscode:get-panel-state`, `vscode:load-url`, `vscode:get-url`
- `vscode:set-zoom`, `vscode:get-zoom`
- `browser:zoom-in`, `browser:zoom-out`, `browser:zoom-reset`

**VS Code автозапуск (в ready-to-show):**
```js
codeServerProcess = spawn('wsl', ['code-server', '--port', '8080', '--auth', 'none', '--disable-telemetry'])
// Затем tryLoad() — каждые 1с проверяет http://127.0.0.1:8080, до 30 попыток
// При успехе: vscodeView.webContents.loadURL('http://localhost:8080')
// При закрытии: codeServerProcess.kill()
```

---

### preload.js (114 строк)

Единственная точка входа renderer → main через `contextBridge`.

**Экспортирует `window.api`:**
```js
// Профили
createProfile, switchProfile, removeProfile, stopProfile, listProfiles

// Вкладки
newTab, switchTab, closeTab, reorderTabs

// Навигация
navigate, navBack, navForward, navRefresh

// Окно
minimize, maximize, close, overlayVisible

// Настройки
getSettings, saveSettings, resetSettings

// MoreLogin API
mlList, mlImport, mlSyncCookies, mlClose, mlRelaunch, mlList, testMLConnection

// DevTools / Fullscreen
toggleDevTools, toggleFullScreen, exitFullScreen, getDevToolsState, getFullScreenState

// Файловая система
// (вызываются из renderer через window.api.*)

// VS Code панель
vscodeSetPanelState(visible, width)
vscodeGetPanelState()
vscodeLoadUrl(url)
vscodeGetUrl()
vscodeSetZoom(factor)
vscodeGetZoom()

// Zoom браузера
zoomIn, zoomOut, zoomReset

// События (подписки)
onTabUpdated, onTabOpened, onProfileUpdated, onProfileLaunched, onCookiesSynced, onMLListUpdated
onShortcutCloseTab, onShortcutNextTab, onShortcutPrevTab, onShortcutFocusAddress, onShortcutNewTab

// Прочее
pastePlainText, pasteAtCoords, diagnostics
```

---

### renderer.js (~1000 строк)

Весь UI-код. Запускается в BrowserWindow (renderer process).

**Структура:**
```js
// Состояние
state = { profiles: [], activeProfileId, activeTabId }
let vscodePanelVisible = true
let vscodePanelWidth = 500
let vscodeZoom = 1.0
let mouseOverVscode = false  // для определения зоны Ctrl+/-

// Ключевые функции
renderProfiles()       // перерисовывает вкладки профилей в titlebar
renderTabs()           // перерисовывает вкладки браузера в tabbar
updateAddressBar()     // синхронизирует адресную строку
autoLoadMLProfiles()   // загружает профили из MoreLogin при старте

// VS Code панель
applyVscodePanelLayout()  // обновляет CSS панели + вызывает IPC vscode:set-panel-state
initVscodePanel()          // инициализирует все элементы VS Code панели

// Сплиттер (splitter)
// drag с throttle 16мс → sendSplitterIpc() → vscodeSetPanelState()
// mouseup → applyVscodePanelLayout()

// Zoom логика
// mousemove → mouseOverVscode = e.clientX >= (window.innerWidth - vscodePanelWidth)
// Ctrl+/-/0:
//   mouseOverVscode → vscodeSetZoom()
//   иначе         → window.api.zoomIn/Out/Reset()

// Инициализация
init()          // загружает профили, биндит кнопки
initVscodePanel()
```

---

### index.html (~1240 строк)

Весь HTML и CSS в одном файле.

**DOM-структура:**
```html
#titlebar
  #titlebar-left          ← профили (динамически)
  #titlebar-right
    #btn-toggle-vscode    ← кнопка ⌨ (VS Code панель)
    #btn-settings         ← ⚙
    #window-controls      ← − □ ×

#toolbar
  #btn-back, #btn-forward, #btn-refresh
  #address-bar
  #active-profile-name
  #btn-devtools

#tabbar
  #tab-strip              ← вкладки (динамически)
  #new-tab-btn

#overlay                  ← настройки (поверх всего)

#vscode-splitter          ← полоска 5px, fixed, z-index:11
#vscode-panel             ← правая панель VS Code
  #vscode-panel-header
    #vscode-zoom-info, #vscode-zoom-out, #vscode-zoom-reset, #vscode-zoom-in
    #vscode-hide
  #vscode-url-bar
    #vscode-url-input
    #vscode-go
  #vscode-body            ← здесь vscodeView рендерится поверх (WebContentsView)

#empty-state              ← заглушка когда нет профилей
#splash                   ← загрузочный экран
#ml-modal                 ← модал импорта профилей из MoreLogin
#diag-modal               ← модал диагностики
#status-bar               ← нижняя строка статуса
```

**Ключевые CSS-переменные:**
```css
#vscode-panel {
  position: fixed;
  top: 96px;   /* CHROME_HEIGHT */
  right: 0;
  width: 500px;
  bottom: 0;
  z-index: 10;
}
#vscode-splitter {
  position: fixed;
  width: 5px;
  cursor: col-resize;
  top: 96px;
  bottom: 0;
  z-index: 11;
}
```

---

### src/services/profileService.js

Абстракция над MoreLogin API.

**Методы:**
- `getProfiles()` — получить список профилей (Local или Cloud API)
- `getProfileDetail(envId)` — детали профиля (прокси и др.)
- `getCachedProfiles()` — кэш без запроса
- `updateSettings(settings)` — обновить настройки подключения
- `runDiagnostics()` — проверка соединения с MoreLogin

**API-режимы (`apiMode`):**
- `auto` — сначала Local API, при ошибке — Cloud API
- `local` — только Local API (`http://127.0.0.1:40000`)
- `cloud` — только Cloud API (`https://api.morelogin.com`) с подписью MD5

---

## VS Code панель — детали реализации

### Как работает

1. При старте `createWindow()` → `ready-to-show`:
   - `spawn('wsl', ['code-server', '--port', '8080', '--auth', 'none'])`
   - Создаётся `vscodeView = new WebContentsView({ sandbox: false })`
   - `mainWindow.contentView.addChildView(vscodeView)`
   - `tryLoad(30)` — пингует `http://127.0.0.1:8080` каждую секунду
   - При успехе: `vscodeView.webContents.loadURL('http://localhost:8080')`

2. Размер `vscodeView` управляется через `updateVscodeViewBounds()`:
   - Если `vscodePanelVisible = false` → `setBounds({x:0, y:0, width:1, height:1})` (скрыт)
   - Если видим → `setBounds(getVscodePanelBounds())`

3. Сплиттер (полоска между браузером и VS Code):
   - `mousedown` → начало drag
   - `mousemove` → меняет CSS + каждые 16мс шлёт IPC `vscode:set-panel-state`
   - `mouseup` → финальный вызов `applyVscodePanelLayout()`
   - Main process при получении IPC → `updateActiveViewBounds()` + `updateVscodeViewBounds()`

4. Zoom:
   - Определяется по `mouseOverVscode` (позиция курсора)
   - VS Code: `vscodeView.webContents.setZoomFactor(factor)`
   - Браузер: `activeView.webContents.setZoomFactor(factor)`

### Горячие клавиши VS Code панели

| Клавиша | Действие |
|---------|---------|
| `Ctrl+K` | Показать / скрыть VS Code панель |
| `Ctrl+=` / `Ctrl++` | Увеличить масштаб (того окна где курсор) |
| `Ctrl+-` | Уменьшить масштаб |
| `Ctrl+0` | Сбросить масштаб |

---

## Установка и запуск

### Требования

- Node.js 18+ 
- WSL (Windows Subsystem for Linux) с Ubuntu
- code-server внутри WSL:
  ```bash
  wsl
  curl -fsSL https://code-server.dev/install.sh | sh
  ```

### Запуск

```bash
npm install
npm start
```

code-server запускается автоматически через WSL при старте приложения.  
VS Code появляется в правой панели через ~5-10 секунд (первый старт WSL).

### Сборка

```bash
npm run build-win    # → dist/*.exe
npm run build-mac    # → dist/*.dmg
npm run build-linux  # → dist/*.AppImage
```

---

## Состояние файлов (userData)

| Файл | Содержимое |
|------|-----------|
| `app-state.json` | Профили, вкладки, активный профиль |
| `app-settings.json` | Настройки (хост, порт, exclusions и др.) |
| `window-state.json` | Размер и позиция окна, maximized |

`userData` путь:
- Windows: `%APPDATA%\morelogin-browser-manager`
- macOS: `~/Library/Application Support/morelogin-browser-manager`
- Linux: `~/.config/morelogin-browser-manager`

---

## Горячие клавиши (полный список)

| Клавиша | Действие |
|---------|---------|
| `Ctrl+T` | Новая вкладка браузера |
| `Ctrl+W` | Закрыть вкладку браузера |
| `Ctrl+Tab` | Следующая вкладка |
| `Ctrl+Shift+Tab` | Предыдущая вкладка |
| `Ctrl+E` | Фокус на адресную строку |
| `Ctrl+B` | Показать/скрыть файловую панель |
| `Ctrl+K` | Показать/скрыть VS Code панель |
| `Ctrl+=` | Увеличить масштаб активного окна |
| `Ctrl+-` | Уменьшить масштаб активного окна |
| `Ctrl+0` | Сбросить масштаб |
| `F5` | Обновить вкладку |
| `F11` | Полный экран |
| `F12` / `Ctrl+Shift+I` | DevTools |
| `Esc` | Закрыть настройки / модал / полный экран |

---

## Что можно улучшить / известные проблемы

### Производительность
- `tryLoad()` в `ready-to-show` — простой polling. Можно заменить на `child_process` stdout-парсинг (ждать строку `"HTTP server listening"`)
- Во время drag сплиттера IPC идёт каждые 16мс — можно увеличить до 32мс если есть подтормаживания

### VS Code панель
- URL `http://localhost:8080` захардкожен. Можно вынести в `app-settings.json` и дать пользователю менять порт в настройках
- Нет индикатора загрузки пока code-server стартует (панель просто пустая ~10 сек)
- При закрытии приложения `codeServerProcess.kill()` убивает WSL-процесс, но сам WSL остаётся. Можно добавить `wsl --terminate` если нужно

### Сессии и безопасность
- `sandbox: false` у `vscodeView` — нужно для localhost, но снижает изоляцию. Можно попробовать `sandbox: true` с нужными permissions
- IndexedDB не синхронизируется между MoreLogin Chrome и Electron-сессией

### Файловая панель
- Нет поиска по файлам
- Нет превью файлов

### Общее
- Нет авто-обновления приложения
- `repair.js` и `extract.js` в корне — непонятное назначение, стоит задокументировать или удалить

---

## Переменные окружения (.env)

```ini
MORELOGIN_LOCAL_HOST=127.0.0.1
MORELOGIN_LOCAL_PORT=40000
MORELOGIN_PAGE_SIZE=50
MORELOGIN_AUTO_LOAD=true
MORELOGIN_HEADLESS_START=true
MORELOGIN_DEBUG=false

API_MODE=auto              # auto | local | cloud
MORELOGIN_API_ID=          # для Cloud API
MORELOGIN_API_KEY=         # для Cloud API
MORELOGIN_OPEN_API_URL=https://api.morelogin.com
```

---

## Зависимости

```json
{
  "dependencies": {
    "archiver": "^7.0.1",   // создание ZIP архивов
    "dotenv": "^16.4.5",    // .env поддержка
    "ws": "^8.21.0"         // WebSocket для CDP
  },
  "devDependencies": {
    "electron": "^42.0.0",
    "electron-builder": "^26.15.3"
  }
}
```