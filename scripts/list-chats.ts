import { createRequire } from 'module'
const { Client, LocalAuth } = createRequire(import.meta.url)('whatsapp-web.js')
import qrcode from 'qrcode-terminal'
import { resolve } from 'path'

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: resolve(process.cwd(), 'auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
})

client.on('qr', (qr: string) => {
  console.log('Scan this QR to authenticate:')
  qrcode.generate(qr, { small: true })
})

client.on('ready', async () => {
  console.log('Connected. Fetching chats...\n')

  const chats = await client.getChats()

  const groups = chats.filter((c: any) => c.isGroup)
  const individuals = chats.filter((c: any) => !c.isGroup)

  console.log(`── Groups (${groups.length}) ──────────────────────`)
  for (const g of groups) {
    console.log(`  ${g.name.padEnd(40)} ${g.id._serialized}`)
  }

  console.log(`\n── Individuals (${individuals.length}) ───────────────────`)
  for (const c of individuals) {
    const name = (c.name || c.pushname || '').padEnd(40)
    console.log(`  ${name} ${c.id._serialized}`)
  }

  console.log('\nDone.')
  await client.destroy()
  process.exit(0)
})

client.on('auth_failure', (msg: string) => {
  console.error('Auth failed:', msg)
  process.exit(1)
})

client.initialize()
