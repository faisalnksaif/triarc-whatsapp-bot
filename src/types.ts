export type QuestionType = 'text' | 'number' | 'poll'

export interface Question {
  id: string
  question: string
  question_en: string
  type: QuestionType
  options?: string[]
  conditions?: Record<string, string[]>  // answer value → ordered list of question ids to inject
}

export interface Answer {
  questionId: string
  question: string
  type: QuestionType
  answer: string
  answeredAt: string
  contactName: string
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
  title_en: string
  scheduleTime: string
  questions: Question[]
}

export interface Recipient {
  name: string
  id: string
}

export interface BotConfig {
  recipients: Recipient[]
  adminGroup?: string
  timezone: string
  questionsFile: string
  responsesDir: string
}

export interface ActiveSession {
  questions: Question[]
  pendingIds: string[]       // ordered queue of question ids yet to ask
  responses: Answer[]
  startedAt: string
  awaitingReply: boolean
  awaitingLanguage: boolean
  lang: 'en' | 'ml' | null
}

export interface PersistedSession {
  jid: string
  recipientName: string
  setTitle?: string
  setTitleEn?: string
  questions: Question[]
  responses: Answer[]
  pendingIds: string[]
  lang: 'en' | 'ml' | null
  startedAt: string
}
