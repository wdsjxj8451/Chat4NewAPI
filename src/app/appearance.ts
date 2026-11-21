import {
  buttonAccent,
  defaultAccent,
  defaultSiteName,
  loadAppearance,
  useAppearance,
} from '../services/appearance.js'

export const brandTabIcon = (accent: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="10" fill="${accent}"/><path d="M8 10h16m-12 6h12M8 22h9" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const blankIcon =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22/%3E'

export const setupAppearance = () => {
  const favicon = document.createElement('link')
  favicon.rel = 'icon'
  document.head.append(favicon)

  const apply = (appearance: ReturnType<typeof useAppearance.getState>) => {
    const { accent, icon, name, showIcon } = appearance
    const siteName = name || defaultSiteName
    document.title = siteName
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', `${siteName} - a self-hosted multi-model chat workspace.`)
    const style = document.body.style
    if (accent) {
      style.setProperty('--chat-custom-tint', accent)
      style.setProperty('--chat-custom-accent', buttonAccent(accent))
    } else {
      style.removeProperty('--chat-custom-tint')
      style.removeProperty('--chat-custom-accent')
    }
    favicon.href = showIcon
      ? icon || brandTabIcon(buttonAccent(accent || defaultAccent))
      : blankIcon
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(document.body).backgroundColor)
  }

  apply(useAppearance.getState())
  void loadAppearance()
  useAppearance.subscribe(apply)
}
