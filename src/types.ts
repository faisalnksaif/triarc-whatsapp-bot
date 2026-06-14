export type QuestionType = 'text' | 'number' | 'poll'

export interface Question {
  id: string
  question: string
  type: QuestionType
  options?: string[]
}

export interface Answer {
  questionId: string
  question: string
  type: QuestionType
  answer: string
  answeredAt: string
}

export interface SessionRecord {
  sessionId: string
  recipient: string
  recipientName: string
  startedAt: string
  completedAt: string
  responses: Answer[]
}

export interface QuestionnaireSet {
  title: string
  scheduleTime: string
  questions: Question[]
}

export interface BotConfig {
  recipients: string[]
  timezone: string
  questionsFile: string
  responsesDir: string
}

export interface ActiveSession {
  questions: Question[]
  currentIndex: number
  responses: Answer[]
  startedAt: string
  awaitingReply: boolean
}
