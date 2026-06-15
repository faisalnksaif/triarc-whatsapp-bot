import { createRequire } from 'module'
const { Client, LocalAuth, Poll } = createRequire(import.meta.url)('whatsapp-web.js')
import qrcode from 'qrcode-terminal'
import { resolve } from 'path'
import { toJid } from './config.js'
import { scheduleQuestionnaire } from './scheduler.js'
import { Questionnaire } from './questionnaire.js'
import { saveSession, upsertActiveSession, clearActiveSession, loadActiveSessions, saveLangPref, loadLangPrefs } from './storage.js'
import { generateReport } from './reporter.js'
import { parseReportIntent } from './ai.js'
import type { BotConfig, QuestionnaireSet } from './types.js'

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
  // Timestamp until which fromMe messages in the admin group should be ignored.
  // Extended on every bot send to prevent feedback loops (message_create fires before sendMessage resolves).
  let adminSendBlockedUntil = 0

  function todayLocal(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone })
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

    const sendText = async (text: string): Promise<void> => {
      await client.sendMessage(targetJid, text)
    }

    const sendChoices = async (question: string, options: string[]): Promise<void> => {
      try {
        const poll = new Poll(question, options, { allowMultipleAnswers: false })
        const sent = await client.sendMessage(targetJid, poll)
        pendingPolls.set(sent.id._serialized, targetJid)
      } catch (err) {
        console.error('[bot] Poll send failed, falling back to text:', err)
        const optionList = options.map((o, i) => `${i + 1}. ${o}`).join('\n')
        await sendText(`${question}\n\n${optionList}\n\n_Reply with a number_`)
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
            const [first, ...rest] = timeSets
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

  // ── incoming messages ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMessage = async (msg: any): Promise<void> => {
    const text: string = msg.body ?? ''
    const fromJid: string = msg.from

    console.log(`[bot:debug] msg from=${fromJid} fromMe=${msg.fromMe} body="${text.slice(0, 60)}"`)

    // !start in any chat → start first questionnaire set targeting that chat
    if (text.trim() === '!start') {
      console.log(`[bot] Manual trigger — starting questionnaire for ${fromJid}`)
      startSession(fromJid, sets[0]).catch(err => console.error('[bot] startSession error:', err))
      return
    }

    // !report [YYYY-MM-DD] in admin group → send WhatsApp report
    const adminGroup = config.adminGroup ? toJid(config.adminGroup) : null
    const jidNum = (j: string) => j.split('@')[0]
    const isAdminGroup = adminGroup != null && jidNum(fromJid) === jidNum(adminGroup)

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
    await session.handleTextReply(text, contactName)
  }

  // message = received from others; message_create = sent by this client (owner trigger)
  client.on('message', handleMessage)
  client.on('message_create', (msg: any) => { if (msg.fromMe) handleMessage(msg) })

  await client.initialize()
}
