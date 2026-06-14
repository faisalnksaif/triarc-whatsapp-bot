import cron from 'node-cron'
import { timeToCron } from './config.js'

export function scheduleQuestionnaire(
  scheduleTime: string,
  timezone: string,
  onTrigger: () => Promise<void>,
): void {
  const expression = timeToCron(scheduleTime)

  cron.schedule(
    expression,
    async () => {
      console.log(`[scheduler] Triggered at ${new Date().toLocaleTimeString()} — starting questionnaire`)
      try {
        await onTrigger()
      } catch (err) {
        console.error('[scheduler] Error during questionnaire start:', err)
      }
    },
    { timezone },
  )

  console.log(`[scheduler] Questionnaire scheduled for ${scheduleTime} (${timezone}) — cron: "${expression}"`)
}
