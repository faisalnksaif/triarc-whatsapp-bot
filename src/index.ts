import { loadConfig, loadQuestions } from './config.js'
import { startBot } from './bot.js'

async function main() {
  console.log('🤖 Triarc WhatsApp Bot starting...')

  const config = loadConfig()
  const sets = loadQuestions(config.questionsFile)

  console.log(`[init] Loaded ${sets.length} questionnaire set(s) from ${config.questionsFile}`)
  for (const set of sets) {
    console.log(`[init]   "${set.title}" — ${set.questions.length} questions @ ${set.scheduleTime}`)
  }
  console.log(`[init] Recipients (${config.recipients.length}): ${config.recipients.join(', ')}`)
  console.log(`[init] Timezone: ${config.timezone}`)

  await startBot(config, sets)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
