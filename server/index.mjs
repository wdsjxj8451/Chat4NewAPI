import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'
import {
  GatewayRequestError,
  gatewayProtocols,
  readEventStream,
  toChatCompletionsRequest,
  toResponsesRequest,
} from './gatewayAdapters.mjs'

const scrypt = promisify(scryptCallback)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(root, 'data'))
const filesDir = path.join(dataDir, 'files')
await mkdir(dataDir, { recursive: true })
const encryptionKey = Buffer.from(process.env.APP_ENCRYPTION_KEY || '', 'hex')

if (!/^[\da-fA-F]{64}$/.test(process.env.APP_ENCRYPTION_KEY || '') || encryptionKey.length !== 32) {
  throw new Error('APP_ENCRYPTION_KEY must be 64 hexadecimal characters')
}

const db = new Database(path.join(dataDir, 'chat.sqlite'))
const app = express()
const sessionLifetime = 1000 * 60 * 60 * 24 * 14
const maxFileBytes = 64 * 1024 * 1024
const maxSessionBytes = 24 * 1024 * 1024
await mkdir(filesDir, { recursive: true })
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_sessions_owner_updated ON chat_sessions(user_id, updated_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS one_chat_admin ON users(is_admin) WHERE is_admin = 1;
  CREATE TABLE IF NOT EXISTS files (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    disk_name TEXT NOT NULL,
    PRIMARY KEY (id, user_id)
  );
  CREATE TABLE IF NOT EXISTS session_files (
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (session_id, file_id),
    FOREIGN KEY (file_id, user_id) REFERENCES files(id, user_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider_name TEXT NOT NULL DEFAULT 'Model gateway',
    api_protocol TEXT NOT NULL DEFAULT 'anthropic-messages',
    new_api_url TEXT NOT NULL,
    new_api_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS app_appearance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    site_name TEXT NOT NULL DEFAULT '',
    accent TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    show_icon INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS model_capabilities (
    model TEXT PRIMARY KEY,
    capabilities TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`)

const configColumns = new Set(
  db
    .prepare('PRAGMA table_info(app_config)')
    .all()
    .map((column) => column.name)
)
if (!configColumns.has('provider_name')) {
  db.exec("ALTER TABLE app_config ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'New API'")
}
if (!configColumns.has('api_protocol')) {
  db.exec(
    "ALTER TABLE app_config ADD COLUMN api_protocol TEXT NOT NULL DEFAULT 'anthropic-messages'"
  )
}

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(express.json({ limit: '100mb' }))
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()')
  next()
})

const now = () => Date.now()
const randomId = () => randomBytes(18).toString('base64url')
const hashToken = (token) => createHash('sha256').update(token).digest('hex')
const isFirstRun = () => db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0
const safeUser = (user) => ({
  id: user.id,
  username: user.username,
  isAdmin: Boolean(user.is_admin),
})
const getUserFromRequest = (req) => {
  const token = readCookie(req.headers.cookie, 'chat_session')
  if (!token) return null
  const row = db
    .prepare(`
    SELECT users.* FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ? AND users.disabled = 0
  `)
    .get(hashToken(token), now())
  return row || null
}
const requireAuth = (req, res, next) => {
  const user = getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  req.user = user
  next()
}
const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Administrator access required' })
  next()
}
const readCookie = (header = '', name) => {
  const item = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return item ? decodeURIComponent(item.slice(name.length + 1)) : ''
}
const setSessionCookie = (res, token) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader(
    'Set-Cookie',
    `chat_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetime / 1000}${secure}`
  )
}

async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${Buffer.from(derived).toString('hex')}`
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function encrypt(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.')
}

function decrypt(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function currentConfig() {
  const row = db.prepare('SELECT * FROM app_config WHERE id = 1').get()
  if (!row) return null
  return {
    providerName: row.provider_name || 'Model gateway',
    protocol: gatewayProtocols.includes(row.api_protocol) ? row.api_protocol : 'anthropic-messages',
    baseUrl: row.new_api_url,
    apiKey: decrypt(row.new_api_key),
  }
}

function publicConfig() {
  const config = db
    .prepare('SELECT provider_name, api_protocol, new_api_url FROM app_config WHERE id = 1')
    .get()
  return {
    configured: Boolean(config),
    providerName: config?.provider_name || '',
    protocol: gatewayProtocols.includes(config?.api_protocol)
      ? config.api_protocol
      : 'anthropic-messages',
    baseUrl: config?.new_api_url || '',
  }
}

function validateBaseUrl(value) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use an HTTP(S) API base URL without credentials or query parameters')
  }
  return url.toString().replace(/\/$/, '').replace(/\/v1$/i, '')
}

const defaultSystemPrompt = '你是一个有帮助、准确且清晰的 AI 助手。'
const readSystemPrompt = () =>
  db.prepare('SELECT system_prompt FROM app_settings WHERE id = 1').get()?.system_prompt ||
  defaultSystemPrompt

function cleanModelId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n]/.test(value)
  )
}

