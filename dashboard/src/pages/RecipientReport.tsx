import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Session, Question, QuestionnaireSet } from '../types'

interface Props {
  recipient: string
  recipientName: string
  date: string
}

interface SetGroup {
  set: QuestionnaireSet
  answers: { question: Question; answer: string; answeredAt: string }[]
}

export default function RecipientReport({ recipient, recipientName, date }: Props) {
  const [groups, setGroups] = useState<SetGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)

      const [{ data: sessions }, { data: questions }, { data: sets }] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .eq('recipient', recipient)
          .gte('started_at', `${date}T00:00:00+00:00`)
          .lte('started_at', `${date}T23:59:59+00:00`)
          .order('started_at', { ascending: true }),
        supabase.from('questions').select('*'),
        supabase.from('questionnaire_sets').select('*'),
      ])

      if (!sessions || !questions || !sets) { setLoading(false); return }

      const questionMap = new Map<string, Question>(
        (questions as Question[]).map(q => [q.question_id, q])
      )
      const setMap = new Map<string, QuestionnaireSet>(
        (sets as QuestionnaireSet[]).map(s => [s.id, s])
      )

      const groupMap = new Map<string, SetGroup>()

      for (const session of sessions as Session[]) {
        for (const resp of session.responses) {
          const q = questionMap.get(resp.questionId)
          if (!q) continue
          const set = setMap.get(q.set_id)
          if (!set) continue

          if (!groupMap.has(set.id)) {
            groupMap.set(set.id, { set, answers: [] })
          }
          groupMap.get(set.id)!.answers.push({ question: q, answer: resp.answer, answeredAt: resp.answeredAt })
        }
      }

      // sort groups by set sort_order
      const sorted = [...groupMap.values()].sort((a, b) =>
        a.set.sort_order - b.set.sort_order
      )
      setGroups(sorted)
      setLoading(false)
    }
    load()
  }, [recipient, date])

  if (loading) return <div className="loading">Loading...</div>
  if (groups.length === 0) return <div className="empty">No data found for {recipientName} on {date}</div>

  return (
    <div className="report">
      <h2 className="report-title">{recipientName} — {date}</h2>
      {groups.map(({ set, answers }) => (
        <div key={set.id} className="set-block">
          <div className="set-header">
            <span className="set-title-en">{set.title_en}</span>
            <span className="set-title-ml">{set.title}</span>
          </div>
          <table className="answer-table">
            <tbody>
              {answers.map(({ question: q, answer, answeredAt }) => (
                <tr key={q.question_id}>
                  <td className="q-cell">
                    <div className="q-en">{q.question_en}</div>
                    <div className="q-ml">{q.question}</div>
                  </td>
                  <td className="a-cell">
                    <span className={`answer-badge ${answer === 'Yes' ? 'yes' : answer === 'No' ? 'no' : ''}`}>
                      {answer}
                    </span>
                  </td>
                  <td className="time-cell">
                    {new Date(answeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
