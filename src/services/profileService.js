const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const CACHE_FILE = path.join(__dirname, '..', '..', 'cache', 'profiles.json')
const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'profile-service.log')

function logEvent(event, details = '') {
  const timestamp = new Date().toISOString()
  const message = `[${timestamp}] ${event} ${details}\n`
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    }
    fs.appendFileSync(LOG_FILE, message)
  } catch (e) {
    console.error('Failed to write to log file:', e.message)
  }
}

class ProfileService {
  constructor(settings) {
    this.settings = settings || {}
    this.apiMode = process.env.API_MODE || this.settings.apiMode || 'auto'
    this.apiId = process.env.MORELOGIN_API_ID || this.settings.apiId || ''
    this.apiKey = process.env.MORELOGIN_API_KEY || this.settings.apiKey || ''
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings }
    this.apiMode = process.env.API_MODE || this.settings.apiMode || 'auto'
    this.apiId = process.env.MORELOGIN_API_ID || this.settings.apiId || ''
    this.apiKey = process.env.MORELOGIN_API_KEY || this.settings.apiKey || ''
  }

  // ---------------------------------------------------------------------
  // MoreLogin требует на каждый запрос заголовки:
  //   X-Api-Id      — API ID
  //   X-Nonce-Id    — уникальная строка {timestamp}:{random}
  //   Authorization — MD5(apiId + nonceId + apiKey)
  // См. https://support.morelogin.com/en/articles/10204736-header-public-parameters
  // ---------------------------------------------------------------------
  _buildAuthHeaders() {
    if (!this.apiId || !this.apiKey) return {}
    const nonceId = `${Date.now()}:${crypto.randomBytes(8).toString('hex')}`
    const signature = crypto
      .createHash('md5')
      .update(`${this.apiId}${nonceId}${this.apiKey}`)
      .digest('hex')

    return {
      'X-Api-Id': this.apiId,
      'X-Nonce-Id': nonceId,
      'Authorization': signature
    }
  }

  async getLocalProfiles(retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        const data = await this._makeLocalRequest('POST', '/api/env/page', {
          page: 1,
          pageSize: this.settings.pageSize || 50
        })
        const list = (data && (data.dataList || data.list || data.envList || data.profiles)) || []
        if (!Array.isArray(list)) {
          logEvent('Local API parse warning', `Unexpected data shape: ${JSON.stringify(data).slice(0, 300)}`)
          return []
        }

        const profiles = list.map((p) => ({
          envId: String(p.envId !== undefined ? p.envId : (p.id !== undefined ? p.id : '')),
          name: p.name || p.envName || p.nickName || `Profile ${p.envId || p.id || ''}`,
          groupName: p.groupName || p.groupId || p.group || '',
          remark: p.remark || '',
          _source: 'local'
        })).filter((p) => p.envId)

        logEvent('Local API success', `Fetched ${profiles.length} profiles`)
        return profiles
      } catch (e) {
        const isTimeout = e.message.includes('timeout')
        logEvent(`Local API ${isTimeout ? 'timeout' : 'error'}`, `Attempt ${attempt}/${retryCount} - ${e.message}`)
        if (attempt === retryCount) throw e
        await new Promise(r => setTimeout(r, 1000 * attempt))
      }
    }
  }

  async getCloudProfiles(retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        const data = await this._makeCloudRequest('POST', '/api/env/page', {
          pageNo: 1,
          pageSize: this.settings.pageSize || 50
        })
        const list = (data && (data.dataList || data.list || data.data || data.envList || data.profiles)) || []
        if (!Array.isArray(list)) {
          logEvent('Cloud API parse warning', `Unexpected data shape: ${JSON.stringify(data).slice(0, 300)}`)
          return []
        }

        const profiles = list.map((p) => ({
          envId: String(p.envId !== undefined ? p.envId : (p.id !== undefined ? p.id : '')),
          name: p.name || p.envName || p.nickName || `Profile ${p.envId || p.id || ''}`,
          groupName: p.groupName || p.groupId || p.group || '',
          remark: p.remark || '',
          _source: 'cloud'
        })).filter((p) => p.envId)

        logEvent('Cloud API success', `Fetched ${profiles.length} profiles`)
        return profiles
      } catch (e) {
        logEvent('Cloud API error', `Attempt ${attempt}/${retryCount} - ${e.message}`)
        if (attempt === retryCount) throw e
        await new Promise(r => setTimeout(r, 1000 * attempt))
      }
    }
  }

  async getProfiles() {
    let profiles = []
    let localError = null

    // Attempt local API if mode is AUTO or LOCAL
    if (this.apiMode === 'auto' || this.apiMode === 'local') {
      try {
        profiles = await this.getLocalProfiles(3)
        if (profiles.length > 0) {
          this._saveCache(profiles)
          return profiles
        } else {
          logEvent('Fallback activated', 'Local API returned empty list')
        }
      } catch (e) {
        localError = e
        logEvent('Fallback activated', `Local API failed: ${e.message}`)
      }
    }

    // Fallback to Cloud API if mode is AUTO or CLOUD
    if (this.apiMode === 'auto' || this.apiMode === 'cloud') {
      try {
        const cloudProfiles = await this.getCloudProfiles(3)
        profiles = this.mergeProfiles(profiles, cloudProfiles)
        this._saveCache(profiles)
        return profiles
      } catch (e) {
        if (this.apiMode === 'cloud') throw e
        // If both failed in AUTO, throw local error or cloud error depending on what happened
        if (profiles.length === 0 && !localError) throw e
      }
    }

    if (profiles.length === 0 && localError) {
      throw localError
    }

    return profiles
  }

  mergeProfiles(localProfiles, cloudProfiles) {
    const map = new Map()

    // Helper to add profile
    const addProfile = (p) => {
      const key = p.envId || p.id || p.profileId
      if (!key) return
      if (map.has(key)) {
        const existing = map.get(key)
        // Keep local launch data, add missing cloud fields
        if (existing._source === 'local' && p._source === 'cloud') {
          map.set(key, { ...p, ...existing })
        } else {
          map.set(key, { ...existing, ...p })
        }
      } else {
        map.set(key, p)
      }
    }

    localProfiles.forEach(addProfile)
    cloudProfiles.forEach(addProfile)

    return Array.from(map.values())
  }

  getCachedProfiles() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data = fs.readFileSync(CACHE_FILE, 'utf-8')
        return JSON.parse(data)
      }
    } catch (e) {
      logEvent('Cache read error', e.message)
    }
    return []
  }

  _saveCache(profiles) {
    try {
      if (!fs.existsSync(path.dirname(CACHE_FILE))) {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(profiles, null, 2))
    } catch (e) {
      logEvent('Cache write error', e.message)
    }
  }

  _makeLocalRequest(method, reqPath, body) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : null
      const req = http.request({
        hostname: this.settings.mlHost || '127.0.0.1',
        port: this.settings.mlPort || 40000,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...this._buildAuthHeaders(),
          'Content-Length': data ? Buffer.byteLength(data) : 0
        },
        timeout: 5000 // 5 seconds for local API
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
      req.on('timeout', () => { req.destroy(); reject(new Error('MoreLogin local timeout')) })
      if (data) req.write(data)
      req.end()
    })
  }

  _makeCloudRequest(method, reqPath, body) {
    return new Promise((resolve, reject) => {
      if (!this.apiId || !this.apiKey) {
        return reject(new Error('Cloud API ID or KEY is not configured.'))
      }
      const data = body !== undefined ? JSON.stringify(body) : null

      // Подпись по алгоритму MoreLogin: Authorization = MD5(apiId + nonceId + apiKey)
      const headers = {
        'Content-Type': 'application/json',
        ...this._buildAuthHeaders(),
        'Content-Length': data ? Buffer.byteLength(data) : 0
      }

      const reqUrl = (process.env.MORELOGIN_OPEN_API_URL || 'https://api.morelogin.com') + reqPath
      const parsedUrl = new URL(reqUrl)

      const req = https.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout: 10000 // 10 seconds for cloud API
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          let json = null
          try { json = text ? JSON.parse(text) : {} } catch (e) {
            return reject(new Error(`MoreLogin Cloud API invalid JSON (${res.statusCode})`))
          }
          if (json && (json.code === 0 || json.code === 200 || json.code === '0' || json.code === '200')) {
            resolve(json.data !== undefined ? json.data : json)
          } else {
            reject(new Error((json && (json.msg || json.message)) || `MoreLogin Cloud API error ${res.statusCode}`))
          }
        })
      })
      req.on('error', (e) => reject(new Error(`MoreLogin Cloud API connection failed: ${e.message}`)))
      req.on('timeout', () => { req.destroy(); reject(new Error('MoreLogin cloud timeout')) })
      if (data) req.write(data)
      req.end()
    })
  }

  async runDiagnostics() {
    logEvent('DIAGNOSTICS', 'Starting diagnostic chain...')
    const result = {
      profileService: true,
      moreloginConnection: false,
      moreloginResponse: null,
      profilesFound: 0
    }
    try {
      const reqMode = this.apiMode === 'cloud' ? '_makeCloudRequest' : '_makeLocalRequest'
      logEvent('DIAGNOSTICS', `Using request mode: ${reqMode}`)

      const data = await this[reqMode]('POST', '/api/env/page', {
        page: 1,
        pageNo: 1,
        pageSize: 50
      })
      result.moreloginConnection = true
      result.moreloginResponse = data
      const list = (data && (data.dataList || data.list || data.envList || data.profiles || data.data)) || []
      result.profilesFound = Array.isArray(list) ? list.length : 0
      logEvent('DIAGNOSTICS', `Success. Found ${result.profilesFound} profiles.`)
    } catch (e) {
      logEvent('DIAGNOSTICS', `Failed: ${e.message}`)
      result.moreloginResponse = { error: e.message }
    }
    return result
  }
}

module.exports = ProfileService