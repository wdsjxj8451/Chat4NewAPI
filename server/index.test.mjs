import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
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
  const legacyDb = new Database(path.join(dataDir, 'chat.sqlite'))
  legacyDb.exec(`CREATE TABLE app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    new_api_url TEXT NOT NULL,
    new_api_key TEXT NOT NULL
  )`)
  legacyDb.close()
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
  assert.deepEqual(await (await send('/api/appearance', { cookie: '' })).json(), {
    name: '',
    accent: '',
    icon: '',
    showIcon: true,
  })
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
  const appearance = {
    name: 'Private Chat',
    accent: '#355577',
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tL8AAAAASUVORK5CYII=',
    showIcon: false,
  }
  assert.equal(
    (await send('/api/admin/appearance', { method: 'PUT', body: appearance, cookie: '' })).status,
    401
  )
  assert.deepEqual(
    await (await send('/api/admin/appearance', { method: 'PUT', body: appearance })).json(),
    appearance
  )
  assert.deepEqual(await (await send('/api/appearance', { cookie: '' })).json(), appearance)
  assert.equal(
    (
      await send('/api/admin/appearance', {
        method: 'PUT',
        body: { ...appearance, accent: 'url(javascript:alert(1))' },
      })
    ).status,
    400
  )
  assert.equal(
    (
      await send('/api/admin/appearance', {
        method: 'PUT',
        body: { ...appearance, icon: 'data:image/svg+xml;base64,PHN2Zz4=' },
      })
    ).status,
    400
  )
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
    body: {
      providerName: 'Sub2API',
      protocol: 'anthropic-messages',
      baseUrl: 'http://sub2api:3000/v1',
      apiKey: apiToken,
    },
  })
  assert.equal(config.status, 200)
  assert.deepEqual(await config.json(), {
    configured: true,
    providerName: 'Sub2API',
    protocol: 'anthropic-messages',
    baseUrl: 'http://sub2api:3000',
    apiKeyConfigured: true,
  })
  assert.deepEqual(await (await send('/api/admin/config')).json(), {
    configured: true,
    providerName: 'Sub2API',
    protocol: 'anthropic-messages',
    baseUrl: 'http://sub2api:3000',
    apiKeyConfigured: true,
  })
  const migratedDb = new Database(path.join(dataDir, 'chat.sqlite'), { readonly: true })
  assert.ok(
    migratedDb
      .prepare('PRAGMA table_info(app_config)')
      .all()
      .some((column) => column.name === 'provider_name')
  )
  assert.ok(
    migratedDb
      .prepare('PRAGMA table_info(app_config)')
      .all()
      .some((column) => column.name === 'api_protocol')
  )
  migratedDb.close()
  assert.equal(
    (await send('/api/admin/config', { method: 'PUT', body: { baseUrl: 'ftp://bad' } })).status,
    400
  )
  assert.equal((await send('/api/admin/settings', { cookie: '' })).status, 401)
  assert.deepEqual(await (await send('/api/admin/settings')).json(), {
    systemPrompt: '你是一个有帮助、准确且清晰的 AI 助手。',
  })
  const systemPrompt = '你是一个支持自定义故事背景的角色扮演助手。'
  assert.deepEqual(
    await (
      await send('/api/admin/settings', {
        method: 'PUT',
        body: { systemPrompt },
      })
    ).json(),
    { systemPrompt }
  )
  assert.equal(
    (
      await send('/api/admin/settings', {
        method: 'PUT',
        body: { systemPrompt: 'x'.repeat(20001) },
      })
    ).status,
    400
  )
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
  assert.equal((await send('/api/admin/settings', { cookie: guestCookie })).status, 403)
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

test('OpenAI Chat Completions and Responses adapters normalize streaming events', async () => {
  const requests = []
  const gateway = createHttpServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString()
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : null,
    })
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'gpt-4.1' }] }))
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (req.url === '/v1/chat/completions') {
      res.write(
        'data: {"id":"chatcmpl-test","model":"gpt-4.1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
      )
      res.write(
        'data: {"id":"chatcmpl-test","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n'
      )
      res.end('data: [DONE]\n\n')
      return
    }
    if (req.url === '/v1/responses') {
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-test","model":"gpt-4.1"}}\n\n'
      )
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"World"}\n\n'
      )
      res.end(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":2}}}\n\n'
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/v1`
  const canonicalRequest = {
    model: 'gpt-4.1',
    system: 'untrusted browser prompt',
    messages: [
      { role: 'user', content: 'Earlier' },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
      { role: 'latest_reminder', content: 'Current style: concise' },
      { role: 'user', content: 'Reply with a greeting' },
    ],
  }

  try {
    await send('/api/admin/config', {
      method: 'PUT',
      body: {
        providerName: 'Local OpenAI-compatible test gateway',
        protocol: 'openai-chat-completions',
        baseUrl: gatewayUrl,
        apiKey: apiToken,
      },
    })
    await send('/api/admin/models/gpt-4.1', {
      method: 'PUT',
      body: {
        capabilities: { reasoning: true, search: true, files: true, vision: true, voice: true },
      },
    })
    const chatResponse = await send('/api/upstream/anthropic/v1/messages', {
      method: 'POST',
      body: canonicalRequest,
    })
    assert.equal(chatResponse.status, 200)
    const chatEvents = await chatResponse.text()
    assert.match(chatEvents, /"type":"text_delta","text":"Hello"/)
    assert.match(chatEvents, /"type":"message_stop"/)
    const chatRequest = requests.find((request) => request.url === '/v1/chat/completions')
    assert.equal(chatRequest.authorization, `Bearer ${apiToken}`)
    assert.equal(chatRequest.body.messages[0].content, '你是一个支持自定义故事背景的角色扮演助手。')
    assert.deepEqual(chatRequest.body.messages.at(-2), {
      role: 'system',
      content: 'Current style: concise',
    })
    const chatModels = await (await send('/api/models')).json()
    assert.equal(chatModels.protocol, 'openai-chat-completions')
    assert.equal(chatModels.models[0].capabilities.search, false)
    assert.equal(chatModels.models[0].capabilities.files, false)
    assert.equal(chatModels.models[0].capabilities.vision, false)

    await send('/api/admin/config', {
      method: 'PUT',
      body: {
        providerName: 'Local OpenAI-compatible test gateway',
        protocol: 'openai-responses',
        baseUrl: gatewayUrl,
        apiKey: apiToken,
      },
    })
    const responsesResponse = await send('/api/upstream/anthropic/v1/messages', {
      method: 'POST',
      body: canonicalRequest,
    })
    assert.equal(responsesResponse.status, 200)
    const responsesEvents = await responsesResponse.text()
    assert.match(responsesEvents, /"type":"text_delta","text":"World"/)
    assert.match(responsesEvents, /"type":"message_stop"/)
    const responsesRequest = requests.find((request) => request.url === '/v1/responses')
    assert.equal(responsesRequest.body.instructions, '你是一个支持自定义故事背景的角色扮演助手。')
    assert.deepEqual(responsesRequest.body.input.at(-2), {
      role: 'developer',
      content: [{ type: 'input_text', text: 'Current style: concise' }],
    })
    const responsesModels = await (await send('/api/models')).json()
    assert.equal(responsesModels.protocol, 'openai-responses')
    assert.equal(responsesModels.models[0].capabilities.files, true)
  } finally {
    await new Promise((resolve) => gateway.close(resolve))
  }
})
