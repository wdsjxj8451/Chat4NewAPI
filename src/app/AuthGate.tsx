import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { createFirstAdmin, refreshAuth, signIn, useAuth } from '../services/auth.js'
import { loadModels } from '../services/modelCatalog.js'
import { BrandMark } from '../components/base/BrandMark.js'
import { useTranslate } from '../i18n/index.js'
import { useSiteName } from '../services/appearance.js'
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
  const t = useTranslate()
  const siteName = useSiteName()
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
      <div className={styles.layout}>
        <div className={styles.identity}>
          <div className={styles.art} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className={styles.wordmark}>
            <BrandMark /> <span>{siteName}</span>
          </div>
        </div>
        <section className={styles.authPanel} aria-labelledby="auth-heading">
          <h1 id="auth-heading">{t(setup ? 'authSetup' : 'authSignIn')}</h1>
          <p className={styles.subtitle}>
            {t(setup ? 'authSetupDescription' : 'authSignInDescription')}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              {t('authUsername')}
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                minLength={3}
                maxLength={32}
              />
            </label>
            {setup && setupTokenRequired ? (
              <label>
                {t('authSetupToken')}
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
              {t('authPassword')}
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
              {t(busy ? 'authPending' : setup ? 'authSetupSubmit' : 'authSignIn')}
            </button>
          </form>
          <div className={styles.securityNote}>{t('authSecurityNote')}</div>
        </section>
      </div>
    </main>
  )
}
