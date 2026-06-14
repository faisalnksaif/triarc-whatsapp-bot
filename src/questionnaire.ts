import { validate, normalise } from './validator.js'
import { generateSessionId } from './storage.js'
import type { Question, Answer, ActiveSession, SessionRecord, PersistedSession } from './types.js'

type SendText = (text: string) => Promise<void>
type SendChoices = (question: string, options: string[]) => Promise<void>
type SaveSession = (record: SessionRecord) => Promise<void>
type OnPersist = (state: Pick<PersistedSession, 'responses' | 'pendingIds' | 'lang'>) => void

const LANG_OPTIONS = ['English', 'Malayalam']

export class Questionnaire {
  private session: ActiveSession | null = null

  constructor(
    private readonly questions: Question[],
    private readonly recipient: string,
    private readonly recipientName: string,
    private readonly saveSession: SaveSession,
    private readonly sendText: SendText,
    private readonly sendChoices: SendChoices,
    private readonly onComplete?: () => void,
    private readonly initialLang?: 'en' | 'ml',
    private readonly onLanguageSelected?: (lang: 'en' | 'ml') => void,
    private readonly title?: string,
    private readonly title_en?: string,
    private readonly timezone = 'UTC',
    private readonly isQueued = false,
    private readonly onPersist?: OnPersist,
  ) {}

  isActive(): boolean {
    return this.session !== null && !this.isComplete()
  }

  private isComplete(): boolean {
    return this.session?.pendingIds.length === 0
  }

  // Build the initial queue: questions not inside any branch (those get injected on demand)
  private buildInitialPending(): string[] {
    const branchedIds = new Set<string>()
    for (const q of this.questions) {
      if (q.conditions) {
        for (const ids of Object.values(q.conditions)) {
          for (const id of ids) branchedIds.add(id)
        }
      }
    }
    return this.questions.filter(q => !branchedIds.has(q.id)).map(q => q.id)
  }

