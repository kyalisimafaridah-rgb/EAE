import { createClient } from "npm:@supabase/supabase-js@2"

// Provided by the Supabase Edge Runtime: keeps the isolate alive until the promise settles.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-tenant-id, x-workflow-id, x-webhook-secret',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const json = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  })

// Max events one workflow may send per minute. A malfunctioning sender (e.g. a webhook stuck in a
// loop) is cut off here instead of burning through the tenant's credits. Optional secret:
//   supabase secrets set MAX_EVENTS_PER_MINUTE=120
const MAX_EVENTS_PER_MINUTE = Number(Deno.env.get('MAX_EVENTS_PER_MINUTE')) || 60

// Worker dispatch retries. Worst case total = 3 x 40s + 5.5s of waiting = about 125s, which must
// stay under your plan's edge function time limit.
const MAX_DISPATCH_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1_500, 4_000]
const ATTEMPT_TIMEOUT_MS = 40_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Sends the event to the worker and retries only failures that can heal on their own:
// network errors, timeouts and 5xx (e.g. a Render cold start).
//  - 409 = the worker already processed this record, which counts as success.
//  - other 4xx (bad token, bad payload) would fail again, so they stop immediately.
// Retrying is safe because the worker only processes a record while it is still 'pending'.
async function dispatchToWorker(
  url: string,
  token: string,
  payload: unknown,
  delaysMs: number[] = RETRY_DELAYS_MS,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
    let retryable = true
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      if (res.ok || res.status === 409) return
      lastError = new Error(`Worker responded ${res.status}: ${await res.text()}`)
      retryable = res.status >= 500
    } catch (err) {
      lastError = err // network error or timeout
    }
    if (!retryable) break
    if (attempt < MAX_DISPATCH_ATTEMPTS) {
      console.warn(`Worker dispatch attempt ${attempt} failed, retrying:`, lastError)
      await sleep(delaysMs[attempt - 1] ?? 4_000)
    }
  }
  throw lastError
}

function getServerKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    if (keys.default) return keys.default
  } catch { /* fall through to the legacy key */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
}

// Constant-time string comparison.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' })

  try {
    const workerUrl = Deno.env.get('RENDER_WORKER_URL')
    const internalToken = Deno.env.get('INTERNAL_SECRET_TOKEN')
    if (!workerUrl || !internalToken) {
      console.error('RENDER_WORKER_URL / INTERNAL_SECRET_TOKEN secrets are not set')
      return json(500, { error: 'Server misconfiguration.' })
    }

    // The anon/publishable key is blocked by RLS (no tenant_id in its JWT), so every query
    // would return nothing. This function is trusted server code: use the secret key that
    // Supabase injects automatically. Newer projects get SUPABASE_SECRET_KEYS (JSON, keyed by
    // name); older ones only have the legacy SUPABASE_SERVICE_ROLE_KEY. Support both.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      getServerKey(),
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    const tenantId = req.headers.get('x-tenant-id')
    const workflowId = req.headers.get('x-workflow-id')
    const webhookSecret = req.headers.get('x-webhook-secret')

    if (!tenantId || !workflowId || !webhookSecret) {
      return json(400, { error: 'Missing x-tenant-id, x-workflow-id or x-webhook-secret header.' })
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(workflowId)) {
      return json(400, { error: 'x-tenant-id and x-workflow-id must be UUIDs.' })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json(400, { error: 'Request body must be valid JSON.' })
    }

    // 1. Authenticate the caller: workflow must belong to the tenant and the secret must match.
    const { data: workflow, error: workflowError } = await supabase
      .from('workflows')
      .select('status, webhook_secret')
      .eq('id', workflowId)
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (workflowError) throw workflowError
    if (!workflow || !safeEqual(workflow.webhook_secret, webhookSecret)) {
      return json(401, { error: 'Invalid workflow credentials.' })
    }
    if (workflow.status !== 'active') {
      return json(403, { error: 'Workflow is paused.' })
    }

    // 1b. Rate limit per workflow. Counts records created in the last minute.
    //     Not perfectly strict under a burst of simultaneous requests, but it stops a runaway sender fast.
    const { count: recentCount, error: rateError } = await supabase
      .from('logistics_records')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', workflowId)
      .gte('created_at', new Date(Date.now() - 60_000).toISOString())

    if (rateError) throw rateError
    if ((recentCount ?? 0) >= MAX_EVENTS_PER_MINUTE) {
      return json(429, { error: 'Rate limit exceeded for this workflow.' }, { 'Retry-After': '60' })
    }

    // 2. Balance check.
    const { data: balanceGuard, error: balanceError } = await supabase
      .from('token_spend_guard')
      .select('credits_remaining')
      .eq('tenant_id', tenantId)
      .maybeSingle()

    if (balanceError) throw balanceError
    if (!balanceGuard || balanceGuard.credits_remaining <= 0) {
      return json(402, { error: 'Execution blocked: Account balance depleted.' })
    }

    // 3. Queue the raw payload and keep its id so the worker updates exactly this row.
    const { data: record, error: insertError } = await supabase
      .from('logistics_records')
      .insert({
        tenant_id: tenantId,
        workflow_id: workflowId,
        raw_payload: body,
        processed_status: 'pending',
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    // 4. Dispatch to the Render worker. waitUntil keeps the request alive after the 202 is sent;
    //    a bare un-awaited fetch can be killed when the response returns.
    const dispatch = dispatchToWorker(
      `${workerUrl.replace(/\/+$/, '')}/api/v1/process-event`,
      internalToken,
      { tenantId, recordId: record.id, body },
    )
      .catch(async (err) => {
        console.error('Async worker dispatch error (all attempts failed):', err)
        // Make the failure visible instead of leaving the record "pending" forever.
        await supabase
          .from('logistics_records')
          .update({ processed_status: 'dispatch_failed' })
          .eq('id', record.id)
          .eq('processed_status', 'pending')
      })

    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(dispatch)

    return json(202, { status: 'success', message: 'Payload securely queued for optimization.' })
  } catch (error) {
    console.error('webhook-ingest failure:', error)
    return json(500, { error: 'Internal error.' })
  }
})