app.get('/api/health', (_req, res) => res.json({ ok: true }))
const defaultAppearance = { name: '', accent: '', icon: '', showIcon: true }
const readAppearance = () => {
  const row = db
    .prepare('SELECT site_name, accent, icon, show_icon FROM app_appearance WHERE id = 1')
    .get()
  return row
    ? { name: row.site_name, accent: row.accent, icon: row.icon, showIcon: Boolean(row.show_icon) }
    : defaultAppearance
}

app.get('/api/appearance', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(readAppearance())
})

app.get('/api/setup/status', (_req, res) =>
  res.json({ required: isFirstRun(), tokenRequired: Boolean(process.env.SETUP_TOKEN) })
)
app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req)
  res.json({
    user: user ? safeUser(user) : null,
    setupRequired: isFirstRun(),
    setupTokenRequired: Boolean(process.env.SETUP_TOKEN),
  })
})

app.post('/api/setup/admin', async (req, res) => {
  if (!isFirstRun()) return res.status(409).json({ error: 'Setup is already complete' })
  const { username, password, setupToken } = req.body || {}
  if (process.env.SETUP_TOKEN) {
    const expected = Buffer.from(process.env.SETUP_TOKEN)
    const provided = Buffer.from(typeof setupToken === 'string' ? setupToken : '')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(403).json({ error: 'Invalid initial setup token' })
    }
  }
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return res
      .status(400)
      .json({ error: 'Username must be 3-32 letters, numbers, dots, dashes, or underscores' })
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be at least 12 characters' })
  }
  const id = randomId()
  const passwordHash = await hashPassword(password)
  try {
    db.prepare(
      'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(id, username, passwordHash, now())
  } catch {
    return res.status(409).json({ error: 'Setup was completed by another request' })
  }
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    id,
    now() + sessionLifetime
  )
  setSessionCookie(res, token)
  return res.status(201).json({ user: { id, username, isAdmin: true } })
})

const loginAttempts = new Map()
setInterval(() => {
  const cutoff = now() - 15 * 60 * 1000
  for (const [ip, attempt] of loginAttempts)
    if (attempt.startedAt < cutoff) loginAttempts.delete(ip)
}, 60 * 1000).unref()

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || 'unknown'
  const attempt = loginAttempts.get(ip)
  if (attempt && attempt.startedAt > now() - 15 * 60 * 1000 && attempt.count >= 10) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' })
  }
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(username)
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    const current = loginAttempts.get(ip)
    loginAttempts.set(
      ip,
      current && current.startedAt > now() - 15 * 60 * 1000
        ? { ...current, count: current.count + 1 }
        : { startedAt: now(), count: 1 }
    )
    return res.status(401).json({ error: 'Invalid username or password' })
  }
  loginAttempts.delete(ip)
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    user.id,
    now() + sessionLifetime
  )
  setSessionCookie(res, token)
  return res.json({ user: safeUser(user) })
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = readCookie(req.headers.cookie, 'chat_session')
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(token))
  res.setHeader(
    'Set-Cookie',
    'chat_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' +
      (process.env.NODE_ENV === 'production' ? '; Secure' : '')
  )
  res.status(204).end()
})

