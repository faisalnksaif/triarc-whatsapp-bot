export interface Answer {
  questionId: string
  question: string
  type: string
  answer: string
  answeredAt: string
}

export interface Session {
  id: string
  session_id: string
  recipient: string
  recipient_name: string
  started_at: string
  completed_at: string
  responses: Answer[]
  created_at: string
}

export interface QuestionnaireSet {
  id: string
  title: string
  title_en: string
  schedule_time: string
}

export interface Question {
  id: string
  set_id: string
  question_id: string
  question: string
  question_en: string
  type: string
  options: string[] | null
  conditions: Record<string, string[]> | null
  sort_order: number
}
