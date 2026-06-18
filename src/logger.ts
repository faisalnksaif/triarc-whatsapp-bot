import { appendFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const logsDir = resolve(process.cwd(), 'logs')

try {
  mkdirSync(logsDir, { recursive: true })
} catch {
  // directory might already exist
}

const getLogFile = () => {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  return resolve(logsDir, `bot-${date}.log`)
}

const formatLog = (level: string, message: string, data?: any): string => {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` ${JSON.stringify(data)}` : ''
  return `[${timestamp}] ${level} ${message}${dataStr}\n`
}

export function log(message: string, data?: any): void {
  const line = formatLog('INFO', message, data)
  process.stdout.write(line)
  try {
    appendFileSync(getLogFile(), line)
  } catch (err) {
    console.error('[logger] Failed to write to log file:', err)
  }
}

export function logError(message: string, error?: any): void {
  const errorStr = error instanceof Error ? error.message : String(error)
  const line = formatLog('ERROR', message, { error: errorStr })
  process.stderr.write(line)
  try {
    appendFileSync(getLogFile(), line)
  } catch (err) {
    console.error('[logger] Failed to write to log file:', err)
  }
}

export function logWarn(message: string, data?: any): void {
  const line = formatLog('WARN', message, data)
  process.stdout.write(line)
  try {
    appendFileSync(getLogFile(), line)
  } catch (err) {
    console.error('[logger] Failed to write to log file:', err)
  }
}
