# Enterprise Multi-Tenant Automation Engine

```
├── schema.sql                   # Multi-tenant Postgres schema + RLS + billing guard
├── supabase/functions/webhook-ingest/index.ts   # Ingestion gate (Deno Edge Function)
└── render-worker/
    ├── server.js                # Worker HTTP pipeline
    ├── parser.js                # Message extraction + container/weight parsing
    ├── llm.js                   # Optional DeepSeek fallback (all provider code lives here)
    ├── test/                    # `npm test`: parser + messy-payload fuzz loop + DeepSeek fallback with a mocked API (offline)
    ├── package.json
    └── .env.example
```

## Setup

### 1. Database
Run `schema.sql` in the Supabase SQL Editor. It is safe to run again; it also adds `webhook_secret` to a `workflows` table created by an older version.

Tenant users read their data through RLS using a `tenant_id` claim in **app_metadata**:
```sql
update auth.users
set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('tenant_id', '<tenant uuid>')
where id = '<user uuid>';
```
The backend (edge function + worker) uses the service role key and bypasses RLS.

### 2. Edge function
```
supabase init            # once, in the folder that contains supabase/
supabase link --project-ref <your-project-ref>
supabase functions deploy webhook-ingest --no-verify-jwt
supabase secrets set RENDER_WORKER_URL=https://your-worker.onrender.com INTERNAL_SECRET_TOKEN=<random string>
```
`SUPABASE_URL` and the server key (`SUPABASE_SECRET_KEYS`, or legacy `SUPABASE_SERVICE_ROLE_KEY`) are
injected automatically. Secrets starting with `SUPABASE_` cannot be set manually, and the anon key is no longer used.
`--no-verify-jwt` is used because webhook senders cannot send a Supabase JWT; callers are
authenticated by `x-webhook-secret` instead.

Callers must send:
```
x-tenant-id:      <tenants.id>
x-workflow-id:    <workflows.id>
x-webhook-secret: <workflows.webhook_secret>
```
```
curl -X POST "$SUPABASE_URL/functions/v1/webhook-ingest" \
  -H "x-tenant-id: ..." -H "x-workflow-id: ..." -H "x-webhook-secret: ..." \
  -H "Content-Type: application/json" \
  -d '{"message":{"from":"256700000000","text":"CONTAINER-AB12 5 tons"}}'
```

### 3. Render worker
Deploy `render-worker/` as a Web Service. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`INTERNAL_SECRET_TOKEN` (must equal the edge function's). `SUPABASE_SERVICE_ROLE_KEY` accepts either the
legacy service_role key or a new `sb_secret_...` key. The worker refuses to start if any is missing.

## Record statuses
`pending` → `completed` (container id found) | `needs_review` (nothing parseable) | `dispatch_failed` (worker unreachable).
`cargo_weight` is stored in kilograms; "tons" are treated as metric tonnes.

## Safety limits and retries
- **Rate limit:** each workflow may send at most `MAX_EVENTS_PER_MINUTE` events per minute (default 60). Extra requests get `429` with `Retry-After: 60` and nothing is stored or billed. Optional override: `supabase secrets set MAX_EVENTS_PER_MINUTE=120`.
- **Worker retries:** the edge function tries the worker up to 3 times (network errors, timeouts and 5xx only, with short waits between). A `409` from the worker means "already processed" and counts as success. If all attempts fail the record becomes `dispatch_failed`.
- **Parser input cap:** only the first 5,000 characters of a message are parsed. Numbers like `1.200,50 kg` (ambiguous format) leave `cargo_weight` empty instead of guessing.
- **Known gap:** the worker updates the record and then deducts credits in two separate steps. If the second step fails, the record stays `completed` but unbilled.

## DeepSeek fallback (optional)
Off by default. When on, it runs **only** for messages where the regex parser finds no container id (those would otherwise be `needs_review`). Messages the regex can read cost zero AI tokens.

Turn it on in Render by setting five environment variables on the worker: `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_INPUT_USD_PER_M`, `DEEPSEEK_OUTPUT_USD_PER_M`, `CREDITS_PER_USD` (see `.env.example`). If the key is set but any of the others is missing, the worker refuses to start. Model names and prices change, so check https://api-docs.deepseek.com/quick_start/pricing before setting them.

How it is guarded:
- Only the message text is sent (never the phone number), capped at 4,000 characters, with a 300-token output limit.
- The charge is the flat per-event cost plus the real token usage DeepSeek reports, converted with `CREDITS_PER_USD`. Tokens are charged even if the answer is rejected.
- The answer is untrusted: a container id is accepted only if it is well-formed **and** appears in the message; weights need a known unit (`kg` or `tonnes`).
- Never blocks or crashes the pipeline: on any failure the record becomes `needs_review`. At most 2 attempts (12s each), no retry on bad key or empty balance.
- Skipped for records that are already processed, so retries never spend twice. Worker-wide cap: `DEEPSEEK_MAX_CALLS_PER_MINUTE` (default 120).
- AI-filled records are marked `completed` like regex ones. Check the weight on early client jobs.
