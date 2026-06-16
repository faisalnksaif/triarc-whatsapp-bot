import 'dotenv/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_KEY!
const supabase = createClient(url, key)

interface RawQuestion {
  id: string
  question: string
  question_en: string
  type: string
  options?: string[]
  conditions?: Record<string, string[]>
}

interface RawSet {
  title: string
  title_en: string
  scheduleTime: string
  questions: RawQuestion[]
}

const sets: RawSet[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'data/questions.json'), 'utf-8')
)

console.log(`Loaded ${sets.length} sets, ${sets.reduce((n, s) => n + s.questions.length, 0)} questions total.\n`)

// ── 1. Clear existing data ──────────────────────────────────────────────────

console.log('Clearing existing data...')

const { error: qErr } = await supabase.from('questions').delete().not('id', 'is', null)
if (qErr) { console.error('Failed to clear questions:', qErr.message); process.exit(1) }

const { error: sErr } = await supabase.from('questionnaire_sets').delete().not('id', 'is', null)
if (sErr) { console.error('Failed to clear questionnaire_sets:', sErr.message); process.exit(1) }

const { error: rErr } = await supabase.from('recipient_schedules').delete().not('jid', 'is', null)
if (rErr) { console.error('Failed to clear recipient_schedules:', rErr.message); process.exit(1) }

console.log('Cleared questionnaire_sets, questions, and recipient_schedules.\n')

// ── 2. Insert new sets and questions ───────────────────────────────────────

for (const [idx, set] of sets.entries()) {
  const { data, error: insertSetErr } = await supabase
    .from('questionnaire_sets')
    .insert({ title: set.title, title_en: set.title_en, schedule_time: set.scheduleTime, sort_order: (idx + 1) * 10 })
    .select('id')
    .single()

  if (insertSetErr) {
    console.error(`Failed to insert set "${set.title_en}":`, insertSetErr.message)
    process.exit(1)
  }

  const rows = set.questions.map((q, i) => ({
    set_id: data.id,
    question_id: q.id,
    question: q.question,
    question_en: q.question_en,
    type: q.type,
    options: q.options ?? null,
    conditions: q.conditions ?? null,
    sort_order: (i + 1) * 10,
  }))

  const { error: insertQErr } = await supabase.from('questions').insert(rows)
  if (insertQErr) {
    console.error(`Failed to insert questions for "${set.title_en}":`, insertQErr.message)
    process.exit(1)
  }

  console.log(`✅  ${set.title_en} — ${rows.length} questions`)
}

console.log('\nMigration complete.')
