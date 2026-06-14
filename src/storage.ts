import { mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import type { SessionRecord } from './types.js'

export function saveSession(responsesDir: string, record: SessionRecord): string {
  const dir = resolve(process.cwd(), responsesDir)
  mkdirSync(dir, { recursive: true })

  const filename = `${record.sessionId}.json`
  const filepath = join(dir, filename)
  writeFileSync(filepath, JSON.stringify(record, null, 2), 'utf-8')

  return filepath
}

export function generateSessionId(): string {
  return `session_${new Date().toISOString().replace(/[:.]/g, '-')}`
}