app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = db
    .prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC
  `)
    .all(req.user.id)
  res.json({ sessions })
})

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  const row = db
    .prepare('SELECT payload FROM chat_sessions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!row) return res.status(404).json({ error: 'Session not found' })
  res.type('application/json').send(row.payload)
})

function saveSession(userId, session) {
  if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages)) {
    throw new Error('Invalid session payload')
  }
  const payload = JSON.stringify(session)
  if (Buffer.byteLength(payload) > maxSessionBytes)
    throw new Error('Session exceeds the 24 MiB limit')
  const timestamp = now()
  const write = db.transaction(() => {
    db.prepare(`INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, payload=excluded.payload
      WHERE chat_sessions.user_id=excluded.user_id`).run(
      session.id,
      userId,
      typeof session.title === 'string' ? session.title.slice(0, 500) : '',
      Number(session.createdAt) || timestamp,
      Number(session.updatedAt) || timestamp,
      payload
    )
    db.prepare('DELETE FROM session_files WHERE session_id = ? AND user_id = ?').run(
      session.id,
      userId
    )
    const fileIds = new Set(
      session.messages
        .flatMap((message) =>
          message?.role === 'user' && Array.isArray(message.files)
            ? message.files.map((file) => file.id)
            : []
        )
        .filter((id) => typeof id === 'string')
    )
    const addFile = db.prepare(
      'INSERT OR IGNORE INTO session_files (session_id, file_id, user_id) VALUES (?, ?, ?)'
    )
    const hasFile = db.prepare('SELECT 1 FROM files WHERE id = ? AND user_id = ?')
    for (const fileId of fileIds) {
      if (hasFile.get(fileId, userId)) addFile.run(session.id, fileId, userId)
    }
  })
  write()
}

app.put('/api/sessions/:id', requireAuth, (req, res, next) => {
  if (req.params.id === 'replace') return next()
  try {
    if (req.body?.id !== req.params.id)
      return res.status(400).json({ error: 'Session ID mismatch' })
    saveSession(req.user.id, req.body)
    return res.status(204).end()
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
})

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const remove = db.transaction(() => {
    const owned = db
      .prepare('SELECT 1 FROM chat_sessions WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id)
    if (!owned) return false
    const files = db
      .prepare('SELECT file_id FROM session_files WHERE session_id = ? AND user_id = ?')
      .all(req.params.id, req.user.id)
    db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?').run(
      req.params.id,
      req.user.id
    )
    const removed = []
    const removeFile = db.prepare(
      'DELETE FROM files WHERE id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM session_files WHERE file_id = ? AND user_id = ?)'
    )
    for (const file of files) {
      const result = removeFile.run(file.file_id, req.user.id, file.file_id, req.user.id)
      if (result.changes) removed.push(file.file_id)
    }
    return removed
  })
  const removed = remove()
  if (removed === false) return res.status(404).json({ error: 'Session not found' })
  void Promise.all(
    removed.map((id) => unlink(path.join(filesDir, req.user.id, id)).catch(() => {}))
  )
  return res.status(204).end()
})

app.delete('/api/sessions', requireAuth, (req, res) => {
  const userDir = path.join(filesDir, req.user.id)
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(req.user.id)
    db.prepare('DELETE FROM files WHERE user_id = ?').run(req.user.id)
  })
  remove()
  void import('node:fs/promises').then(({ rm }) => rm(userDir, { recursive: true, force: true }))
  res.status(204).end()
})

app.put('/api/sessions/replace', requireAuth, (req, res) => {
  if (!Array.isArray(req.body?.sessions) || req.body.sessions.length > 5000) {
    return res.status(400).json({ error: 'Invalid session archive' })
  }
  try {
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(req.user.id)
      const fileIds = new Set(
        req.body.sessions
          .flatMap((session) =>
            session.messages.flatMap((message) =>
              message?.role === 'user' && Array.isArray(message.files)
                ? message.files.map((file) => file.id)
                : []
            )
          )
          .filter((id) => typeof id === 'string')
      )
      const removeFile = db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?')
      const staleFiles = []
      for (const row of db.prepare('SELECT id FROM files WHERE user_id = ?').all(req.user.id)) {
        if (!fileIds.has(row.id)) {
          removeFile.run(row.id, req.user.id)
          staleFiles.push(row.id)
        }
      }
      for (const session of req.body.sessions) saveSession(req.user.id, session)
      return staleFiles
    })
    const staleFiles = replace()
    void Promise.all(
      staleFiles.map((id) =>
        unlink(
          path.join(filesDir, req.user.id, `${createHash('sha256').update(id).digest('hex')}.blob`)
        ).catch(() => {})
      )
    )
    return res.json({
      sessions: req.body.sessions.map(({ id, title, createdAt, updatedAt }) => ({
        id,
        title,
        createdAt,
        updatedAt,
      })),
    })
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
})

app.put(
  '/api/files/:id',
  requireAuth,
  express.raw({ type: '*/*', limit: maxFileBytes }),
  async (req, res) => {
    const id = req.params.id
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Invalid file' })
    }
    const userDir = path.join(filesDir, req.user.id)
    const diskName = `${createHash('sha256').update(id).digest('hex')}.blob`
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, diskName), req.body, { mode: 0o600 })
    db.prepare(`INSERT INTO files (id, user_id, filename, mime_type, size, disk_name) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, user_id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, size=excluded.size, disk_name=excluded.disk_name`).run(
      id,
      req.user.id,
      decodeURIComponent(req.get('x-file-name') || 'attachment'),
      req.get('x-file-type') || 'application/octet-stream',
      req.body.length,
      diskName
    )
    return res.status(204).end()
  }
)

app.get('/api/files/:id', requireAuth, async (req, res) => {
  const file = db
    .prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id)
  if (!file) return res.status(404).json({ error: 'File not found' })
  res.type(file.mime_type)
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`
  )
  return res.send(await readFile(path.join(filesDir, req.user.id, file.disk_name)))
})

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const remove = db.transaction(() => {
    const result = db
      .prepare(`DELETE FROM files WHERE id = ? AND user_id = ?
      AND NOT EXISTS (SELECT 1 FROM session_files WHERE file_id = ? AND user_id = ?)`)
      .run(req.params.id, req.user.id, req.params.id, req.user.id)
    return result.changes > 0
  })
  if (remove())
    await unlink(
      path.join(
        filesDir,
        req.user.id,
        `${createHash('sha256').update(req.params.id).digest('hex')}.blob`
      )
    ).catch(() => {})
  res.status(204).end()
})

