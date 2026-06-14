import OpenAI from 'openai'
import type { ReportQuery } from './commands.js'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface QA {
  question: string
  answer: string
  contactName: string
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
FORMAT RULES (WhatsApp only — strict):
- Use *bold* for section headers, site names, and key metrics
- Use _italic_ for context, notes, or caveats
- Use • for bullet points (never dashes or numbers unless ranking)
- Blank line between sections, single newline between bullets
- Do NOT use markdown headers (##), HTML, or tables
- Lead every section with a relevant emoji so the reader can scan at a glance
- Where numbers allow it, always show a percentage alongside (e.g. "8/10 workers present — 80%")
- End with a short punchy *Overall Pulse* line that gives the manager a one-line feel for the day`

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
        .map(s =>
          `  ${s.category}:\n` +
          s.qa.map(q => `    • ${q.question}: ${q.answer}${q.contactName ? ` [${q.contactName}]` : ''}`).join('\n')
        )
        .join('\n')
      return `=== SITE: ${r.name} (${label}) ===\n${sets}`
    })
    .join('\n\n')

  const prompt = `You are a sharp construction site assistant briefing a busy project manager on WhatsApp. Be punchy, clear, and human — like a trusted colleague giving a quick heads-up, not a formal report.

MANAGER'S REQUEST: "${question}"

SITE DATA (${recipients.length} site${recipients.length !== 1 ? 's' : ''}):
${dataText}

RULES:
- *Short* — every word must earn its place. No filler, no repetition
- Answer exactly what was asked. Skip anything irrelevant
- Use *bold* for site names and key numbers, emojis to signal status (🟢 good, 🟡 watch, 🔴 problem)
- Show percentages when numbers allow (e.g. "12/15 workers — 80%")
- Multi-site: one line per site, then a one-line overall
- Single topic: go straight to the point, no intro
- Name the person only when it adds value ("Rajan flagged a material delay")
- End with one *Pulse* line — the manager's single takeaway for the day
- If data is missing, say it in 4 words max and move on
${FORMAT_RULES}`

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 800,
  })

  return response.choices[0].message.content ?? '❌ AI returned empty response.'
}
