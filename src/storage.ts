import { supabase } from './db.js'
import type { SessionRecord } from './types.js'

export function generateSessionId(): string {
  return `session_${new Date().toISOString().replace(/[:.]/g, '-')}`
}

export async function saveSession(record: SessionRecord): Promise<void> {
  const { error } = await supabase.from('sessions').insert({
    session_id: record.sessionId,
    recipient: record.recipient,
    recipient_name: record.recipientName,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    responses: record.responses,
  })

  if (error) throw new Error(`[storage] Failed to save session: ${error.message}`)
  console.log(`[storage] Session saved: ${record.sessionId}`)
}