app.get('/api/admin/config', requireAuth, requireAdmin, (_req, res) => {
  const config = publicConfig()
  res.json({
    ...config,
    baseUrl: config.baseUrl || process.env.DEFAULT_MODEL_API_URL || '',
    apiKeyConfigured: config.configured,
  })
})

app.put('/api/admin/appearance', requireAuth, requireAdmin, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null
  const accent = req.body?.accent
  const icon = req.body?.icon
  const showIcon = req.body?.showIcon
  const validIcon =
    typeof icon === 'string' &&
    icon.length <= 262144 &&
    (!icon ||
      /^data:image\/(?:png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/]+=*$/i.test(
        icon
      ))

  if (
    name === null ||
    name.length > 48 ||
    typeof accent !== 'string' ||
    (accent !== '' && !/^#[\da-f]{6}$/i.test(accent)) ||
    !validIcon ||
    typeof showIcon !== 'boolean'
  ) {
    return res.status(400).json({ error: 'Invalid site appearance settings' })
  }

  db.prepare(`INSERT INTO app_appearance (id, site_name, accent, icon, show_icon) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET site_name=excluded.site_name, accent=excluded.accent,
    icon=excluded.icon, show_icon=excluded.show_icon`).run(name, accent, icon, showIcon ? 1 : 0)
  return res.json(readAppearance())
})

