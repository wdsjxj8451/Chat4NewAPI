import clsx from 'clsx'
import styles from './BrandMark.module.css'

export const BrandMark = ({ welcome = false }: { welcome?: boolean }) => (
  <span className={clsx(styles.mark, welcome && styles.welcome)} aria-hidden="true">
    <span />
    <span />
    <span />
  </span>
)
