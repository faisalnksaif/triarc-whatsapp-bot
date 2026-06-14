import type { Question } from './types.js'

export interface ValidationResult {
  valid: boolean
  errorMessage?: string
}

export function validate(input: string, question: Question): ValidationResult {
  const trimmed = input.trim()

  switch (question.type) {
    case 'text': {
      if (trimmed.length === 0) {
        return { valid: false, errorMessage: 'Please provide a text response. This field cannot be empty.' }
      }
      return { valid: true }
    }

    case 'number': {
      if (trimmed.length === 0) {
        return { valid: false, errorMessage: 'Please enter a number.' }
      }
      const num = Number(trimmed)
      if (isNaN(num)) {
        return {
          valid: false,
          errorMessage: `"${trimmed}" is not a valid number. Please reply with a numeric value (e.g. 5).`,
        }
      }
      return { valid: true }
    }

    case 'poll': {
      const options = question.options!
      const idx = Number(trimmed)
      const byNumber = !isNaN(idx) && idx >= 1 && idx <= options.length
      const byText = options.some((o) => o.toLowerCase() === trimmed.toLowerCase())

      if (!byNumber && !byText) {
        const list = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')
        return {
          valid: false,
          errorMessage: `Please select one of the options by typing the number or the exact text:\n${list}`,
        }
      }
      return { valid: true }
    }
  }
}

export function normalise(input: string, question: Question): string {
  const trimmed = input.trim()

  if (question.type === 'poll') {
    const options = question.options!
    const idx = Number(trimmed)
    if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1]
    }
    return options.find((o) => o.toLowerCase() === trimmed.toLowerCase()) ?? trimmed
  }

  return trimmed
}