  private buildIntroMessage(): string {
    const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: this.timezone }).format(new Date()))
    const titleLine = [this.title_en, this.title].filter(Boolean).join(' • ')
    const count = this.questions.length

    if (this.isQueued) {
      return [`📋 *${titleLine}*`, ``, `_One more — ${count} question${count !== 1 ? 's' : ''}, won't take long_ ✅`].join('\n')
    }

    let greeting: string
    if (hour < 12)       greeting = `Good morning! ☀️\nLet's start the day fresh — hope it's a great one on site.`
    else if (hour < 17)  greeting = `Good afternoon! 👋\nHope things are going well out there.`
    else if (hour < 21)  greeting = `Good evening! 🌇\nAlmost there — just a quick check-in to wrap up the day.`
    else                  greeting = `Good night! 🌙\nWinding down for the day — just a few last questions before you rest.`

    return [greeting, ``, `Here is your next check-in:`, `📋 *${titleLine}*`, ``, `_${count} question${count !== 1 ? 's' : ''} — won't take long_ ✅`].join('\n')
  }

  async start(): Promise<void> {
    if (this.session) {
      console.log('[questionnaire] Already active — ignoring start signal')
      return
    }

    await this.sendText(this.buildIntroMessage())

    const pendingIds = this.buildInitialPending()

    if (this.initialLang) {
      this.session = { questions: this.questions, pendingIds, responses: [], startedAt: new Date().toISOString(), awaitingReply: false, awaitingLanguage: false, lang: this.initialLang }
      console.log(`[questionnaire] Session started — using cached language: ${this.initialLang}`)
      await this.sendCurrentQuestion()
    } else {
      this.session = { questions: this.questions, pendingIds, responses: [], startedAt: new Date().toISOString(), awaitingReply: false, awaitingLanguage: true, lang: null }
      console.log('[questionnaire] Session started — asking language preference')
      await this.sendChoices('Please select your preferred language\nഭാഷ തിരഞ്ഞെടുക്കുക', LANG_OPTIONS)
      this.session.awaitingReply = true
    }
  }

  async resume(persisted: Pick<PersistedSession, 'responses' | 'pendingIds' | 'lang' | 'startedAt'>): Promise<void> {
    this.session = {
      questions: this.questions,
      pendingIds: persisted.pendingIds,
      responses: persisted.responses,
      startedAt: persisted.startedAt,
      awaitingReply: false,
      awaitingLanguage: persisted.lang === null,
      lang: persisted.lang,
    }

    const answered = persisted.responses.length
    const total = this.questions.length
    const titleLine = [this.title_en, this.title].filter(Boolean).join(' • ')

    console.log(`[questionnaire] Resuming session — ${answered}/${total} already answered`)

    await this.sendText(
      `🔄 *We're back!*\n\n` +
      `The bot restarted but your session is safe.\n` +
      `📋 *${titleLine}*\n` +
      `_Continuing from question ${answered + 1} of ${total}..._`
    )

    if (persisted.lang === null) {
      await this.sendChoices('Please select your preferred language\nഭാഷ തിരഞ്ഞെടുക്കുക', LANG_OPTIONS)
      this.session.awaitingReply = true
    } else {
      await this.sendCurrentQuestion()
    }
  }

  private async sendCurrentQuestion(): Promise<void> {
    if (!this.session || this.isComplete()) return

    const currentId = this.session.pendingIds[0]
    const q = this.session.questions.find(x => x.id === currentId)
    if (!q) { await this.finish(); return }

    const total = this.session.questions.length
    const num = this.session.responses.length + 1
    const text = this.session.lang === 'en' ? q.question_en : q.question

    if (q.type === 'poll') {
      await this.sendChoices(`Question ${num}/${total} — ${text}`, q.options!)
    } else {
      const typeHint = q.type === 'number' ? ' _(please reply with a number)_' : ''
      await this.sendText(`*Question ${num}/${total}*\n\n${text}${typeHint}`)
    }

    this.session.awaitingReply = true
  }

  async handleTextReply(text: string, contactName = ''): Promise<void> {
    if (!this.session?.awaitingReply) return

    if (this.session.awaitingLanguage) {
      const lang: 'en' | 'ml' = text === 'English' ? 'en' : 'ml'
      this.session.lang = lang
      this.session.awaitingLanguage = false
      this.session.awaitingReply = false
      console.log(`[questionnaire] Language set to: ${lang}`)
      this.onLanguageSelected?.(lang)
      this.onPersist?.({ responses: this.session.responses, pendingIds: this.session.pendingIds, lang })
      await this.sendCurrentQuestion()
      return
    }

    const currentId = this.session.pendingIds[0]
    const q = this.session.questions.find(x => x.id === currentId)
    if (!q) { await this.finish(); return }

    const result = validate(text, q)
    if (!result.valid) {
      await this.sendText(`❌ ${result.errorMessage}`)
      return
    }

    await this.recordAnswer(q, normalise(text, q), contactName)
  }

  private async recordAnswer(q: Question, answer: string, contactName: string): Promise<void> {
    if (!this.session) return

    this.session.responses.push({
      questionId: q.id,
      question: q.question,
      type: q.type,
      answer,
      answeredAt: new Date().toISOString(),
      contactName,
    })
    this.session.awaitingReply = false

    // Pop the answered question
    const remaining = this.session.pendingIds.slice(1)

    // Inject branch questions at the front if a condition matches
    const branchIds = q.conditions?.[answer]
    if (branchIds?.length) {
      const withoutBranch = remaining.filter(id => !branchIds.includes(id))
      this.session.pendingIds = [...branchIds, ...withoutBranch]
    } else {
      this.session.pendingIds = remaining
    }

    console.log(`[questionnaire] Answered "${answer}" → pending: [${this.session.pendingIds.join(', ')}]`)
    this.onPersist?.({ responses: this.session.responses, pendingIds: this.session.pendingIds, lang: this.session.lang })

    if (this.isComplete()) {
      await this.finish()
    } else {
      await this.sendCurrentQuestion()
    }
  }

  private async finish(): Promise<void> {
    if (!this.session) return

    const record: SessionRecord = {
      sessionId: generateSessionId(),
      recipient: this.recipient,
      recipientName: this.recipientName,
      startedAt: this.session.startedAt,
      completedAt: new Date().toISOString(),
      responses: this.session.responses,
    }

    await this.saveSession(record)
    console.log(`[questionnaire] Session complete. Saved to Supabase.`)
    await this.sendText(`✅ *All done!* Thank you for completing the questionnaire.\n_Your responses have been recorded._`)

    this.session = null
    this.onComplete?.()
  }
}
