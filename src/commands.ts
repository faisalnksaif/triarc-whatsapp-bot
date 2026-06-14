export interface ReportQuery {
  startDate: string   // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
  recipientFilter?: string
  label: string
  question: string    // original free-form question from the admin
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseMonth(token: string): { start: string; end: string; label: string } | null {
  // 2026-06 or june/jun 2026
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(token)
  if (isoMonth) {
    const [, y, m] = isoMonth
    const start = `${y}-${m}-01`
    const end = toYMD(new Date(Number(y), Number(m), 0)) // last day of month
    return { start, end, label: `${new Date(start).toLocaleString('en', { month: 'long' })} ${y}` }
  }

  const namedMonth = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?$/i.exec(token)
  if (namedMonth) {
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    const mIdx = monthNames.findIndex(m => namedMonth[1].toLowerCase().startsWith(m))
    const year = namedMonth[2] ? Number(namedMonth[2]) : new Date().getFullYear()
    const start = toYMD(new Date(year, mIdx, 1))
    const end = toYMD(new Date(year, mIdx + 1, 0))
    return { start, end, label: `${new Date(start).toLocaleString('en', { month: 'long' })} ${year}` }
  }

  return null
}

export function parseReportCommand(args: string): ReportQuery {
  const today = new Date()
  const parts = args.trim().split(/\s+/).filter(Boolean)

  if (parts.length === 0) {
    const d = toYMD(today)
    return { startDate: d, endDate: d, label: 'Today', question: args }
  }

  // Detect period keywords anywhere in args
  const periodIdx = parts.findIndex(p =>
    /^(today|yesterday|week|month|\d{4}-\d{2}|\d{4}-\d{2}-\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(p)
  )

  // Everything before the period token is the recipient filter
  const recipientParts = periodIdx > 0 ? parts.slice(0, periodIdx) : periodIdx === -1 ? parts : []
  const recipientFilter = recipientParts.length > 0 ? recipientParts.join(' ') : undefined
  const periodToken = periodIdx !== -1 ? parts.slice(periodIdx).join(' ') : ''

  if (!periodToken || periodToken === 'today') {
    const d = toYMD(today)
    return { startDate: d, endDate: d, recipientFilter, label: 'Today', question: args }
  }

  if (periodToken === 'yesterday') {
    const d = new Date(today)
    d.setDate(d.getDate() - 1)
    const s = toYMD(d)
    return { startDate: s, endDate: s, recipientFilter, label: 'Yesterday', question: args }
  }

  if (periodToken === 'week') {
    const end = toYMD(today)
    const start = new Date(today)
    start.setDate(start.getDate() - 6)
    return { startDate: toYMD(start), endDate: end, recipientFilter, label: 'Last 7 Days', question: args }
  }

  if (periodToken === 'month') {
    const start = toYMD(new Date(today.getFullYear(), today.getMonth(), 1))
    const end = toYMD(today)
    return {
      startDate: start, endDate: end, recipientFilter, question: args,
      label: today.toLocaleString('en', { month: 'long', year: 'numeric' }),
    }
  }

  // Specific date YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodToken)) {
    return { startDate: periodToken, endDate: periodToken, recipientFilter, label: periodToken, question: args }
  }

  // Month: YYYY-MM or "June 2026" etc.
  const month = parseMonth(periodToken)
  if (month) {
    return { startDate: month.start, endDate: month.end, recipientFilter, label: month.label, question: args }
  }

  // Fallback: treat whole thing as recipient filter, use today
  const d = toYMD(today)
  return { startDate: d, endDate: d, recipientFilter: args.trim(), label: 'Today', question: args }
}
