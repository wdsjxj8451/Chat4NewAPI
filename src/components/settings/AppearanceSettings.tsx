import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  defaultAccent,
  defaultAppearance,
  defaultSiteName,
  iconAccept,
  maxSiteNameLength,
  readTabIcon,
  saveAppearance,
  useAppearance,
} from '../../services/appearance.js'
import { Button } from '../base/Button.js'
import { BrandMark } from '../base/BrandMark.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

export const AppearanceSettings = () => {
  const t = useTranslate()
  const saved = useAppearance()
  const [name, setName] = useState(saved.name)
  const [accent, setAccent] = useState(saved.accent)
  const [icon, setIcon] = useState(saved.icon)
  const [showIcon, setShowIcon] = useState(saved.showIcon)
  const [iconError, setIconError] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const siteName = name.trim() || defaultSiteName
  const previewAccent = accent || defaultAccent

  const reset = () => {
    setName(defaultAppearance.name)
    setAccent(defaultAppearance.accent)
    setIcon(defaultAppearance.icon)
    setShowIcon(true)
    setIconError(false)
  }

  const save = async () => {
    try {
      await saveAppearance({ name, accent, icon, showIcon })
      showToast({ key: 'appearanceSaved' })
    } catch {
      showToast({ key: 'appearanceSaveError', type: 'error' })
    }
  }

  return (
    <div className={styles.appearance}>
      <p className={styles.appearanceDescription}>{t('appearanceDescription')}</p>
      <div className={styles.appearancePreview}>
        <span className={styles.appearancePreviewIcon} aria-hidden="true">
          {showIcon && icon ? <img src={icon} alt="" /> : <BrandMark />}
        </span>
        <div className={styles.appearancePreviewText}>
          <strong title={siteName}>{siteName}</strong>
          <span>{t('appearance')}</span>
        </div>
        <span className={styles.appearanceSwatch} style={{ backgroundColor: previewAccent }} />
      </div>
      <label className={styles.appearanceField}>
        <span className={styles.appearanceFieldText}>{t('appearanceName')}</span>
        <input
          type="text"
          maxLength={maxSiteNameLength}
          value={name}
          placeholder={defaultSiteName}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={styles.appearanceField}>
        <span className={styles.appearanceFieldText}>{t('appearanceAccent')}</span>
        <input
          type="color"
          aria-label={t('appearanceAccent')}
          value={previewAccent}
          onChange={(event) => setAccent(event.target.value)}
        />
      </label>
      <div className={styles.appearanceField}>
        <span className={styles.appearanceFieldText}>
          {t('appearanceIcon')}
          <span className={styles.description}>{t('appearanceIconHint')}</span>
        </span>
        <div className={styles.appearanceIconControls}>
          <input
            ref={fileRef}
            className={styles.fileInput}
            type="file"
            accept={iconAccept}
            aria-label={t('appearanceIcon')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) {
                void readTabIcon(file)
                  .then((value) => {
                    setIcon(value)
                    setIconError(false)
                  })
                  .catch(() => setIconError(true))
              }
            }}
          />
          <Button variant="outlined" size="m" onClick={() => fileRef.current?.click()}>
            {t('appearanceUploadIcon')}
          </Button>
          {icon ? (
            <Button variant="outlined" size="m" onClick={() => setIcon('')}>
              {t('appearanceDefaultIcon')}
            </Button>
          ) : null}
        </div>
      </div>
      <label className={styles.appearanceToggle}>
        <input
          type="checkbox"
          checked={showIcon}
          onChange={(event) => setShowIcon(event.target.checked)}
        />
        <span>{t('appearanceShowIcon')}</span>
      </label>
      {iconError ? (
        <p className={styles.error} role="alert">
          {t('appearanceIconError')}
        </p>
      ) : null}
      <div className={styles.appearanceActions}>
        <Button variant="outlined" size="m" onClick={reset}>
          {t('appearanceReset')}
        </Button>
        <Button size="m" onClick={save}>
          {t('appearanceSave')}
        </Button>
      </div>
    </div>
  )
}
