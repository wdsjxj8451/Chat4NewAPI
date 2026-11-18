import { create } from 'zustand'

export type AuthUser = { id: string; username: string; isAdmin: boolean }
type AuthState = {
  loading: boolean
  user: AuthUser | null
  setupRequired: boolean
  setupTokenRequired: boolean
  error: string
}

export const useAuth = create<AuthState>(() => ({
  loading: true,
  user: null,
  setupRequired: false,
  setupTokenRequired: false,
  error: '',
}))

const authRequest = async <T>(url: string, body?: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`)
  }
  return result as T
}

export const refreshAuth = async () => {
  useAuth.setState({ loading: true, error: '' })
  try {
    const result = await authRequest<{
      user: AuthUser | null
      setupRequired: boolean
      setupTokenRequired: boolean
    }>('/api/auth/me')
    useAuth.setState({
      loading: false,
      user: result.user,
      setupRequired: result.setupRequired,
      setupTokenRequired: result.setupTokenRequired,
      error: '',
    })
  } catch (error) {
    useAuth.setState({
      loading: false,
      user: null,
      setupTokenRequired: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const signIn = async (username: string, password: string) => {
  const result = await authRequest<{ user: AuthUser }>('/api/auth/login', { username, password })
  useAuth.setState({
    loading: false,
    user: result.user,
    setupRequired: false,
    setupTokenRequired: false,
    error: '',
  })
}

export const createFirstAdmin = async (username: string, password: string, setupToken: string) => {
  const result = await authRequest<{ user: AuthUser }>('/api/setup/admin', {
    username,
    password,
    setupToken,
  })
  useAuth.setState({
    loading: false,
    user: result.user,
    setupRequired: false,
    setupTokenRequired: false,
    error: '',
  })
}

export const signOut = async () => {
  await authRequest<unknown>('/api/auth/logout', {})
  useAuth.setState({
    loading: false,
    user: null,
    setupRequired: false,
    setupTokenRequired: false,
    error: '',
  })
  window.location.assign('/')
}