app.put('/api/admin/config', requireAuth, requireAdmin, (req, res) => {
  try {
    const existing = currentConfig()
    const providerName =
      typeof req.body?.providerName === 'string' && req.body.providerName.trim()
        ? req.body.providerName.trim()
        : existing?.providerName || 'Model gateway'
    const protocol = req.body?.protocol ?? existing?.protocol ?? 'anthropic-messages'
    if (!providerName || providerName.length > 64) {
      return res.status(400).json({ error: 'Provider name must be 1-64 characters' })
    }
    if (!gatewayProtocols.includes(protocol)) {
      return res.status(400).json({ error: 'Unsupported API protocol' })
    }
    const baseUrl = validateBaseUrl(req.body?.baseUrl)
    const apiKey = req.body?.apiKey
    const nextKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : existing?.apiKey
    if (!nextKey) return res.status(400).json({ error: 'API key is required' })
    db.prepare(`INSERT INTO app_config (id, provider_name, api_protocol, new_api_url, new_api_key)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_name=excluded.provider_name,
      api_protocol=excluded.api_protocol,
      new_api_url=excluded.new_api_url, new_api_key=excluded.new_api_key`).run(
      providerName,
      protocol,
      baseUrl,
      encrypt(nextKey)
    )
    return res.json({ configured: true, providerName, protocol, baseUrl, apiKeyConfigured: true })
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }
})

app.get('/api/admin/settings', requireAuth, requireAdmin, (_req, res) =>
  res.json({ systemPrompt: readSystemPrompt() })
)

app.put('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const systemPrompt = req.body?.systemPrompt
  if (typeof systemPrompt !== 'string' || systemPrompt.length > 20000) {
    return res.status(400).json({ error: 'System prompt must be 0-20000 characters' })
  }
  db.prepare(`INSERT INTO app_settings (id, system_prompt) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET system_prompt=excluded.system_prompt`).run(systemPrompt.trim())
  return res.json({ systemPrompt: readSystemPrompt() })
})

async function upstreamModels() {
  const config = currentConfig()
  if (!config) throw new Error('Configure a model gateway before loading models')
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new Error(
      `${config.providerName} returned ${response.status}: ${(await response.text()).slice(0, 500)}`
    )
  const body = await response.json()
  return Array.isArray(body.data) ? body.data : []
}

app.post('/api/admin/config/test', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json({ ok: true, count: (await upstreamModels()).length })
  } catch (error) {
    return res.status(502).json({ error: error.message })
  }
})

app.get('/api/admin/models', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const models = await upstreamModels()
    const stored = new Map(
      db
        .prepare('SELECT model, capabilities FROM model_capabilities')
        .all()
        .map((row) => [row.model, JSON.parse(row.capabilities)])
    )
    const protocol = currentConfig()?.protocol || 'anthropic-messages'
    return res.json({
      protocol,
      models: models.map((model) => ({
        id: model.id,
        capabilities: effectiveCapabilities(
          stored.get(model.id) || defaultCapabilities(model.id),
          protocol
        ),
      })),
    })
  } catch (error) {
    return res.status(502).json({ error: error.message })
  }
})

app.get('/api/models', requireAuth, async (_req, res) => {
  try {
    const models = await upstreamModels()
    const stored = new Map(
      db
        .prepare('SELECT model, capabilities FROM model_capabilities')
        .all()
        .map((row) => [row.model, JSON.parse(row.capabilities)])
    )
    const protocol = currentConfig()?.protocol || 'anthropic-messages'
    return res.json({
      protocol,
      models: models.map((model) => ({
        id: model.id,
        capabilities: effectiveCapabilities(
          stored.get(model.id) || defaultCapabilities(model.id),
          protocol
        ),
      })),
    })
  } catch (error) {
    return res.status(502).json({ error: error.message })
  }
})

function defaultCapabilities(modelId) {
  void modelId
  return { reasoning: false, search: false, files: false, vision: false, voice: false }
}

function effectiveCapabilities(capabilities, protocol) {
  if (protocol === 'openai-chat-completions') {
    return { ...capabilities, search: false, files: false, vision: false }
  }
  return capabilities
}

