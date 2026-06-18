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
import { log, logError } from './logger.js'
import type { BotConfig, QuestionnaireSet } from './types.js'

interface DailyPollState {
  pollMsgs: any[]                            // message objects for deletion (multiple batches)
  pollSelections: Map<string, string[]>      // pollId → selected set IDs (to handle deselections)
  answered: boolean
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
  // daily (9 AM) poll state per JID: which sets they selected for today
  const dailyPollState = new Map<string, DailyPollState>()
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

  function getAggregatedSelections(pollState: DailyPollState): string[] {
    const allSelections = new Set<string>()
    for (const selections of pollState.pollSelections.values()) {
      for (const id of selections) {
        allSelections.add(id)
      }
    }
    return Array.from(allSelections)
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
      // Also delete the 9 AM poll messages if they exist
      const pollState = dailyPollState.get(targetJid)
      if (pollState?.pollMsgs) {
        for (const msg of pollState.pollMsgs) {
          await msg.delete(true).catch(() => {})
        }
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
          const jidsAwaitingPollResponse = new Set<string>()
          for (const jid of scheduledJids) {
            const pollState = dailyPollState.get(jid)
            if (pollState && !pollState.answered) {
              console.log(`[bot] Scheduled send for ${jid}: still awaiting poll response, will send reminder every 30m`)
              jidsAwaitingPollResponse.add(jid)
              continue
            }

            const selectedIds = pollState ? getAggregatedSelections(pollState) : []
            const setsToSend = selectedIds.length
              ? sets.filter(s => selectedIds.includes(s.id))
              : timeSets

            if (setsToSend.length === 0) continue
            const [first, ...rest] = setsToSend
            if (rest.length > 0) {
              const queue = sessionQueues.get(jid) ?? []
              sessionQueues.set(jid, [...queue, ...rest])
            }
            await startSession(jid, first)
          }

          // Set up reminders for those still waiting on poll
          if (jidsAwaitingPollResponse.size > 0) {
            const checkPollAnswers = async () => {
              for (const jid of jidsAwaitingPollResponse) {
                const pollState = dailyPollState.get(jid)
                if (!pollState || pollState.answered) {
                  jidsAwaitingPollResponse.delete(jid)
                  if (pollState?.answered) {
                    console.log(`[bot] ${jid} answered poll, starting questions`)
                    const setsToSend = sets.filter(s => pollState.pollSelections.includes(s.id))
                    if (setsToSend.length > 0) {
                      const [first, ...rest] = setsToSend
                      if (rest.length > 0) {
                        const queue = sessionQueues.get(jid) ?? []
                        sessionQueues.set(jid, [...queue, ...rest])
                      }
                      await startSession(jid, first)
                    }
                  }
                  continue
                }
                await client.sendMessage(jid, '⏰ _Reminder: Please select your question sets in the poll above._').catch((err: any) => {
                  console.error(`[bot] Failed to send reminder to ${jid}:`, err)
                })
              }
              if (jidsAwaitingPollResponse.size === 0) clearInterval(reminderInterval)
            }

            // Check every 2 minutes for responses (catches fast responders), then every 30 min if still waiting
            let checkCount = 0
            const reminderInterval = setInterval(async () => {
              await checkPollAnswers()
              checkCount++
              if (checkCount >= 15) {
                // After 30 minutes of 2-min checks, reduce frequency to every 30 min
                clearInterval(reminderInterval)
                setInterval(checkPollAnswers, 30 * 60 * 1000)
              }
            }, 2 * 60 * 1000)
          }
        })
      }
      cronRegistered = true

      // Daily poll: send set-selection polls to all recipients (split into batches of max 12 options)
      const pollTime = config.pollTime ?? '9:00'
      scheduleQuestionnaire(pollTime, config.timezone, async () => {
        log(`[bot] Daily poll trigger — sending set-selection polls to ${scheduledJids.length} recipients`)
        dailyPollState.clear()
        const allOptions = sets.map(s => s.title_en)
        const batchSize = 10
        const batches = []
        for (let i = 0; i < allOptions.length; i += batchSize) {
          batches.push(allOptions.slice(i, i + batchSize))
        }
        log(`[bot] Splitting ${allOptions.length} sets into ${batches.length} poll batch(es)`)

        for (const jid of scheduledJids) {
          const pollMsgs: any[] = []
          for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            try {
              const options = batches[batchIdx]
              const batchLabel = batches.length > 1 ? ` (${batchIdx + 1}/${batches.length})` : ''
              const question = `📋 Select which question sets you want today${batchLabel}:`
              log(`[bot] Sending poll batch ${batchIdx + 1}/${batches.length} to ${jid} with ${options.length} options`)
              const poll = new Poll(question, options, { allowMultipleAnswers: true })
              const sent = await client.sendMessage(jid, poll)
              pollMsgs.push(sent)
              log(`[bot] ✅ Poll batch ${batchIdx + 1} sent to ${jid}`)
              await new Promise(r => setTimeout(r, 500))
            } catch (err) {
              logError(`[bot] ❌ Failed to send poll batch ${batchIdx + 1} to ${jid}`, err)
            }
          }
          if (pollMsgs.length > 0) {
            dailyPollState.set(jid, {
              pollMsgs,
              pollSelections: [],
              answered: false,
            })
            log(`[bot] Poll state set for ${jid} with ${pollMsgs.length} batch(es)`)
            // Send instruction message
            await client.sendMessage(jid, '👆 Select which sets you want, then type *!finish* when done.').catch((err: any) => {
              logError(`[bot] Failed to send instruction message to ${jid}`, err)
            })
          }
        }
      })
    }

    // Load per-recipient schedule overrides
    for (const s of await loadRecipientSchedules()) {
      recipientSchedules.set(s.jid, s)
    }
    console.log(`[bot] Loaded ${recipientSchedules.size} recipient schedule override(s)`)

    // Send pending questions for recipients with schedule for today, but only if their scheduled time has passed
    const now = todayLocal()
    for (const [jid, schedule] of recipientSchedules) {
      if (schedule.effectiveFrom <= now) {
        const selectedSets = sets.filter(s => schedule.setIds.includes(s.id))
        // Only send sets whose scheduled time has already passed (in the configured timezone)
        const nowFormatted = new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: config.timezone,
          hour12: false
        })
        const [nowHour, nowMinute] = nowFormatted.split(':').map(Number)
        const nowInMinutes = nowHour * 60 + nowMinute

        const [readyToSend, futureRuns] = selectedSets.reduce(
          (acc, set) => {
            const [h, m] = set.scheduleTime.split(':').map(Number)
            const setTimeInMinutes = h * 60 + m
            return nowInMinutes >= setTimeInMinutes ? [acc[0].concat(set), acc[1]] : [acc[0], acc[1].concat(set)]
          },
          [[] as QuestionnaireSet[], [] as QuestionnaireSet[]]
        )
        if (readyToSend.length > 0) {
          const [first, ...rest] = readyToSend
          if (rest.length > 0) {
            const queue = sessionQueues.get(jid) ?? []
            sessionQueues.set(jid, [...queue, ...rest])
          }
          log(`[bot] Sending pending questions for ${jid} (${readyToSend.length} set(s), ${futureRuns.length} scheduled for later)`)
          await startSession(jid, first).catch(err => logError('[bot] Failed to start pending session:', err))
        } else if (futureRuns.length > 0) {
          log(`[bot] ${jid} has selections but all are scheduled for later (next: ${futureRuns[0].scheduleTime})`)
        }
      }
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

    // Daily (9 AM) set-selection polls (multiple batches per JID)
    for (const [jid, state] of dailyPollState) {
      const matchingPoll = state.pollMsgs.find(msg => msg.id._serialized === pollId)
      if (matchingPoll) {
        const selected: string[] = (vote.selectedOptions ?? []).map((o: any) => o.name as string)
        const selectedIds = sets.filter(s => selected.includes(s.title_en)).map(s => s.id)
        state.pollSelections.push(...selectedIds)
        state.answered = true
        log(`[bot] Daily poll vote for ${jid}: [${selected.join(', ')}] → total selected: ${state.pollSelections.length} set(s)`)
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

  // ── incoming messages ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMessage = async (msg: any): Promise<void> => {
    const text: string = msg.body ?? ''
    const fromJid: string = msg.from

    // Always log every message so we can diagnose command delivery in production
    const msgSender = msg.fromMe ? 'me' : (msg.author ?? msg.from)
    console.log(`[bot:msg] sender=${msgSender} chat=${msg.from} fromMe=${msg.fromMe} isAdmin=${isAdmin()} body="${text.slice(0, 80)}"`)

    // Helper: is the sender a configured admin?
    function isAdmin(): boolean {
      const adminJids = (config.admins ?? []).map(toJid)
      const sender = msg.fromMe ? null : (msg.author ?? msg.from)
      if (!sender) return false
      const senderNum = sender.split('@')[0]
      return adminJids.some(j => j.split('@')[0] === senderNum)
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

    // !finish — finalize daily poll selections and store in database
    if (text.trim() === '!finish') {
      // In group chats, resolve to the group JID (not the user's personal JID)
      let targetJid = fromJid
      try {
        const chat = await msg.getChat()
        targetJid = chat.id._serialized
      } catch {
        // fallback to fromJid if we can't get the chat
      }
      const pollState = dailyPollState.get(targetJid)
      if (!pollState) {
        await client.sendMessage(targetJid, '⚠️ No active poll. Wait for the daily poll at ' + (config.pollTime ?? '9:00') + ' to start selecting.')
        return
      }
      if (pollState.pollSelections.length === 0) {
        await client.sendMessage(targetJid, '⚠️ No sets selected. Please select at least one set from the polls.')
        return
      }
      const selectedSets = sets.filter(s => pollState.pollSelections.includes(s.id))
      const effectiveFrom = todayLocal()
      const setIds = selectedSets.map(s => s.id)
      await saveRecipientSchedule(targetJid, setIds, effectiveFrom)
      const names = selectedSets.map(s => `• ${s.title_en}`).join('\n')
      await client.sendMessage(targetJid, `✅ Selection saved! Today you'll receive:\n${names}`)
      log(`[bot] !finish — stored ${setIds.length} set(s) for ${targetJid}`)

      // Delete poll messages
      for (const pollMsg of pollState.pollMsgs) {
        await pollMsg.delete(true).catch(() => {})
      }

      // Send questions immediately if their scheduled time has already passed
      const nowFormatted = new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: config.timezone,
        hour12: false
      })
      const [nowHour, nowMinute] = nowFormatted.split(':').map(Number)
      const nowInMinutes = nowHour * 60 + nowMinute

      const readyToSend = selectedSets.filter(set => {
        const [h, m] = set.scheduleTime.split(':').map(Number)
        const setTimeInMinutes = h * 60 + m
        return nowInMinutes >= setTimeInMinutes
      })

      if (readyToSend.length > 0) {
        const [first, ...rest] = readyToSend
        if (rest.length > 0) {
          const queue = sessionQueues.get(targetJid) ?? []
          sessionQueues.set(targetJid, [...queue, ...rest])
        }
        log(`[bot] !finish — sending ${readyToSend.length} set(s) now (scheduled time passed)`)
        await startSession(targetJid, first).catch(err => logError('[bot] Failed to start session after !finish:', err))
      }

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
