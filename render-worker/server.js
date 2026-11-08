'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { extractMessage, parseLogisticsText } = require('./parser');
const { loadConfig, createExtractor } = require('./llm');

// Fail fast. Without this, a missing INTERNAL_SECRET_TOKEN turns the auth check
// into `Bearer undefined`, which anyone can send.
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'INTERNAL_SECRET_TOKEN']) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// Optional AI fallback (DeepSeek) for messages the regex parser cannot read. Off unless DEEPSEEK_API_KEY is set.
let aiConfig = null;
try {
    aiConfig = loadConfig();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
const extractWithAI = aiConfig ? createExtractor(aiConfig) : null;
console.log(aiConfig ? `DeepSeek fallback enabled (model: ${aiConfig.model})` : 'DeepSeek fallback disabled (DEEPSEEK_API_KEY not set)');

const app = express();
app.use(express.json({ limit: '1mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_AUTH = Buffer.from(`Bearer ${process.env.INTERNAL_SECRET_TOKEN}`);

// Ensures requests come from our Supabase Edge Function (constant-time compare).
const validateSecret = (req, res, next) => {
    const received = Buffer.from(req.headers.authorization || '');
    if (received.length !== EXPECTED_AUTH.length || !crypto.timingSafeEqual(received, EXPECTED_AUTH)) {
        return res.status(401).json({ error: 'Unauthorized infrastructure access attempt.' });
    }
    next();
};

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/v1/process-event', validateSecret, async (req, res) => {
    const { tenantId, recordId, body } = req.body || {};

    if (!UUID_RE.test(tenantId || '') || !UUID_RE.test(recordId || '') || typeof body !== 'object' || body === null) {
        return res.status(400).json({ error: 'tenantId, recordId and body are required.' });
    }

    try {
        const { text, from: senderPhone } = extractMessage(body);
        let { trackingNumber, weightKg } = parseLogisticsText(text);

        // Regex found no container id: ask DeepSeek. Only for a record that is still pending, so a
        // retry of an already-processed record never spends tokens twice.
        let aiCredits = 0;
        if (!trackingNumber && text && extractWithAI) {
            const { data: current } = await supabase
                .from('logistics_records')
                .select('processed_status')
                .eq('id', recordId)
                .eq('tenant_id', tenantId)
                .maybeSingle();

            if (current?.processed_status === 'pending') {
                const ai = await extractWithAI(text);
                if (ai) {
                    trackingNumber = ai.trackingNumber;
                    weightKg = weightKg ?? ai.weightKg;
                    aiCredits = ai.costCredits; // charged even if the model found nothing: the tokens were used
                }
            }
        }

        // Nothing recognisable in the message: flag for a human instead of marking it completed.
        const status = trackingNumber ? 'completed' : 'needs_review';

        // 1. Update ONLY the record this event created, and only if still pending.
        //    The pending gate also makes retries safe: a record is processed and billed once.
        const { data: updated, error: dbError } = await supabase
            .from('logistics_records')
            .update({
                tracking_number: trackingNumber,
                cargo_weight: weightKg,
                client_phone: senderPhone,
                processed_status: status,
            })
            .eq('id', recordId)
            .eq('tenant_id', tenantId)
            .eq('processed_status', 'pending')
            .select('id');

        if (dbError) throw dbError;
        if (!updated || updated.length === 0) {
            return res.status(409).json({ error: 'Record not found or already processed.' });
        }

        // 2. Deduct credits (pauses the tenant's workflows when the balance hits zero).
        //    Flat cost per event, plus the real DeepSeek cost when the AI fallback was used.
        const estimatedTokenCost = 15.5;
        const { error: rpcError } = await supabase.rpc('deduct_tenant_credits', {
            target_tenant_id: tenantId,
            cost_amount: estimatedTokenCost + aiCredits,
        });
        if (rpcError) throw rpcError;

        // 3. Outbound notification (placeholder).
        console.log(`[OUTBOUND ALERT] phone: ${senderPhone}, tracking: ${trackingNumber ?? 'none'}, status: ${status}`);

        return res.status(200).json({ status: 'Processing cycle finalized cleanly.', recordStatus: status });
    } catch (error) {
        console.error('Worker pipeline runtime failure:', error);
        return res.status(500).json({ error: 'System runtime execution exception.', details: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Automation worker engine active on channel port ${PORT}`));
