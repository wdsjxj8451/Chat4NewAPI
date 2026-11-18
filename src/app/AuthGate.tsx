import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createFirstAdmin, refreshAuth, signIn, useAuth } from '../services/auth.js'
import { loadModels } from '../services/modelCatalog.js'
import { AdminPage } from './AdminPage.js'
import styles from './AuthGate.module.css'

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const { loading, user, setupRequired, setupTokenRequired } = useAuth()
  useEffect(() => {
    void refreshAuth()
  }, [])
  useEffect(() => {
    if (user) {
      void loadModels()
    }
  }, [user])

  if (loading) {
    return <main className={styles.loading}>正在检查登录状态…</main>
  }
  if (!user) {
    return <AuthForm setup={setupRequired} setupTokenRequired={setupTokenRequired} />
  }
  if (window.location.pathname === '/admin') {
    return user.isAdmin ? (
      <AdminPage />
    ) : (
      <main className={styles.denied}>该页面仅管理员可访问。</main>
    )
  }
  return children
}

const AuthForm = ({
  setup,
  setupTokenRequired,
}: {
  setup: boolean
  setupTokenRequired: boolean
}) => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (setup) {
        await createFirstAdmin(username, password, setupToken)
      } else {
        await signIn(username, password)
      }
      if (window.location.pathname === '/admin') {
        window.location.reload()
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className={styles.authPage}>
      <section className={styles.authPanel}>
        <div className={styles.brandMark}>C4</div>
        <p className={styles.eyebrow}>Chat4NewAPI</p>
        <h1>{setup ? '创建管理员' : '登录'}</h1>
        <p className={styles.subtitle}>
          {setup
            ? '创建唯一的初始管理员账号。后续用户由管理员邀请。'
            : '使用管理员提供的聊天账号继续。'}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            用户名
            <input
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              minLength={3}
              maxLength={32}
            />
          </label>
          {setup && setupTokenRequired ? (
            <label>
              初始安装令牌
              <input
                type="password"
                autoComplete="off"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                required
              />
            </label>
          ) : null}
          <label>
            密码
            <input
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={setup ? 12 : 1}
              maxLength={128}
            />
          </label>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <button className={styles.primary} type="submit" disabled={busy}>
            {busy ? '处理中…' : setup ? '创建并登录' : '登录'}
          </button>
        </form>
        <div className={styles.securityNote}>会话由服务器管理，模型密钥不会发送到浏览器。</div>
      </section>
    </main>
  )
}
