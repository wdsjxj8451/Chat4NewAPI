import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { BrandMark } from '../base/BrandMark.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.intro}>
          <BrandMark welcome />
          <h1 className={styles.greeting}>{t('welcomeMessageChat250808')}</h1>
        </div>
        <ChatInput sessionId={null} />
        <div className={styles.caveat}>{t('contentCaveat')}</div>
      </div>
    </div>
  )
}
