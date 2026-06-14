import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Session } from '../types'

interface Props {
  date: string
  onSelectRecipient: (recipient: string, name: string) => void
}

interface RecipientSummary {
  recipient: string
  name: string
  sessions: Session[]
}

export default function DailyOverview({ date, onSelectRecipient }: Props) {
  const [summaries, setSummaries] = useState<RecipientSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .gte('started_at', `${date}T00:00:00+00:00`)
        .lte('started_at', `${date}T23:59:59+00:00`)
        .order('started_at', { ascending: true })

      if (error) { console.error(error); setLoading(false); return }

      const map = new Map<string, RecipientSummary>()
      for (const s of (data as Session[])) {
        if (!map.has(s.recipient)) {
          map.set(s.recipient, { recipient: s.recipient, name: s.recipient_name, sessions: [] })
        }
        map.get(s.recipient)!.sessions.push(s)
      }
      setSummaries([...map.values()])
      setLoading(false)
    }
    load()
  }, [date])

  if (loading) return <div className="loading">Loading...</div>
  if (summaries.length === 0) return <div className="empty">No sessions found for {date}</div>

  return (
    <div className="grid">
      {summaries.map(s => (
        <div key={s.recipient} className="card" onClick={() => onSelectRecipient(s.recipient, s.name)}>
          <div className="card-header">
            <h2>{s.name}</h2>
            <span className="badge">{s.sessions.length} set{s.sessions.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="card-meta">
            <span>{s.sessions.reduce((n, sess) => n + sess.responses.length, 0)} answers</span>
            <span>
              {new Date(s.sessions[0].started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' – '}
              {new Date(s.sessions[s.sessions.length - 1].completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="card-footer">View full report →</div>
        </div>
      ))}
    </div>
  )
}
