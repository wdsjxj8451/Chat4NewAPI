import { mkdir, cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'))
const backupDir = path.join(dataDir, '.backup')
await rm(backupDir, { recursive: true, force: true })
await mkdir(backupDir, { recursive: true, mode: 0o700 })
const db = new Database(path.join(dataDir, 'chat.sqlite'), { readonly: true })
await db.backup(path.join(backupDir, 'chat.sqlite'))
db.close()
await cp(path.join(dataDir, 'files'), path.join(backupDir, 'files'), { recursive: true, force: true })
console.log(`Chat database and attachments prepared in ${backupDir}`)
