import { createRequire } from 'module'
const { Client, LocalAuth, Poll } = createRequire(import.meta.url)('whatsapp-web.js')
import qrcode from 'qrcode-terminal'
import { resolve } from 'path'
import { toJid } from './config.js'
import { scheduleQuestionnaire } from './scheduler.js'
import { Questionnaire } from './questionnaire.js'
import { saveSession, upsertActiveSession, clearActiveSession, loadActiveSessions, saveLangPref, loadLangPrefs, saveRecipientSchedule, loadRecipientSchedules } from './storage.js'
import type { RecipientSchedule } from './storage.js'
import { generateReport } from './reporter.js'
import { parseReportIntent } from './ai.js'
import type { BotConfig, QuestionnaireSet } from './types.js'

interface SetConfigState {
  allSets: QuestionnaireSet[]
  nextBatch: number      // index of the next batch to send (0-based)
  totalBatches: number
  pollIds: string[]      // sent poll message IDs, in order
  selections: Map<string, string[]>  // pollId → selected set titles
}

export async function startBot(config: BotConfig, sets: QuestionnaireSet[]): Promise<void> {
  const scheduledJids = config.recipients.map(toJid)
  let cronRegistered = false

  // keyed by JID — one active session per recipient at a time
  const activeSessions = new Map<string, Questionnaire>()
  // keyed by poll message ID → JID, so vote_update can find the right session
  const pendingPolls = new Map<string, string>()
  // queued sets per JID — worked through one by one after the active session finishes
  const sessionQueues = new Map<string, QuestionnaireSet[]>()
  // language preference per JID — cached for the current day, reset at midnight
  const langCache = new Map<string, { lang: 'en' | 'ml'; date: string }>()
  // tracks whether the warm greeting has been sent to this JID today
  const greetedCache = new Map<string, string>()
  // messages to delete when a session completes — keyed by JID
  const sessionMessages = new Map<string, any[]>()
  // per-JID schedule override: which set IDs to send and from when
  const recipientSchedules = new Map<string, RecipientSchedule>()
  // !q multi-batch poll flow state per JID
  const pendingSetConfig = new Map<string, SetConfigState>()
  // Timestamp until which fromMe messages in the admin group should be ignored.
  // Extended on every bot send to prevent feedback loops (message_create fires before sendMessage resolves).
  let adminSendBlockedUntil = 0

  function todayLocal(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone })
  }

  function tomorrowLocal(): string {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toLocaleDateString('en-CA', { timeZone: config.timezone })
  }

  function getCachedLang(jid: string): 'en' | 'ml' | undefined {
    const entry = langCache.get(jid)
    if (!entry) return undefined
    return entry.date === todayLocal() ? entry.lang : undefined
  }

  function hasGreetedToday(jid: string): boolean {
    return greetedCache.get(jid) === todayLocal()
  }

  function markGreeted(jid: string): void {
    greetedCache.set(jid, todayLocal())
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: resolve(process.cwd(), 'auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })

  function processQueue(targetJid: string): void {
    const queue = sessionQueues.get(targetJid)
    if (!queue || queue.length === 0) return
    const next = queue.shift()!
    startSession(targetJid, next).catch(err => console.error('[bot] Queue startSession error:', err))
  }

  async function startSession(targetJid: string, set: QuestionnaireSet): Promise<void> {
    if (activeSessions.get(targetJid)?.isActive()) {
      console.log(`[bot] Session already active for ${targetJid} — queueing "${set.title}"`)
      const queue = sessionQueues.get(targetJid) ?? []
      queue.push(set)
      sessionQueues.set(targetJid, queue)
      return
    }

    const configRecipient = config.recipients.find(r => toJid(r) === targetJid)
    let recipientName = configRecipient?.name ?? targetJid
    if (!configRecipient?.name) {
      try {
        const contact = await client.getContactById(targetJid)
        recipientName = contact.name || contact.pushname || contact.number || targetJid
      } catch {
        // non-fatal — fall back to JID
      }
    }

    sessionMessages.set(targetJid, [])
    const trackSent = (msg: any) => sessionMessages.get(targetJid)?.push(msg)

    const sendText = async (text: string): Promise<void> => {
      const msg = await client.sendMessage(targetJid, text)
      trackSent(msg)
    }

    const sendChoices = async (question: string, options: string[]): Promise<void> => {
      try {
        const poll = new Poll(question, options, { allowMultipleAnswers: false })
        const sent = await client.sendMessage(targetJid, poll)
        pendingPolls.set(sent.id._serialized, targetJid)
        trackSent(sent)
      } catch (err) {
        console.error('[bot] Poll send failed, falling back to text:', err)
        const optionList = options.map((o, i) => `${i + 1}. ${o}`).join('\n')
        await sendText(`${question}\n\n${optionList}\n\n_Reply with a number_`)
      }
    }

    const deleteSessionMessages = async () => {
      const msgs = sessionMessages.get(targetJid) ?? []
      sessionMessages.delete(targetJid)
      for (const msg of msgs) {
        await msg.delete(true).catch(() => {})
      }
    }

    const questionnaire = new Questionnaire(
      set.questions,
      targetJid,
      recipientName,
      async (record) => { await saveSession(record); await clearActiveSession(targetJid) },
      sendText,
      sendChoices,
      () => {
        activeSessions.delete(targetJid)
        deleteSessionMessages().catch(err => console.error('[bot] Failed to delete session messages:', err))
        processQueue(targetJid)
      },
      getCachedLang(targetJid),
      (lang) => { const d = todayLocal(); langCache.set(targetJid, { lang, date: d }); saveLangPref(targetJid, lang, d) },
      set.title,
      set.title_en,
      config.timezone,
      hasGreetedToday(targetJid),
      (state) => upsertActiveSession({
        jid: targetJid,
        recipientName,
        setTitle: set.title,
        setTitleEn: set.title_en,
        questions: set.questions,
        responses: state.responses,
        pendingIds: state.pendingIds,
        lang: state.lang,
        startedAt: new Date().toISOString(),
      }),
    )
    markGreeted(targetJid)

    activeSessions.set(targetJid, questionnaire)
    questionnaire.start().catch(err => {
      console.error('[bot] Failed to start questionnaire:', err)
      activeSessions.delete(targetJid)
      processQueue(targetJid)
    })
  }

  // ── connection events ───────────────────────────────────────────────────────

  client.on('qr', (qr: string) => {
    process.stdout.write('\n\n')
    process.stdout.write('='.repeat(60) + '\n')
    process.stdout.write('  SCAN THIS QR CODE IN WHATSAPP\n')
    process.stdout.write('  (Settings → Linked Devices → Link a Device)\n')
    process.stdout.write('='.repeat(60) + '\n\n')
    qrcode.generate(qr, { small: true })
    process.stdout.write('\n' + '='.repeat(60) + '\n\n')
  })

  client.on('ready', async () => {
    const name = client.info.pushname ?? client.info.wid.user
    console.log(`[bot] ✅ Connected to WhatsApp as ${name}`)
    console.log(`[bot] Scheduled recipients: ${scheduledJids.join(', ')}`)

    if (!cronRegistered) {
      const setsByTime = new Map<string, QuestionnaireSet[]>()
      for (const set of sets) {
        const group = setsByTime.get(set.scheduleTime) ?? []
        group.push(set)
        setsByTime.set(set.scheduleTime, group)
      }

      for (const [time, timeSets] of setsByTime) {
        scheduleQuestionnaire(time, config.timezone, async () => {
          for (const jid of scheduledJids) {
            const schedule = recipientSchedules.get(jid)
            const now = todayLocal()
            const setsForJid = (schedule && schedule.effectiveFrom <= now)
              ? timeSets.filter(s => schedule.setIds.includes(s.id))
              : timeSets
            if (setsForJid.length === 0) continue
            const [first, ...rest] = setsForJid
            if (rest.length > 0) {
              const queue = sessionQueues.get(jid) ?? []
              sessionQueues.set(jid, [...queue, ...rest])
            }
            await startSession(jid, first)
          }
        })
      }
      cronRegistered = true
    }

    // Load per-recipient schedule overrides
    for (const s of await loadRecipientSchedules()) {
      recipientSchedules.set(s.jid, s)
    }
    console.log(`[bot] Loaded ${recipientSchedules.size} recipient schedule override(s)`)

    // Warm up in-memory lang cache from file so restarts don't re-ask language today
    const today = todayLocal()
    for (const [jid, entry] of Object.entries(loadLangPrefs())) {
      if (entry.date === today) langCache.set(jid, entry)
    }

    // Restore any sessions that were active when the bot last stopped
    const allPersisted = await loadActiveSessions()
    const stale = allPersisted.filter(p => {
      const startedDate = new Date(p.startedAt).toLocaleDateString('en-CA', { timeZone: config.timezone })
      return startedDate !== today
    })
    for (const p of stale) {
      console.log(`[bot] Discarding stale session for ${p.jid} (started ${p.startedAt})`)
      await clearActiveSession(p.jid)
    }
    const persisted = allPersisted.filter(p => {
      const startedDate = new Date(p.startedAt).toLocaleDateString('en-CA', { timeZone: config.timezone })
      return startedDate === today
    })
    if (persisted.length > 0) {
      console.log(`[bot] Restoring ${persisted.length} interrupted session(s)...`)
      for (const p of persisted) {
        if (activeSessions.has(p.jid)) continue  // already running (shouldn't happen, but guard)

        const sendText = async (text: string) => { await client.sendMessage(p.jid, text) }
        const sendChoices = async (question: string, options: string[]) => {
          try {
            const poll = new Poll(question, options, { allowMultipleAnswers: false })
            const sent = await client.sendMessage(p.jid, poll)
            pendingPolls.set(sent.id._serialized, p.jid)
          } catch {
            const optionList = options.map((o, i) => `${i + 1}. ${o}`).join('\n')
            await sendText(`${question}\n\n${optionList}\n\n_Reply with a number_`)
          }
        }

        const questionnaire = new Questionnaire(
          p.questions,
          p.jid,
          p.recipientName,
          async (record) => { await saveSession(record); await clearActiveSession(p.jid) },
          sendText,
          sendChoices,
          () => {
            activeSessions.delete(p.jid)
            processQueue(p.jid)
          },
          p.lang ?? undefined,
          (lang) => langCache.set(p.jid, { lang, date: todayLocal() }),
          p.setTitle,
          p.setTitleEn,
          config.timezone,
          true,  // treat as queued (no full greeting)
          (state) => upsertActiveSession({ ...p, responses: state.responses, pendingIds: state.pendingIds, lang: state.lang }),
        )

        if (p.lang) langCache.set(p.jid, { lang: p.lang, date: todayLocal() })
        markGreeted(p.jid)
        activeSessions.set(p.jid, questionnaire)
        questionnaire.resume(p).catch(err => {
          console.error(`[bot] Failed to resume session for ${p.jid}:`, err)
          activeSessions.delete(p.jid)
        })
      }
    }
  })

  client.on('auth_failure', (msg: string) => {
    console.error(`[bot] Auth failed: ${msg}. Delete the auth/ folder and restart to re-link.`)
    process.exit(1)
  })

  client.on('disconnected', async (reason: string) => {
    console.log(`[bot] Disconnected (${reason}). Reinitialising...`)
    try {
      await client.initialize()
    } catch (err) {
      console.error('[bot] Reinitialise failed:', err)
    }
  })

  // ── poll votes ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client.on('vote_update', async (vote: any) => {
    const pollId: string = vote.parentMessage?.id?._serialized ?? ''

    // Set-config polls (from !q batches) — accumulate selections per poll
    for (const [jid, state] of pendingSetConfig) {
      if (state.pollIds.includes(pollId)) {
        const selected: string[] = (vote.selectedOptions ?? []).map((o: any) => o.name as string)
        state.selections.set(pollId, selected)
        console.log(`[bot] Set-config vote for ${jid} poll ${pollId}: [${selected.join(', ')}]`)
        return
      }
    }

    const targetJid = pendingPolls.get(pollId)
    if (!targetJid) return

    const selected: string = vote.selectedOptions?.[0]?.name ?? ''
    if (!selected) return

    const voterJid: string = vote.voter ?? ''
    let contactName = voterJid
    try {
      const contact = await client.getContactById(voterJid)
      contactName = contact.name || contact.pushname || contact.number || voterJid
    } catch {
      // non-fatal
    }

    console.log(`[bot] Poll vote from ${contactName}: "${selected}"`)
    pendingPolls.delete(pollId)

    const session = activeSessions.get(targetJid)
    if (session) await session.handleTextReply(selected, contactName)
  })

  // ── set-config batch helper ─────────────────────────────────────────────────

  async function sendSetBatch(targetJid: string, state: SetConfigState): Promise<void> {
    const batchNum = state.nextBatch
    const start = batchNum * 10
    const batch = state.allSets.slice(start, start + 10)
    const label = `${batchNum + 1}/${state.totalBatches}`
    const poll = new Poll(`Select question sets (${label}):`, batch.map(s => s.title_en), { allowMultipleAnswers: true })
    const sent = await client.sendMessage(targetJid, poll)
    state.pollIds.push(sent.id._serialized)
    state.nextBatch++
    if (state.nextBatch < state.totalBatches) {
      await client.sendMessage(targetJid, `_Batch ${label} sent. Type *!n* for the next batch, or *!finish* when done selecting._`)
    } else {
      await client.sendMessage(targetJid, `_Batch ${label} sent (last batch). Type *!finish* to save your selection._`)
    }
  }

  // ── incoming messages ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMessage = async (msg: any): Promise<void> => {
    const text: string = msg.body ?? ''
    const fromJid: string = msg.from

    // Always log every message so we can diagnose command delivery in production
    const msgSender = msg.fromMe ? 'me' : (msg.author ?? msg.from)
    console.log(`[bot:msg] sender=${msgSender} chat=${msg.from} fromMe=${msg.fromMe} isAdmin=${isAdmin()} body="${text.slice(0, 80)}"`)

    // Helper: resolve canonical group JID (works for both fromMe and admin senders)
    async function resolveTargetJid(): Promise<string | null> {
      try {
        const chat = await msg.getChat()
        return chat.id._serialized
      } catch { return null }
    }

    // Helper: is the sender a configured admin?
    function isAdmin(): boolean {
      const adminJids = (config.admins ?? []).map(toJid)
      const sender = msg.fromMe ? null : (msg.author ?? msg.from)
      if (!sender) return false
      const senderNum = sender.split('@')[0]
      return adminJids.some(j => j.split('@')[0] === senderNum)
    }

    const isAuthorized = msg.fromMe || isAdmin()

    // !q — start multi-batch poll flow (owner or admin only)
    if (text.trim() === '!q' && isAuthorized) {
      console.log(`[bot] !q received — fromMe=${msg.fromMe} from=${msg.from} author=${msg.author}`)
      const targetJid = await resolveTargetJid()
      if (!targetJid) { console.error('[bot] !q: could not resolve chat JID'); return }
      console.log(`[bot] !q — targeting JID ${targetJid}, sets available: ${sets.length}`)
      if (sets.length === 0) {
        await client.sendMessage(targetJid, '⚠️ No questionnaire sets available.')
        return
      }
      const totalBatches = Math.ceil(sets.length / 10)
      const state: SetConfigState = { allSets: sets, nextBatch: 0, totalBatches, pollIds: [], selections: new Map() }
      pendingSetConfig.set(targetJid, state)
      await sendSetBatch(targetJid, state)
      return
    }

    // !n — send next batch in the poll flow (owner or admin only)
    if (text.trim() === '!n' && isAuthorized) {
      console.log(`[bot] !n received — fromMe=${msg.fromMe} from=${msg.from}`)
      const targetJid = await resolveTargetJid()
      if (!targetJid) return
      const state = pendingSetConfig.get(targetJid)
      if (!state) {
        await client.sendMessage(targetJid, '⚠️ No active set selection. Type *!q* to start.')
        return
      }
      if (state.nextBatch >= state.totalBatches) {
        await client.sendMessage(targetJid, `_All ${state.totalBatches} batch(es) sent. Type *!finish* to save._`)
        return
      }
      await sendSetBatch(targetJid, state)
      return
    }

    // !finish — collect votes from all batches and save schedule (owner or admin only)
    if (text.trim() === '!finish' && isAuthorized) {
      const targetJid = await resolveTargetJid()
      if (!targetJid) return
      const state = pendingSetConfig.get(targetJid)
      if (!state) return
      const selectedTitles = new Set<string>()
      for (const titles of state.selections.values()) {
        for (const t of titles) selectedTitles.add(t)
      }
      const matched = state.allSets.filter(s => selectedTitles.has(s.title_en))
      if (matched.length === 0) {
        await client.sendMessage(targetJid, '⚠️ No sets selected. Pick from the polls first, then type *!finish*.')
        return
      }
      const effectiveFrom = tomorrowLocal()
      const setIds = matched.map(s => s.id)
      await saveRecipientSchedule(targetJid, setIds, effectiveFrom)
      recipientSchedules.set(targetJid, { jid: targetJid, setIds, effectiveFrom })
      pendingSetConfig.delete(targetJid)
      const names = matched.map(s => `• ${s.title_en}`).join('\n')
      await client.sendMessage(targetJid, `✅ Schedule saved! From tomorrow (${effectiveFrom}) this group will receive:\n${names}`)
      return
    }

    if (process.env.NODE_ENV !== 'production') {
      let chatLabel = fromJid
      try {
        const chat = await msg.getChat()
        chatLabel = `${chat.name} (${chat.id._serialized})`
      } catch { /* non-fatal */ }
      console.log(`[bot:msg] from=${chatLabel} fromMe=${msg.fromMe} body="${text.slice(0, 80)}"`)
    }

    // !start in any chat → start first questionnaire set targeting that chat
    if (text.trim() === '!start') {
      console.log(`[bot] Manual trigger — starting questionnaire for ${fromJid}`)
      startSession(fromJid, sets[0]).catch(err => console.error('[bot] startSession error:', err))
      return
    }

    // !report [YYYY-MM-DD] in admin group → send WhatsApp report
    const adminGroup = config.adminGroup ? toJid(config.adminGroup) : null
    const jidNum = (j: string) => j.split('@')[0]
    // For fromMe messages msg.from is always the bot owner's @lid JID — use msg.to (the actual chat)
    const chatJidForAdminCheck = msg.fromMe ? (msg.to || msg.from) : msg.from
    const isAdminGroup = adminGroup != null && jidNum(chatJidForAdminCheck) === jidNum(adminGroup)

    // Skip bot's own messages in the admin group during the cooldown window.
    if (isAdminGroup && msg.fromMe && Date.now() < adminSendBlockedUntil) {
      return
    }

    if (isAdminGroup && text.trim().length > 0) {
      // Resolve the chat object so we get the canonical @g.us JID — sendMessage with @lid JIDs
      // doesn't route to groups correctly in whatsapp-web.js.
      const chat = await msg.getChat()
      const adminChatId: string = chat.id._serialized
      const adminSend = async (body: string) => {
        adminSendBlockedUntil = Date.now() + 5000
        await client.sendMessage(adminChatId, body)
      }
      try {
        const query = await parseReportIntent(text.trim())
        console.log(`[bot] Report intent parsed: ${JSON.stringify(query)}`)
        const messages = await generateReport(query)
        for (const m of messages) {
          await adminSend(m)
        }
      } catch (err) {
        console.error('[bot] Report generation failed:', err)
        await adminSend(`❌ Failed to generate report: ${(err as Error).message}`)
      }
      return
    }

    // Ignore the bot's own outgoing messages for everything else
    if (msg.fromMe) return

    // Clean up any finished session for this JID
    const existing = activeSessions.get(fromJid)
    if (existing && !existing.isActive()) {
      activeSessions.delete(fromJid)
    }

    const session = activeSessions.get(fromJid)
    if (!session) {
      console.log(`[bot:debug] Ignoring msg — no active session for ${fromJid}`)
      return
    }

    if (!text.trim()) {
      console.log('[bot:debug] Ignoring msg — empty body')
      return
    }

    const isGroup = fromJid.endsWith('@g.us')
    const sender = isGroup ? (msg.author ?? fromJid) : fromJid
    let contactName = sender
    try {
      const contact = await msg.getContact()
      contactName = contact.name || contact.pushname || contact.number || sender
    } catch {
      // non-fatal
    }
    console.log(`[bot] Reply from ${contactName}: "${text.trim()}"`)
    sessionMessages.get(fromJid)?.push(msg)
    await session.handleTextReply(text, contactName)
  }

  // message = received from others; message_create = sent by this client (owner trigger)
  client.on('message', handleMessage)
  client.on('message_create', (msg: any) => { if (msg.fromMe) handleMessage(msg) })

  await client.initialize()
}
