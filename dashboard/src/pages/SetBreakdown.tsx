import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Session, Question, QuestionnaireSet } from '../types'

interface Props {
  date: string
}

export default function SetBreakdown({ date }: Props) {
  const [sets, setSets] = useState<QuestionnaireSet[]>([])
  const [selectedSetId, setSelectedSetId] = useState<string>('')
  const [questions, setQuestions] = useState<Question[]>([])
  const [rows, setRows] = useState<{ name: string; answers: Map<string, string> }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase
      .from('questionnaire_sets')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('schedule_time', { ascending: true })
      .then(({ data }) => {
        if (data) setSets(data as QuestionnaireSet[])
      })
  }, [])

  useEffect(() => {
    if (!selectedSetId) return
    async function load() {
      setLoading(true)

      const [{ data: qs }, { data: sessions }] = await Promise.all([
        supabase
          .from('questions')
          .select('*')
          .eq('set_id', selectedSetId)
          .order('sort_order', { ascending: true }),
        supabase
          .from('sessions')
          .select('*')
          .gte('started_at', `${date}T00:00:00+00:00`)
          .lte('started_at', `${date}T23:59:59+00:00`),
      ])

      if (!qs || !sessions) { setLoading(false); return }

      const qList = qs as Question[]
      const qIds = new Set(qList.map(q => q.question_id))

      const recipientMap = new Map<string, { name: string; answers: Map<string, string> }>()

      for (const session of sessions as Session[]) {
        for (const resp of session.responses) {
          if (!qIds.has(resp.questionId)) continue
          if (!recipientMap.has(session.recipient)) {
            recipientMap.set(session.recipient, {
              name: session.recipient_name,
              answers: new Map(),
            })
          }
          recipientMap.get(session.recipient)!.answers.set(resp.questionId, resp.answer)
        }
      }

      setQuestions(qList)
      setRows([...recipientMap.values()])
      setLoading(false)
    }
    load()
  }, [selectedSetId, date])

  return (
    <div>
      <div className="set-selector">
        <label>Select category</label>
        <select value={selectedSetId} onChange={e => setSelectedSetId(e.target.value)}>
          <option value="">— choose —</option>
          {sets.map(s => (
            <option key={s.id} value={s.id}>{s.title_en}</option>
          ))}
        </select>
      </div>

      {loading && <div className="loading">Loading...</div>}

      {!loading && selectedSetId && rows.length === 0 && (
        <div className="empty">No data for this category on {date}</div>
      )}

      {!loading && rows.length > 0 && (
        <div className="breakdown-table-wrap">
          <table className="breakdown-table">
            <thead>
              <tr>
                <th>Recipient</th>
                {questions.map(q => (
                  <th key={q.question_id} title={q.question}>
                    {q.question_en}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.name}>
                  <td className="recipient-cell">{row.name}</td>
                  {questions.map(q => {
                    const ans = row.answers.get(q.question_id) ?? '—'
                    return (
                      <td key={q.question_id} className="breakdown-answer">
                        <span className={`answer-badge ${ans === 'Yes' ? 'yes' : ans === 'No' ? 'no' : ''}`}>
                          {ans}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
