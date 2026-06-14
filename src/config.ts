import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { BotConfig, Question, QuestionnaireSet } from './types.js'

export function loadConfig(): BotConfig {
  const path = resolve(process.cwd(), 'config.json')
  const config: BotConfig = JSON.parse(readFileSync(path, 'utf-8'))

  const required: (keyof BotConfig)[] = ['timezone', 'questionsFile', 'responsesDir']
  for (const key of required) {
    if (!config[key]) throw new Error(`config.json: missing field "${key}"`)
  }

  if (!Array.isArray(config.recipients) || config.recipients.length === 0) {
    throw new Error('config.json: "recipients" must be a non-empty array')
  }

  return config
}

function validateQuestions(questions: Question[], setTitle: string): void {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`Set "${setTitle}": must have a non-empty questions array`)
  }
  for (const q of questions) {
    if (!q.id || !q.question || !q.type) {
      throw new Error(`Set "${setTitle}": invalid question object: ${JSON.stringify(q)}`)
    }
    if (!['text', 'number', 'poll'].includes(q.type)) {
      throw new Error(`Set "${setTitle}", question "${q.id}": type must be text, number, or poll`)
    }
    if (q.type === 'poll' && (!Array.isArray(q.options) || q.options.length < 2)) {
      throw new Error(`Set "${setTitle}", question "${q.id}": poll type requires at least 2 options`)
    }
  }
}

export function loadQuestions(questionsFile: string): QuestionnaireSet[] {
  const path = resolve(process.cwd(), questionsFile)
  const sets: QuestionnaireSet[] = JSON.parse(readFileSync(path, 'utf-8'))

  if (!Array.isArray(sets) || sets.length === 0) {
    throw new Error(`${questionsFile}: must be a non-empty array of questionnaire sets`)
  }

  for (const set of sets) {
    if (!set.title) throw new Error(`${questionsFile}: each set must have a "title"`)
    if (!set.scheduleTime || !/^\d{1,2}:\d{2}$/.test(set.scheduleTime)) {
      throw new Error(`Set "${set.title}": scheduleTime must be in H:MM or HH:MM format (24h)`)
    }
    validateQuestions(set.questions, set.title)
  }

  return sets
}

/**
 * Converts a recipient string to a WhatsApp JID.
 * - Full JID (contains "@"): used as-is  →  use this for groups, e.g. "120363xxxxxxxx@g.us"
 * - Phone number (e.g. "+2348012345678"): converted to individual JID
 */
export function toJid(recipient: string): string {
  if (recipient.includes('@')) return recipient
  const digits = recipient.replace(/\D/g, '')
  return `${digits}@c.us`
}

export function timeToCron(scheduleTime: string): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number)
  return `${minutes} ${hours} * * *`
}
