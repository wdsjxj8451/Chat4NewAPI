import { toSessionSummary, type Session, type SessionSummary } from './types.js'

export type StoredFile = { id: string; blob: Blob; name?: string }

const stagingSessions: Session[] = []
const stagingFiles = new Map<string, StoredFile>()
const sessionQueues = new Map<string, Promise<void>>()

const enqueueSession = (id: string, operation: () => Promise<void>) => {
  const previous = sessionQueues.get(id) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(operation)
  sessionQueues.set(id, task)
  return task.finally(() => {
    if (sessionQueues.get(id) === task) {
      sessionQueues.delete(id)
    }
  })
}

const waitForPendingSaves = () =>
  Promise.all([...sessionQueues.values()].map((task) => task.catch(() => {})))

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Request failed (${response.status})`)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

const uploadFiles = async (files: StoredFile[]) => {
  await Promise.all(
    files.map((file) =>
      request<unknown>(`/api/files/${encodeURIComponent(file.id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': file.blob.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || file.id),
          'X-File-Type': file.blob.type || 'application/octet-stream',
        },
        body: file.blob,
      })
    )
  )
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const body = await request<{ sessions: SessionSummary[] }>('/api/sessions')
  return body.sessions.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  await sessionQueues.get(id)?.catch(() => {})
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`)
}

export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  enqueueSession(session.id, async () => {
    await uploadFiles(files)
    await request<unknown>(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    })
  })

export const renameSession = async (id: string, title: string): Promise<void> => {
  await sessionQueues.get(id)?.catch(() => {})
  const session = await loadSession(id)
  if (!session) {
    return
  }
  await saveSession({ ...session, title, updatedAt: Date.now() })
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  await sessionQueues.get(sessionId)?.catch(() => {})
  await request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export const saveFiles = uploadFiles

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  })
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`File request failed (${response.status})`)
  }
  return response.blob()
}

export const clearStaging = async (): Promise<void> => {
  stagingSessions.length = 0
  stagingFiles.clear()
}

export const addStagingSession = async (session: Session): Promise<void> => {
  stagingSessions.push(session)
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    stagingFiles.set(file.id, file)
  }
}

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  for (const session of stagingSessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        const mimeType = types.get(file.id)
        if (mimeType) {
          file.mimeType = mimeType
        }
      }
    }
  }
}

export const commitStaging = async (): Promise<SessionSummary[]> => {
  await waitForPendingSaves()
  await uploadFiles([...stagingFiles.values()])
  const body = await request<{ sessions: SessionSummary[] }>('/api/sessions/replace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: stagingSessions }),
  })
  await clearStaging()
  return body.sessions.map(toSessionSummary)
}

export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
