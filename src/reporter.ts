import { supabase } from './db.js'
import { answerQuestion, type RecipientData } from './ai.js'
import type { Answer } from './types.js'
import type { ReportQuery } from './commands.js'

export async function generateReport(query: ReportQuery): Promise<string[]> {
  const { startDate, endDate, recipientFilter, label } = query
  const isMultiDay = startDate !== endDate

  const [{ data: sessions, error: sErr }, { data: questions, error: qErr }, { data: sets, error: setErr }] =
    await Promise.all([
      supabase
        .from('sessions')
        .select('*')
        .gte('started_at', `${startDate}T00:00:00+00:00`)
        .lte('started_at', `${endDate}T23:59:59+00:00`)
        .order('started_at', { ascending: true }),
      supabase.from('questions').select('*'),
      supabase.from('questionnaire_sets').select('*').order('schedule_time', { ascending: true }),
    ])

  if (sErr || qErr || setErr) {
    throw new Error(`Supabase error: ${sErr?.message ?? qErr?.message ?? setErr?.message}`)
  }

  if (!sessions || sessions.length === 0) {
    return [`📋 No reports found for *${label}*${recipientFilter ? ` (${recipientFilter})` : ''}.`]
  }

  const questionMap = new Map<string, { question_en: string; set_id: string }>(
    (questions ?? []).map((q: any) => [q.question_id, { question_en: q.question_en, set_id: q.set_id }])
  )
  const setMap = new Map<string, { title_en: string; schedule_time: string }>(
    (sets ?? []).map((s: any) => [s.id, { title_en: s.title_en, schedule_time: s.schedule_time }])
  )

  // Group sessions by recipient
  const recipientMap = new Map<string, { name: string; sessions: any[] }>()
  for (const s of sessions) {
    if (recipientFilter && !s.recipient_name.toLowerCase().includes(recipientFilter.toLowerCase())) continue
    if (!recipientMap.has(s.recipient)) {
      recipientMap.set(s.recipient, { name: s.recipient_name, sessions: [] })
    }
    recipientMap.get(s.recipient)!.sessions.push(s)
  }

  if (recipientMap.size === 0) {
    return [`📋 No data found for *${recipientFilter}* in *${label}*.`]
  }

  function buildRecipientData(name: string, rSessions: any[]): RecipientData {
    const groupMap = new Map<string, { title_en: string; schedule_time: string; qa: { question: string; answer: string }[] }>()

    for (const session of rSessions) {
      for (const resp of session.responses as Answer[]) {
        const q = questionMap.get(resp.questionId)
        if (!q) continue
        const set = setMap.get(q.set_id)
        if (!set) continue
        if (!groupMap.has(q.set_id)) {
          groupMap.set(q.set_id, { title_en: set.title_en, schedule_time: set.schedule_time, qa: [] })
        }
        groupMap.get(q.set_id)!.qa.push({ question: q.question_en, answer: resp.answer, contactName: resp.contactName ?? '' })
      }
    }

    const sortedSets = [...groupMap.values()]
      .sort((a, b) => a.schedule_time.localeCompare(b.schedule_time))
      .map(s => ({ category: s.title_en, qa: s.qa }))

    return { name, label, sets: sortedSets }
  }

  const allRecipients = [...recipientMap.values()]
  const recipientDataList = allRecipients.map(({ name, sessions: s }) => buildRecipientData(name, s))

  console.log(`[reporter] Answering "${query.question}" — ${label}, ${allRecipients.length} recipient(s)`)
  const answer = await answerQuestion(query.question, recipientDataList, label)
  return [answer]
}
