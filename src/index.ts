import 'dotenv/config'
import { createServer } from 'http'
import { loadConfig, loadQuestionsFromSupabase } from './config.js'
import { startBot } from './bot.js'

const PORT = process.env.PORT ? Number(process.env.PORT) : 9001
createServer((_, res) => res.end('ok')).listen(PORT, () => {
  console.log(`[health] Listening on port ${PORT}`)
})

async function main() {
  console.log('🤖 Triarc WhatsApp Bot starting...')

  const config = loadConfig()
  const sets = await loadQuestionsFromSupabase()

  console.log(`[init] Loaded ${sets.length} questionnaire set(s) from Supabase`)
  for (const set of sets) {
    console.log(`[init]   "${set.title}" — ${set.questions.length} questions @ ${set.scheduleTime}`)
  }
  console.log(`[init] Recipients (${config.recipients.length}):`)
  for (const r of config.recipients) {
    console.log(`[init]   ${r.name} — ${r.id}`)
  }
  console.log(`[init] Timezone: ${config.timezone}`)

  await startBot(config, sets)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