app.put('/api/admin/models/:id', requireAuth, requireAdmin, (req, res) => {
  const model = req.params.id
  const capabilities = req.body?.capabilities
  if (!cleanModelId(model) || !capabilities || typeof capabilities !== 'object') {
    return res.status(400).json({ error: 'Invalid model capabilities' })
  }
  const values = Object.fromEntries(
    ['reasoning', 'search', 'files', 'vision', 'voice'].map((key) => [
      key,
      capabilities[key] === true,
    ])
  )
  db.prepare(`INSERT INTO model_capabilities (model, capabilities) VALUES (?, ?)
    ON CONFLICT(model) DO UPDATE SET capabilities=excluded.capabilities`).run(
    model,
    JSON.stringify(values)
  )
  return res.json({ id: model, capabilities: values })
})

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  const users = db
    .prepare(`SELECT users.id, users.username, users.is_admin AS isAdmin, users.disabled,
    users.created_at AS createdAt, COUNT(usage_events.id) AS requests,
    COALESCE(SUM(usage_events.input_tokens), 0) AS inputTokens,
    COALESCE(SUM(usage_events.output_tokens), 0) AS outputTokens
    FROM users LEFT JOIN usage_events ON usage_events.user_id=users.id
    GROUP BY users.id ORDER BY users.created_at`)
    .all()
  res.json({ users })
})

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username))
    return res
      .status(400)
      .json({ error: 'Username must be 3-32 letters, numbers, dots, dashes, or underscores' })
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    return res.status(400).json({ error: 'Password must be at least 12 characters' })
  try {
    const id = randomId()
    db.prepare(
      'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, username, await hashPassword(password), now())
    return res.status(201).json({ id, username, isAdmin: false })
  } catch {
    return res.status(409).json({ error: 'Username is already in use' })
  }
})

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'User not found' })
  if (req.body?.password) {
    const password = req.body.password
    if (typeof password !== 'string' || password.length < 12 || password.length > 128)
      return res.status(400).json({ error: 'Password must be at least 12 characters' })
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      await hashPassword(password),
      existing.id
    )
    return res.status(204).end()
  }
  if (existing.is_admin)
    return res.status(400).json({ error: 'Administrator accounts cannot be disabled here' })
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(
    req.body?.disabled ? 1 : 0,
    existing.id
  )
  if (req.body?.disabled) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id)
  return res.status(204).end()
})

app.get('/api/admin/usage', requireAuth, requireAdmin, (_req, res) => {
  const rows = db
    .prepare(`SELECT users.username, usage_events.model, COUNT(*) AS requests,
    SUM(usage_events.input_tokens) AS inputTokens, SUM(usage_events.output_tokens) AS outputTokens
    FROM usage_events JOIN users ON users.id=usage_events.user_id
    GROUP BY users.id, usage_events.model ORDER BY users.username, usage_events.model`)
    .all()
  res.json({ usage: rows })
})

function parseUsage(data, current) {
  try {
    const event = JSON.parse(data)
    if (event.type === 'message_start' && Number.isFinite(event.message?.usage?.input_tokens))
      current.input += event.message.usage.input_tokens
    if (event.type === 'message_delta' && Number.isFinite(event.usage?.output_tokens))
      current.output = event.usage.output_tokens
  } catch {}
}

