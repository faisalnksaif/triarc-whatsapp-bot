import { createRequire } from 'module'
const { Client, LocalAuth, Poll } = createRequire(import.meta.url)('whatsapp-web.js')
import qrcode from 'qrcode-terminal'
import { resolve } from 'path'
import { toJid } from './config.js'
import { scheduleQuestionnaire } from './scheduler.js'
import { Questionnaire } from './questionnaire.js'
import type { BotConfig, QuestionnaireSet } from './types.js'

export async function startBot(config: BotConfig, sets: QuestionnaireSet[]): Promise<void> {
  const scheduledJids = config.recipients.map(toJid)
  let cronRegistered = false

  // keyed by JID — one session per recipient, all concurrent
  const activeSessions = new Map<string, Questionnaire>()
  // keyed by poll message ID → JID, so vote_update can find the right session
  const pendingPolls = new Map<string, string>()

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: resolve(process.cwd(), 'auth') }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })

  async function startSession(targetJid: string, set: QuestionnaireSet): Promise<void> {
    if (activeSessions.get(targetJid)?.isActive()) {
      console.log(`[bot] Session already active for ${targetJid} — ignoring`)
      return
    }

    let recipientName = targetJid
    try {
      const contact = await client.getContactById(targetJid)
      recipientName = contact.name || contact.pushname || contact.number || targetJid
    } catch {
      // non-fatal — fall back to JID
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
      config.responsesDir,
      sendText,
      sendChoices,
    )

    activeSessions.set(targetJid, questionnaire)
    questionnaire.start().catch(err => {
      console.error('[bot] Failed to start questionnaire:', err)
      activeSessions.delete(targetJid)
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

  client.on('ready', () => {
    const name = client.info.pushname ?? client.info.wid.user
    console.log(`[bot] ✅ Connected to WhatsApp as ${name}`)
    console.log(`[bot] Scheduled recipients: ${scheduledJids.join(', ')}`)

    if (!cronRegistered) {
      for (const set of sets) {
        scheduleQuestionnaire(set.scheduleTime, config.timezone, async () => {
          for (const jid of scheduledJids) {
            await startSession(jid, set)
          }
        })
      }
      cronRegistered = true
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

    console.log(`[bot] Poll vote from ${targetJid}: "${selected}"`)
    pendingPolls.delete(pollId)

    const session = activeSessions.get(targetJid)
    if (session) await session.handleTextReply(selected)
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
    console.log(`[bot] Reply from ${sender}: "${text.trim()}"`)
    await session.handleTextReply(text)
  }

  // message = received from others; message_create = sent by this client (owner trigger)
  client.on('message', handleMessage)
  client.on('message_create', handleMessage)

  await client.initialize()
}
