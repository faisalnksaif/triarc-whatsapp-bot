import { validate, normalise } from './validator.js'
import { generateSessionId } from './storage.js'
import type { Question, Answer, ActiveSession, SessionRecord, PersistedSession } from './types.js'

type SendText = (text: string) => Promise<void>
type SendChoices = (question: string, options: string[]) => Promise<void>
type SaveSession = (record: SessionRecord) => Promise<void>
type OnPersist = (state: Pick<PersistedSession, 'responses' | 'currentIndex' | 'lang'>) => void

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
    if (!this.session) return false
    return this.session.currentIndex >= this.session.questions.length
  }

  private buildIntroMessage(): string {
    const hour = Number(new Intl.DateTimeFormat('en', { hour: 'numeric', hour12: false, timeZone: this.timezone }).format(new Date()))

    const titleLine = [this.title_en, this.title].filter(Boolean).join(' • ')
    const count = this.questions.length

    if (this.isQueued) {
      return [
        `📋 *${titleLine}*`,
        ``,
        `_One more — ${count} question${count !== 1 ? 's' : ''}, won't take long_ ✅`,
      ].join('\n')
    }

    let greeting: string
    if (hour < 12) {
      greeting = `Good morning! ☀️\nLet's start the day fresh — hope it's a great one on site.`
    } else if (hour < 17) {
      greeting = `Good afternoon! 👋\nHope things are going well out there.`
    } else if (hour < 21) {
      greeting = `Good evening! 🌇\nAlmost there — just a quick check-in to wrap up the day.`
    } else {
      greeting = `Good night! 🌙\nWinding down for the day — just a few last questions before you rest.`
    }

    return [
      greeting,
      ``,
      `Here is your next check-in:`,
      `📋 *${titleLine}*`,
      ``,
      `_${count} question${count !== 1 ? 's' : ''} — won't take long_ ✅`,
    ].join('\n')
  }

  async resume(persisted: Pick<PersistedSession, 'responses' | 'currentIndex' | 'lang' | 'startedAt'>): Promise<void> {
    this.session = {
      questions: this.questions,
      currentIndex: persisted.currentIndex,
      responses: persisted.responses,
      startedAt: persisted.startedAt,
      awaitingReply: false,
      awaitingLanguage: persisted.lang === null,
      lang: persisted.lang,
    }

    const answered = persisted.currentIndex
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

  async start(): Promise<void> {
    if (this.session) {
      console.log('[questionnaire] Already active — ignoring start signal')
      return
    }

    await this.sendText(this.buildIntroMessage())

    if (this.initialLang) {
      this.session = {
        questions: this.questions,
        currentIndex: 0,
        responses: [],
        startedAt: new Date().toISOString(),
        awaitingReply: false,
        awaitingLanguage: false,
        lang: this.initialLang,
      }
      console.log(`[questionnaire] Session started — using cached language: ${this.initialLang}`)
      await this.sendCurrentQuestion()
    } else {
      this.session = {
        questions: this.questions,
        currentIndex: 0,
        responses: [],
        startedAt: new Date().toISOString(),
        awaitingReply: false,
        awaitingLanguage: true,
        lang: null,
      }
      console.log('[questionnaire] Session started — asking language preference')
      await this.sendChoices(
        'Please select your preferred language\nഭാഷ തിരഞ്ഞെടുക്കുക',
        LANG_OPTIONS,
      )
      this.session.awaitingReply = true
    }
  }

  private async sendCurrentQuestion(): Promise<void> {
    if (!this.session || this.isComplete()) return

    const q = this.session.questions[this.session.currentIndex]
    const total = this.session.questions.length
    const num = this.session.currentIndex + 1
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
      this.onPersist?.({ responses: this.session.responses, currentIndex: this.session.currentIndex, lang })
      await this.sendCurrentQuestion()
      return
    }

    const q = this.session.questions[this.session.currentIndex]
    const result = validate(text, q)
    if (!result.valid) {
      await this.sendText(`❌ ${result.errorMessage}`)
      return
    }

    const answer = normalise(text, q)
    await this.recordAnswer(q, answer, contactName)
  }

  private async recordAnswer(q: Question, answer: string, contactName: string): Promise<void> {
    if (!this.session) return

    const entry: Answer = {
      questionId: q.id,
      question: q.question,
      type: q.type,
      answer,
      answeredAt: new Date().toISOString(),
      contactName,
    }

    this.session.responses.push(entry)
    this.session.currentIndex++
    this.session.awaitingReply = false

    console.log(`[questionnaire] Q${this.session.currentIndex} answered: "${answer}"`)
    this.onPersist?.({ responses: this.session.responses, currentIndex: this.session.currentIndex, lang: this.session.lang })

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