const writeMessageEvent = (res, event) => {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

async function forwardOpenAIStream(upstream, protocol, res, model) {
  if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
    const detail = await upstream.text().catch(() => '')
    throw new Error(detail || 'Gateway did not return a streaming response')
  }

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  const usage = { input: 0, output: 0 }
  let messageId = randomId()
  let started = false
  let blockIndex = 0
  let thinkingIndex = null
  let textIndex = null
  let stopReason = 'end_turn'

  const startMessage = (id = messageId, responseModel = model) => {
    if (started) return
    messageId = id || messageId
    started = true
    writeMessageEvent(res, {
      type: 'message_start',
      message: {
        id: messageId,
        model: responseModel || model,
        usage: {
          input_tokens: usage.input,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    })
  }

  const startBlock = (type) => {
    startMessage()
    const index = blockIndex++
    const contentBlock =
      type === 'thinking' ? { type, thinking: '', signature: messageId } : { type, text: '' }
    writeMessageEvent(res, { type: 'content_block_start', index, content_block: contentBlock })
    if (type === 'thinking') thinkingIndex = index
    else textIndex = index
    return index
  }

  const appendDelta = (kind, value) => {
    if (!value) return
    const index =
      kind === 'thinking'
        ? (thinkingIndex ?? startBlock('thinking'))
        : (textIndex ?? startBlock('text'))
    writeMessageEvent(res, {
      type: 'content_block_delta',
      index,
      delta:
        kind === 'thinking'
          ? { type: 'thinking_delta', thinking: value }
          : { type: 'text_delta', text: value },
    })
  }

  for await (const frame of readEventStream(upstream.body)) {
    if (frame.data === '[DONE]') break
    let payload
    try {
      payload = JSON.parse(frame.data)
    } catch {
      continue
    }

    if (
      payload.error ||
      frame.event === 'error' ||
      payload.type === 'error' ||
      payload.type === 'response.failed'
    ) {
      throw new Error(
        payload.error?.message ||
          payload.response?.error?.message ||
          payload.message ||
          'Gateway stream failed'
      )
    }

    if (protocol === 'openai-chat-completions') {
      if (payload.id) startMessage(payload.id, payload.model)
      if (payload.usage) {
        usage.input = payload.usage.prompt_tokens ?? payload.usage.input_tokens ?? usage.input
        usage.output =
          payload.usage.completion_tokens ?? payload.usage.output_tokens ?? usage.output
      }
      const choice = payload.choices?.[0]
      const delta = choice?.delta
      if (typeof delta?.reasoning_content === 'string')
        appendDelta('thinking', delta.reasoning_content)
      if (typeof delta?.reasoning === 'string') appendDelta('thinking', delta.reasoning)
      if (typeof delta?.content === 'string') appendDelta('text', delta.content)
      else if (Array.isArray(delta?.content)) {
        for (const part of delta.content)
          if (typeof part?.text === 'string') appendDelta('text', part.text)
      }
      if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
      if (choice?.finish_reason === 'content_filter') stopReason = 'refusal'
      continue
    }

    const type = payload.type || frame.event
    if (type === 'response.created') {
      startMessage(payload.response?.id, payload.response?.model)
    } else if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      appendDelta('text', payload.delta)
    } else if (
      (type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta') &&
      typeof payload.delta === 'string'
    ) {
      appendDelta('thinking', payload.delta)
    } else if (type === 'response.refusal.delta' && typeof payload.delta === 'string') {
      stopReason = 'refusal'
      appendDelta('text', payload.delta)
    } else if (type === 'response.completed') {
      const response = payload.response || {}
      usage.input = response.usage?.input_tokens ?? usage.input
      usage.output = response.usage?.output_tokens ?? usage.output
      if (response.status === 'incomplete') stopReason = 'max_tokens'
    }
  }

  startMessage()
  if (thinkingIndex !== null)
    writeMessageEvent(res, { type: 'content_block_stop', index: thinkingIndex })
  if (textIndex === null) textIndex = startBlock('text')
  writeMessageEvent(res, { type: 'content_block_stop', index: textIndex })
  writeMessageEvent(res, {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: usage.input,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: usage.output,
    },
  })
  writeMessageEvent(res, { type: 'message_stop' })
  return usage
}

const recordUsage = (userId, model, usage) =>
  db
    .prepare(
      'INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(userId, model, usage.input, usage.output, now())

app.use('/api/upstream', requireAuth, async (req, res) => {
  const config = currentConfig()
  if (!config)
    return res
      .status(503)
      .json({ error: { message: 'The administrator has not configured a model gateway' } })
  const targetPath = req.originalUrl.replace(/^\/api\/upstream/, '').split('?')[0]
  let upstreamPath = targetPath
  const allowed =
    (targetPath === '/v1/models' && req.method === 'GET') ||
    (targetPath === '/anthropic/v1/messages' && req.method === 'POST') ||
    (targetPath === '/anthropic/v1/files' && ['GET', 'POST'].includes(req.method)) ||
    (/^\/anthropic\/v1\/files\/[A-Za-z0-9_-]+$/.test(targetPath) &&
      ['GET', 'DELETE'].includes(req.method)) ||
    (targetPath === '/v1/audio/transcriptions' && req.method === 'POST') ||
    (targetPath === '/v1/audio/speech' && req.method === 'POST')
  if (!allowed)
    return res
      .status(404)
      .json({ error: { message: 'This API route is not available through the chat gateway' } })
  if (targetPath.startsWith('/anthropic/v1/')) {
    if (targetPath === '/anthropic/v1/messages' && config.protocol === 'openai-chat-completions') {
      upstreamPath = '/v1/chat/completions'
    } else if (targetPath === '/anthropic/v1/messages' && config.protocol === 'openai-responses') {
      upstreamPath = '/v1/responses'
    } else {
      upstreamPath = targetPath.replace('/anthropic/v1/', '/v1/')
    }
  }
  const url = new URL(
    `${config.baseUrl.replace(/\/$/, '')}${upstreamPath}${req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''}`
  )
  const headers = new Headers()
  const forwardedHeaders =
    config.protocol === 'anthropic-messages'
      ? ['accept', 'content-type', 'anthropic-version', 'anthropic-beta']
      : ['accept', 'content-type']
  for (const name of forwardedHeaders) {
    const value = req.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Authorization', `Bearer ${config.apiKey}`)
  if (config.protocol === 'anthropic-messages') headers.set('x-api-key', config.apiKey)
  const hasBody =
    req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined
  const body =
    ['GET', 'HEAD'].includes(req.method) || !hasBody
      ? undefined
      : req.body !== undefined
        ? Buffer.isBuffer(req.body)
          ? req.body
          : targetPath === '/anthropic/v1/messages' && req.method === 'POST'
            ? JSON.stringify(
                config.protocol === 'anthropic-messages'
                  ? { ...req.body, system: readSystemPrompt() }
                  : config.protocol === 'openai-chat-completions'
                    ? toChatCompletionsRequest({ ...req.body, system: readSystemPrompt() })
                    : toResponsesRequest({ ...req.body, system: readSystemPrompt() })
              )
            : JSON.stringify(req.body)
        : req
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
      ...(body === req ? { duplex: 'half' } : {}),
    })
    if (targetPath === '/anthropic/v1/messages' && config.protocol !== 'anthropic-messages') {
      if (!upstream.ok) {
        res.status(upstream.status)
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
        return res.end()
      }
      const usage = await forwardOpenAIStream(upstream, config.protocol, res, req.body?.model)
      recordUsage(
        req.user.id,
        typeof req.body?.model === 'string' ? req.body.model : 'unknown',
        usage
      )
      return res.end()
    }
    res.status(upstream.status)
    for (const name of ['content-type', 'cache-control', 'retry-after', 'anthropic-version']) {
      const value = upstream.headers.get(name)
      if (value) res.setHeader(name, value)
    }
    if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
      res.setHeader('X-Accel-Buffering', 'no')
      const usage = { input: 0, output: 0 }
      const decoder = new TextDecoder()
      let pending = ''
      for await (const chunk of upstream.body || []) {
        res.write(chunk)
        pending += decoder.decode(chunk, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() || ''
        for (const frame of frames)
          for (const line of frame.split('\n'))
            if (line.startsWith('data: ')) parseUsage(line.slice(6), usage)
      }
      if (req.method === 'POST')
        db.prepare(
          'INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(
          req.user.id,
          typeof req.body?.model === 'string' ? req.body.model : 'unknown',
          usage.input,
          usage.output,
          now()
        )
      return res.end()
    }
    if (!upstream.body) return res.end()
    for await (const chunk of upstream.body) res.write(chunk)
    return res.end()
  } catch (error) {
    if (res.headersSent) return res.end()
    return res
      .status(error instanceof GatewayRequestError ? error.status : 502)
      .json({ error: { message: error.message || `${config.providerName} request failed` } })
  }
})

const staticDir = path.join(root, 'dist')
app.use(
  express.static(staticDir, {
    index: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
)
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')))
app.use((error, _req, res, _next) => {
  const status = error.status || 500
  res.status(status).json({
    error:
      status === 413 ? 'Upload exceeds the allowed size' : error.message || 'Internal server error',
  })
})

const port = Number(process.env.PORT || 3100)
const server = app.listen(port, '0.0.0.0', () => console.log(`Chat server listening on ${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () =>
    server.close(() => {
      db.close()
      process.exit(0)
    })
  )
}
