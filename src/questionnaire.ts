import { validate, normalise } from './validator.js'
import { saveSession, generateSessionId } from './storage.js'
import type { Question, Answer, ActiveSession, SessionRecord } from './types.js'

type SendText = (text: string) => Promise<void>
type SendChoices = (question: string, options: string[]) => Promise<void>

export class Questionnaire {
  private session: ActiveSession | null = null

  constructor(
    private readonly questions: Question[],
    private readonly recipient: string,
    private readonly recipientName: string,
    private readonly responsesDir: string,
    private readonly sendText: SendText,
    private readonly sendChoices: SendChoices,
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
    }

    console.log('[questionnaire] Session started')
    await this.sendCurrentQuestion()
  }

  private async sendCurrentQuestion(): Promise<void> {
    if (!this.session || this.isComplete()) return

    const q = this.session.questions[this.session.currentIndex]
    const total = this.session.questions.length
    const num = this.session.currentIndex + 1

    if (q.type === 'poll') {
      await this.sendChoices(`Question ${num}/${total} — ${q.question}`, q.options!)
    } else {
      const typeHint = q.type === 'number' ? ' _(please reply with a number)_' : ''
      await this.sendText(`*Question ${num}/${total}*\n\n${q.question}${typeHint}`)
    }

    this.session.awaitingReply = true
  }

  async handleTextReply(text: string): Promise<void> {
    if (!this.session?.awaitingReply) return

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

    const savedPath = saveSession(this.responsesDir, record)
    console.log(`[questionnaire] Session complete. Saved to ${savedPath}`)

    await this.sendText(`✅ *All done!* Thank you for completing the questionnaire.\n_Your responses have been recorded._`)

    this.session = null
  }
}
