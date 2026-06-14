import OpenAI from 'openai'
import type { ReportQuery } from './commands.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface QA {
  question: string
  answer: string
}

export interface SetData {
  category: string
  qa: QA[]
}

export interface RecipientData {
  name: string
  label: string
  sets: SetData[]
}

const FORMAT_RULES = `
FORMAT RULES:
- Format for WhatsApp: use *bold* for headers and key points, _italic_ for notes
- Use • for bullets (not dashes)
- Use single newlines between items, blank line between sections
- Do NOT use markdown headers (##) or HTML
- Emojis are encouraged for visual scanning`

// ── Step 1: Decode user's free-form message into a structured query ──────────

export async function parseReportIntent(message: string): Promise<ReportQuery> {
  const today = new Date().toISOString().slice(0, 10)

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a report query parser for a construction site management WhatsApp bot. Today is ${today}. Extract the report intent from the user's message and return ONLY valid JSON — no explanation, no markdown.`,
      },
      {
        role: 'user',
        content: `Message: "${message}"

Return JSON with:
{
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "recipientFilter": "name or null if all recipients",
  "label": "short human-readable period e.g. 'Today', 'June 2026', 'Last Week', 'Kamaru - June'"
}

Rules:
- "today" or no date → startDate = endDate = today
- "yesterday" → startDate = endDate = yesterday
- "this week" / "last 7 days" → last 7 days
- "this month" / "month" → first day of current month to today
- "last month" → full previous month
- A month name like "June" → full month of current year
- "YYYY-MM" → full that month
- A full date like "14 June" / "2026-06-14" → that single day
- If a person's name is mentioned, set recipientFilter to their name`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  })

  try {
    const parsed = JSON.parse(response.choices[0].message.content ?? '{}')
    return {
      startDate: parsed.startDate ?? today,
      endDate: parsed.endDate ?? today,
      recipientFilter: parsed.recipientFilter ?? undefined,
      label: parsed.label ?? today,
      question: message,
    }
  } catch {
    return { startDate: today, endDate: today, label: 'Today', question: message }
  }
}

// ── Step 2: Answer any admin question using fetched report data ───────────────

export async function answerQuestion(
  question: string,
  recipients: RecipientData[],
  label: string,
): Promise<string> {
  const dataText = recipients
    .map(r => {
      const sets = r.sets
        .map(s => `  ${s.category}:\n${s.qa.map(q => `    • ${q.question}: ${q.answer}`).join('\n')}`)
        .join('\n')
      return `--- ${r.name} (${label}) ---\n${sets}`
    })
    .join('\n\n')

  const prompt = `You are a construction project management assistant with access to site report data. Answer the project manager's question as specifically as possible using only the data provided.

QUESTION: "${question}"

AVAILABLE DATA:
${dataText}

INSTRUCTIONS:
- Answer the specific question directly — don't generate a generic report
- If the question asks about upcoming events or plans, look for "tomorrow's plan", "scheduled work", or similar fields
- If the question asks about a specific topic (materials, workers, safety, etc.), focus only on that
- If the data doesn't contain enough information to answer, say so clearly
- Use ⚠️ for warnings, 🚨 for critical issues
${FORMAT_RULES}`

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 1000,
  })

  return response.choices[0].message.content ?? '❌ AI returned empty response.'
}
