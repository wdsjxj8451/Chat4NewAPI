import { useEffect, useState, type FormEvent } from 'react'
import { signOut } from '../services/auth.js'
import type { ModelCapabilities } from '../services/modelCatalog.js'
import type { GatewayProtocol } from '../services/api/types.js'
import { AppearanceSettings } from '../components/settings/AppearanceSettings.js'
import { Toast } from '../components/base/Toast.js'
import styles from './AdminPage.module.css'

type UserRow = {
  id: string
  username: string
  isAdmin: number
  disabled: number
  createdAt: number
  requests: number
  inputTokens: number
  outputTokens: number
}
type ModelRow = { id: string; capabilities: ModelCapabilities }
type UsageRow = {
  username: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
}
type Panel = 'models' | 'users' | 'usage' | 'settings'

const defaultSystemPrompt = '你是一个有帮助、准确且清晰的 AI 助手。'
const capabilityFields: { key: keyof ModelCapabilities; label: string }[] = [
  { key: 'reasoning', label: '深度思考' },
  { key: 'search', label: '联网搜索' },
  { key: 'files', label: '文件输入' },
  { key: 'vision', label: '图片理解' },
  { key: 'voice', label: '语音' },
]

const getJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`)
  }
  return body as T
}

export const AdminPage = () => {
  const [panel, setPanel] = useState<Panel>('models')
  const [providerName, setProviderName] = useState('Model gateway')
  const [protocol, setProtocol] = useState<GatewayProtocol>('anthropic-messages')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [models, setModels] = useState<ModelRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshUsers = async () =>
    setUsers((await getJson<{ users: UserRow[] }>('/api/admin/users')).users)
  const refreshModels = async () =>
    setModels((await getJson<{ models: ModelRow[] }>('/api/admin/models')).models)

  useEffect(() => {
    void Promise.all([
      getJson<{
        providerName: string
        protocol: GatewayProtocol
        baseUrl: string
        apiKeyConfigured: boolean
      }>('/api/admin/config').then((config) => {
        if (config.providerName) {
          setProviderName(config.providerName)
        }
        setProtocol(config.protocol)
        setBaseUrl(config.baseUrl)
        setHasKey(config.apiKeyConfigured)
      }),
      getJson<{ systemPrompt: string }>('/api/admin/settings').then((settings) =>
        setSystemPrompt(settings.systemPrompt)
      ),
      refreshUsers(),
      getJson<{ usage: UsageRow[] }>('/api/admin/usage').then((result) => setUsage(result.usage)),
      refreshModels().catch(() => setModels([])),
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  const saveConfig = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await getJson('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName, protocol, baseUrl, apiKey }),
      })
      setApiKey('')
      setProtocol(protocol)
      setHasKey(true)
      const result = await getJson<{ count: number }>('/api/admin/config/test', { method: 'POST' })
      await refreshModels()
      setMessage(`${providerName} 连接成功，读取到 ${result.count} 个模型。`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveSystemPrompt = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const saved = await getJson<{ systemPrompt: string }>('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt }),
      })
      setSystemPrompt(saved.systemPrompt)
      setMessage('聊天提示词已保存。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const addUser = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await getJson('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      setUsername('')
      setPassword('')
      await refreshUsers()
      setMessage('聊天账号已创建。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const updateModel = async (model: ModelRow, key: keyof ModelCapabilities, value: boolean) => {
    const next = { ...model, capabilities: { ...model.capabilities, [key]: value } }
    setModels((items) => items.map((item) => (item.id === model.id ? next : item)))
    try {
      await getJson(`/api/admin/models/${encodeURIComponent(model.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: next.capabilities }),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      await refreshModels()
    }
  }

  const tabs: { id: Panel; label: string }[] = [
    { id: 'models', label: '模型与连接' },
    { id: 'users', label: '聊天用户' },
    { id: 'usage', label: '用量记录' },
    { id: 'settings', label: '聊天设置' },
  ]

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span>CHAT4NEWAPI</span>
          <h1>管理控制台</h1>
        </div>
        <div className={styles.headerActions}>
          <a href="/">返回聊天</a>
          <button type="button" onClick={() => void signOut()}>
            退出
          </button>
        </div>
      </header>
      <div className={styles.workspace}>
        <div className={styles.pageHeading}>
          <div>
            <h2>{tabs.find((tab) => tab.id === panel)?.label}</h2>
            <p>管理模型服务、访问权限与聊天体验</p>
          </div>
          {panel === 'models' ? (
            <span className={hasKey ? styles.connected : styles.disconnected}>
              <span aria-hidden="true" />
              {hasKey ? '已配置' : '尚未连接'}
            </span>
          ) : null}
        </div>
        <nav className={styles.tabs} aria-label="管理页面">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={panel === tab.id ? 'page' : undefined}
              onClick={() => {
                setPanel(tab.id)
                setMessage('')
                setError('')
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {message ? (
          <p className={styles.success} role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {panel === 'models' ? (
          <div className={styles.content}>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>模型服务</h3>
                  <p>选择聚合平台提供的 API 协议。密钥加密保存在本机。</p>
                </div>
              </div>
              <form className={styles.connectionForm} onSubmit={(event) => void saveConfig(event)}>
                <label>
                  平台名称
                  <input
                    value={providerName}
                    onChange={(event) => setProviderName(event.target.value)}
                    maxLength={64}
                    placeholder="例如：New API、Sub2API"
                    required
                  />
                </label>
                <label>
                  API 协议
                  <select
                    value={protocol}
                    onChange={(event) => setProtocol(event.target.value as GatewayProtocol)}
                  >
                    <option value="anthropic-messages">Anthropic Messages</option>
                    <option value="openai-chat-completions">OpenAI Chat Completions</option>
                    <option value="openai-responses">OpenAI Responses</option>
                  </select>
                </label>
                <label>
                  API 基础地址
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.example.com/v1"
                    required
                  />
                </label>
                <label>
                  API 密钥
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={hasKey ? '已保存，留空则保持不变' : '粘贴聚合平台的 API Key'}
                  />
                </label>
                <button className={styles.primary} type="submit" disabled={busy}>
                  {busy ? '测试中…' : '保存并测试'}
                </button>
              </form>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>模型目录</h3>
                  <p>按模型启用聊天中可用的能力。</p>
                </div>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => void refreshModels()}
                  disabled={!hasKey}
                >
                  刷新模型
                </button>
              </div>
              {models.length ? (
                <div className={styles.modelList}>
                  <div className={`${styles.modelRow} ${styles.modelHeader}`}>
                    <strong>模型</strong>
                    <span>能力</span>
                  </div>
                  {models.map((model) => (
                    <div className={styles.modelRow} key={model.id}>
                      <strong>{model.id}</strong>
                      <div className={styles.capabilities}>
                        {capabilityFields
                          .filter(
                            ({ key }) =>
                              protocol !== 'openai-chat-completions' ||
                              (key !== 'search' && key !== 'files' && key !== 'vision')
                          )
                          .map(({ key, label }) => (
                            <label key={key}>
                              <input
                                type="checkbox"
                                checked={model.capabilities[key]}
                                onChange={(event) =>
                                  void updateModel(model, key, event.target.checked)
                                }
                              />
                              {label}
                            </label>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.empty}>
                  {hasKey
                    ? '没有读取到模型，请检查平台渠道与模型配置。'
                    : '连接聚合平台后，模型会显示在这里。'}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {panel === 'users' ? (
          <div className={styles.content}>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>创建聊天账号</h3>
                  <p>邀请制关闭公开注册。密码至少 12 位。</p>
                </div>
              </div>
              <form className={styles.userForm} onSubmit={(event) => void addUser(event)}>
                <label>
                  用户名
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    minLength={3}
                    maxLength={32}
                    required
                  />
                </label>
                <label>
                  初始密码
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </label>
                <button className={styles.primary} type="submit" disabled={busy}>
                  创建用户
                </button>
              </form>
            </section>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>用户</h3>
                  <p>{users.length} 个账号</p>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>用户名</th>
                      <th>状态</th>
                      <th>请求数</th>
                      <th>输入 / 输出 Token</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <UserItem
                        key={user.id}
                        user={user}
                        onRefresh={refreshUsers}
                        onError={setError}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}

        {panel === 'usage' ? (
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div>
                <h3>模型用量</h3>
                <p>仅记录聚合平台返回 Token 用量的流式请求，不执行额度限制。</p>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>模型</th>
                    <th>请求</th>
                    <th>输入 Token</th>
                    <th>输出 Token</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((row) => (
                    <tr key={`${row.username}-${row.model}`}>
                      <td>{row.username}</td>
                      <td>{row.model}</td>
                      <td>{row.requests}</td>
                      <td>{row.inputTokens}</td>
                      <td>{row.outputTokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {panel === 'settings' ? (
          <div className={styles.content}>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>通用聊天提示词</h3>
                  <p>
                    每次新回复都会应用。此提示词对所有用户生效，不会覆盖模型服务本身的安全策略。
                  </p>
                </div>
              </div>
              <form
                className={styles.promptForm}
                onSubmit={(event) => void saveSystemPrompt(event)}
              >
                <label htmlFor="system-prompt">系统提示词</label>
                <textarea
                  id="system-prompt"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  maxLength={20000}
                  rows={12}
                  spellCheck={false}
                />
                <div className={styles.promptFooter}>
                  <span>{systemPrompt.length.toLocaleString()} / 20,000</span>
                  <div>
                    <button
                      className={styles.secondary}
                      type="button"
                      onClick={() => setSystemPrompt(defaultSystemPrompt)}
                    >
                      恢复默认
                    </button>
                    <button className={styles.primary} type="submit" disabled={busy}>
                      保存提示词
                    </button>
                  </div>
                </div>
              </form>
            </section>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <div>
                  <h3>网站外观</h3>
                  <p>修改站点名称、浏览器图标与品牌色。</p>
                </div>
              </div>
              <AppearanceSettings />
            </section>
          </div>
        ) : null}
      </div>
      <Toast />
    </main>
  )
}

const UserItem = ({
  user,
  onRefresh,
  onError,
}: {
  user: UserRow
  onRefresh: () => Promise<void>
  onError: (error: string) => void
}) => {
  const label = user.isAdmin ? '管理员' : user.disabled ? '已停用' : '正常'
  const toggle = async () => {
    try {
      await getJson(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: !user.disabled }),
      })
      await onRefresh()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <tr>
      <td>{user.username}</td>
      <td>{label}</td>
      <td>{user.requests}</td>
      <td>
        {user.inputTokens} / {user.outputTokens}
      </td>
      <td>
        {user.isAdmin ? (
          '—'
        ) : (
          <button type="button" className={styles.tableAction} onClick={() => void toggle()}>
            {user.disabled ? '启用' : '停用'}
          </button>
        )}
      </td>
    </tr>
  )
}
