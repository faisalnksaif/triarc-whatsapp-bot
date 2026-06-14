import 'dotenv/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import type { QuestionnaireSet } from '../src/types.js'

const url = process.env.SUPABASE_URL!
const key = process.env.SUPABASE_KEY!
const supabase = createClient(url, key)

const sets: QuestionnaireSet[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'data/questions.json'), 'utf-8')
)

for (const set of sets) {
  const { data, error } = await supabase
    .from('questionnaire_sets')
    .insert({ title: set.title, title_en: set.title_en, schedule_time: set.scheduleTime })
    .select('id')
    .single()

  if (error) {
    console.error(`Failed to insert set "${set.title}":`, error.message)
    process.exit(1)
  }

  const rows = set.questions.map((q, i) => ({
    set_id: data.id,
    question_id: q.id,
    question: q.question,
    question_en: q.question_en,
    type: q.type,
    options: q.options ?? null,
    sort_order: i,
  }))

  const { error: qErr } = await supabase.from('questions').insert(rows)
  if (qErr) {
    console.error(`Failed to insert questions for "${set.title}":`, qErr.message)
    process.exit(1)
  }

  console.log(`✅ Migrated "${set.title}" (${rows.length} questions)`)
}

console.log('\nMigration complete.')
