import { create } from 'zustand'

const storageKey = 'chat4newapi:appearance'
export const defaultSiteName = 'Chat4NewAPI'
export const defaultAccent = '#5d46a3'
export const maxSiteNameLength = 48
const maxIconBytes = 128 * 1024
const rasterIcon =
  /^data:image\/(?:png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/]+=*$/i
export const iconAccept =
  'image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon,.ico'

type Appearance = {
  name: string
  accent: string
  icon: string
  showIcon: boolean
}

export const defaultAppearance: Appearance = { name: '', accent: '', icon: '', showIcon: true }

const fetchAppearance = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.error || `Request failed (${response.status})`)
  }
  return normalizeAppearance(body)
}

export const normalizeAppearance = (value: Partial<Appearance> | null): Appearance => ({
  name: typeof value?.name === 'string' ? value.name.trim().slice(0, maxSiteNameLength) : '',
  accent:
    typeof value?.accent === 'string' && /^#[\da-f]{6}$/i.test(value.accent) ? value.accent : '',
  icon:
    typeof value?.icon === 'string' &&
    value.icon.length <= maxIconBytes * 2 &&
    rasterIcon.test(value.icon)
      ? value.icon
      : '',
  showIcon: value?.showIcon !== false,
})

const readAppearance = () => {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
  } catch {
    return defaultAppearance
  }
}

export const useAppearance = create<Appearance>(readAppearance)
export const useSiteName = () => useAppearance((state) => state.name || defaultSiteName)

export const loadAppearance = async () => {
  try {
    const appearance = await fetchAppearance('/api/appearance')
    try {
      localStorage.setItem(storageKey, JSON.stringify(appearance))
    } catch {
      // The server remains the source of truth when local storage is unavailable.
    }
    useAppearance.setState(appearance)
  } catch {
    // Keep the last-known local branding when the server cannot be reached.
  }
}

export const saveAppearance = async (value: Appearance) => {
  const appearance = normalizeAppearance(value)
  const saved = await fetchAppearance('/api/admin/appearance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(appearance),
  })
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved))
  } catch {
    // The saved server branding still applies for this page session.
  }
  useAppearance.setState(saved)
  return saved
}

export const readTabIcon = async (file: File): Promise<string> => {
  if (!file.size || file.size > maxIconBytes) {
    throw new Error('Invalid icon size')
  }
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(
      !file.type && /\.ico$/i.test(file.name) ? file.slice(0, file.size, 'image/x-icon') : file
    )
  })
  if (!rasterIcon.test(url)) {
    throw new Error('Unsupported icon format')
  }
  const image = new Image()
  image.src = url
  await image.decode()
  return url
}

export const buttonAccent = (color: string) => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
  const luminance = (factor: number) =>
    channels.reduce((sum, channel, index) => {
      const scaled = Math.round(channel * factor) / 255
      const linear = scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      return sum + linear * [0.2126, 0.7152, 0.0722][index]
    }, 0)
  let factor = 1
  while (luminance(factor) > 0.173) {
    factor -= 0.025
  }
  return `#${channels
    .map((channel) =>
      Math.round(channel * factor)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}
