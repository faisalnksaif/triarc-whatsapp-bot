import { supabase } from './db.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { SessionRecord, PersistedSession } from './types.js'

// ── Language preference cache (persisted across restarts) ───────────────────

type LangPrefs = Record<string, { lang: 'en' | 'ml'; date: string }>

const LANG_PREFS_PATH = resolve(process.cwd(), 'lang-prefs.json')

function readLangPrefs(): LangPrefs {
  try {
    if (!existsSync(LANG_PREFS_PATH)) return {}
    return JSON.parse(readFileSync(LANG_PREFS_PATH, 'utf8')) as LangPrefs
  } catch {
    return {}
  }
}

export function saveLangPref(jid: string, lang: 'en' | 'ml', date: string): void {
  const prefs = readLangPrefs()
  prefs[jid] = { lang, date }
  try {
    writeFileSync(LANG_PREFS_PATH, JSON.stringify(prefs, null, 2))
  } catch (err) {
    console.error('[storage] Failed to save lang pref:', err)
  }
}

export function loadLangPrefs(): LangPrefs {
  return readLangPrefs()
}

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

export async function upsertActiveSession(s: PersistedSession): Promise<void> {
  const { error } = await supabase.from('active_sessions').upsert({
    jid: s.jid,
    recipient_name: s.recipientName,
    set_title: s.setTitle ?? null,
    set_title_en: s.setTitleEn ?? null,
    questions: s.questions,
    responses: s.responses,
    pending_ids: s.pendingIds,
    lang: s.lang ?? null,
    started_at: s.startedAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'jid' })
  if (error) console.error('[storage] Failed to persist active session:', error.message)
}

export async function clearActiveSession(jid: string): Promise<void> {
  const { error } = await supabase.from('active_sessions').delete().eq('jid', jid)
  if (error) console.error('[storage] Failed to clear active session:', error.message)
}

export async function loadActiveSessions(): Promise<PersistedSession[]> {
  const { data, error } = await supabase.from('active_sessions').select('*')
  if (error) {
    console.error('[storage] Failed to load active sessions:', error.message)
    return []
  }
  return (data ?? []).map((r: any) => ({
    jid: r.jid,
    recipientName: r.recipient_name,
    setTitle: r.set_title ?? undefined,
    setTitleEn: r.set_title_en ?? undefined,
    questions: r.questions,
    responses: r.responses,
    pendingIds: r.pending_ids ?? [],
    lang: r.lang ?? null,
    startedAt: r.started_at,
  }))
}
