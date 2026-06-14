---
name: project-whatsapp-bot
description: Triarc WhatsApp bot — architecture, stack, and key design decisions
metadata:
  type: project
---

Baileys-based WhatsApp questionnaire bot built with whatsapp-web.js + TypeScript.

**Why:** Daily site reporting tool for construction sites. Site engineers answer Malayalam questionnaires via WhatsApp; responses saved to Supabase.

**Stack:**
- `whatsapp-web.js` (Puppeteer-based WA client)
- TypeScript + tsx (no build step in dev)
- Supabase (PostgreSQL) — questions, sessions storage
- `node-cron` for scheduling
- `dotenv` for env vars

**Supabase tables:**
- `questionnaire_sets` — id, title, title_en, schedule_time
- `questions` — id, set_id, question_id, question, question_en, type, options (jsonb), sort_order
- `sessions` — id, session_id, recipient, recipient_name, started_at, completed_at, responses (jsonb)
- All tables have RLS disabled

**Key design decisions:**
- Multiple concurrent recipients: `activeSessions: Map<JID, Questionnaire>`, `pendingPolls: Map<pollMsgId, JID>`
- Sets at same schedule time: first starts immediately, rest pushed to `sessionQueues: Map<JID, QuestionnaireSet[]>`
- If a later-scheduled set fires while earlier is still active: queued, not dropped — processed when current finishes via `onComplete` callback
- Questions have both Malayalam (`question`) and English (`question_en`) fields
- Credentials in `.env` (gitignored): `SUPABASE_URL`, `SUPABASE_KEY` (service_role key)

**Scripts:**
- `npx tsx scripts/migrate-questions.ts` — seeds questions from `data/questions.json` into Supabase
