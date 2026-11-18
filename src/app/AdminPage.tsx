import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { signOut } from '../services/auth.js'
import type { ModelCapabilities } from '../services/modelCatalog.js'
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
type Panel = 'models' | 'users' | 'usage'

const capabilities: { key: keyof ModelCapabilities; label: string }[] = [
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
  const [baseUrl, setBaseUrl] = useState('http://new-api:3000')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [models, setModels] = useState<ModelRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [usage, setUsage] = useState<UsageRow[]>([])
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
      getJson<{ baseUrl: string; apiKeyConfigured: boolean }>('/api/admin/config').then(
        (config) => {
          if (config.baseUrl) {
            setBaseUrl(config.baseUrl)
          }
          setHasKey(config.apiKeyConfigured)
        }
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
        body: JSON.stringify({ baseUrl, apiKey }),
      })
      setApiKey('')
      setHasKey(true)
      const result = await getJson<{ count: number }>('/api/admin/config/test', { method: 'POST' })
      await refreshModels()
      setMessage(`New API 连接成功，读取到 ${result.count} 个模型。`)
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
  ]

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p>MODEL HUB</p>
          <h1>管理控制台</h1>
        </div>
        <div className={styles.headerActions}>
          <a href="/">返回聊天</a>
          <button type="button" onClick={() => void signOut()}>
            退出
          </button>
        </div>
      </header>
      <nav className={styles.tabs} aria-label="管理页面">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={panel === tab.id ? 'page' : undefined}
            onClick={() => setPanel(tab.id)}
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
                <h2>New API 连接</h2>
                <p>聊天请求仅由服务器转发，密钥采用本地加密存储。</p>
              </div>
              <span className={hasKey ? styles.connected : styles.disconnected}>
                {hasKey ? '已配置' : '未配置'}
              </span>
            </div>
            <form className={styles.connectionForm} onSubmit={(event) => void saveConfig(event)}>
              <label>
                New API 地址
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://new-api:3000"
                  required
                />
              </label>
              <label>
                New API 令牌
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={hasKey ? '已保存，留空则保持不变' : '粘贴 New API 创建的令牌'}
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? '连接中…' : '保存并测试'}
              </button>
            </form>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div>
                <h2>模型能力</h2>
                <p>按模型启用前端功能；初次配置后请用实际通道验证。</p>
              </div>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void refreshModels()}
              >
                刷新模型
              </button>
            </div>
            {models.length ? (
              <div className={styles.modelList}>
                {models.map((model) => (
                  <div className={styles.modelRow} key={model.id}>
                    <strong>{model.id}</strong>
                    <div className={styles.capabilities}>
                      {capabilities.map(({ key, label }) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            checked={model.capabilities[key]}
                            onChange={(event) => void updateModel(model, key, event.target.checked)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>连接 New API 并配置渠道后，模型会显示在这里。</div>
            )}
          </section>
        </div>
      ) : null}

      {panel === 'users' ? (
        <div className={styles.content}>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div>
                <h2>创建聊天账号</h2>
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
              <button type="submit" disabled={busy}>
                创建用户
              </button>
            </form>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div>
                <h2>用户</h2>
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
              <h2>模型用量</h2>
              <p>只记录 New API 返回了 token 用量的流式请求，不执行额度限制。</p>
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
  const label = useMemo(() => (user.isAdmin ? '管理员' : user.disabled ? '已停用' : '正常'), [user])
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
