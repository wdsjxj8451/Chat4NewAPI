import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import test, { after, before } from 'node:test'
import Database from 'better-sqlite3'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ownerPassword = `owner-${randomBytes(18).toString('hex')}`
const guestPassword = `guest-${randomBytes(18).toString('hex')}`
const apiToken = randomBytes(32).toString('hex')
const setupToken = randomBytes(32).toString('hex')
let dataDir
let serverProcess
let baseUrl
let ownerSessionCookie = ''

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'chat4newapi-test-'))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  baseUrl = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      APP_DATA_DIR: dataDir,
      APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SETUP_TOKEN: setupToken,
    },
  })
  for (let attempt = 0; attempt < 300; attempt++) {
    if (serverProcess.exitCode !== null)
      throw new Error(`Server exited with ${serverProcess.exitCode}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Server did not start in time')
})

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM')
    await new Promise((resolve) => serverProcess.once('exit', resolve))
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

const send = (route, { method = 'GET', body, cookie = ownerSessionCookie, headers = {} } = {}) => {
  const requestHeaders = {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  }
  const payload =
    body === undefined
      ? undefined
      : requestHeaders['Content-Type'] === 'application/json'
        ? JSON.stringify(body)
        : body
  return fetch(`${baseUrl}${route}`, { method, headers: requestHeaders, body: payload })
}

const sessionCookie = (response) => response.headers.get('set-cookie').split(';')[0]

test('first-run setup, encrypted credentials, and per-user access isolation', async () => {
  assert.deepEqual(await (await send('/api/setup/status', { cookie: '' })).json(), {
    required: true,
    tokenRequired: true,
  })
  const deniedSetup = await send('/api/setup/admin', {
    method: 'POST',
    cookie: '',
    body: { username: 'owner', password: ownerPassword },
  })
  assert.equal(deniedSetup.status, 403)

  const setup = await send('/api/setup/admin', {
    method: 'POST',
    cookie: '',
    body: { username: 'owner', password: ownerPassword, setupToken },
  })
  assert.equal(setup.status, 201)
  ownerSessionCookie = sessionCookie(setup)
  assert.equal(
    (
      await send('/api/setup/admin', {
        method: 'POST',
        cookie: '',
        body: { username: 'second-owner', password: ownerPassword },
      })
    ).status,
    409
  )

  const createdUser = await send('/api/admin/users', {
    method: 'POST',
    body: { username: 'guest', password: guestPassword },
  })
  assert.equal(createdUser.status, 201)
  const user = await createdUser.json()

  const config = await send('/api/admin/config', {
    method: 'PUT',
    body: { baseUrl: 'http://new-api:3000', apiKey: apiToken },
  })
  assert.equal(config.status, 200)
  const db = new Database(path.join(dataDir, 'chat.sqlite'), { readonly: true })
  const encryptedKey = db
    .prepare('SELECT new_api_key FROM app_config WHERE id = 1')
    .get().new_api_key
  db.close()
  assert.notEqual(encryptedKey, apiToken)
  assert.equal(encryptedKey.includes(apiToken), false)

  const saved = await send('/api/sessions/owner-session', {
    method: 'PUT',
    body: { id: 'owner-session', title: 'Private', createdAt: 1, updatedAt: 1, messages: [] },
  })
  assert.equal(saved.status, 204)

  const login = await send('/api/auth/login', {
    method: 'POST',
    cookie: '',
    body: { username: 'guest', password: guestPassword },
  })
  assert.equal(login.status, 200)
  const guestCookie = sessionCookie(login)
  assert.deepEqual(
    (await (await send('/api/sessions', { cookie: guestCookie })).json()).sessions,
    []
  )
  assert.equal((await send('/api/sessions/owner-session', { cookie: guestCookie })).status, 404)
  assert.equal((await send('/api/admin/users', { cookie: guestCookie })).status, 403)
  assert.equal((await send('/api/upstream/api/user/self', { cookie: guestCookie })).status, 404)
  assert.equal((await send('/api/upstream/v1/models', { cookie: guestCookie })).status, 502)

  const savedFile = await send('/api/files/user-file', {
    method: 'PUT',
    cookie: sessionCookie(login),
    body: Buffer.from('private attachment'),
    headers: {
      'Content-Type': 'text/plain',
      'X-File-Name': 'note.txt',
      'X-File-Type': 'text/plain',
    },
  })
  assert.equal(savedFile.status, 204)
  assert.equal(
    await (await send('/api/files/user-file', { cookie: guestCookie })).text(),
    'private attachment'
  )
  assert.equal((await send('/api/files/user-file')).status, 404)

  const disabled = await send(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    body: { disabled: true },
  })
  assert.equal(disabled.status, 204)
  assert.equal((await send('/api/sessions', { cookie: guestCookie })).status, 401)
})
