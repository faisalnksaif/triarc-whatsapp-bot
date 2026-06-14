import { validate, normalise } from './validator.js'
import { generateSessionId } from './storage.js'
import type { Question, Answer, ActiveSession, SessionRecord } from './types.js'

type SendText = (text: string) => Promise<void>
type SendChoices = (question: string, options: string[]) => Promise<void>
type SaveSession = (record: SessionRecord) => Promise<void>

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
  ) {}

  isActive(): boolean {
    return this.session !== null && !this.isComplete()
  }

  private isComplete(): boolean {
    if (!this.session) return false
    return this.session.currentIndex >= this.session.questions.length
  }

  async start(): Promise<void> {
    if (this.session) {
      console.log('[questionnaire] Already active — ignoring start signal')
      return
    }

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

  async handleTextReply(text: string): Promise<void> {
    if (!this.session?.awaitingReply) return

    if (this.session.awaitingLanguage) {
      this.session.lang = text === 'English' ? 'en' : 'ml'
      this.session.awaitingLanguage = false
      this.session.awaitingReply = false
      console.log(`[questionnaire] Language set to: ${this.session.lang}`)
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
    await this.recordAnswer(q, answer)
  }

  private async recordAnswer(q: Question, answer: string): Promise<void> {
    if (!this.session) return

    const entry: Answer = {
      questionId: q.id,
      question: q.question,
      type: q.type,
      answer,
      answeredAt: new Date().toISOString(),
    }

    this.session.responses.push(entry)
    this.session.currentIndex++
    this.session.awaitingReply = false

    console.log(`[questionnaire] Q${this.session.currentIndex} answered: "${answer}"`)

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
