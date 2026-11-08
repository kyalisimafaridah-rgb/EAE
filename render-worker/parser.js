'use strict';

// Container IDs: "CONTAINER-ABC123" or ISO 6346 style (4 letters + 7 digits).
const CONTAINER_RE = /\b(CONTAINER-[A-Z0-9]+|[A-Z]{4}\d{7})\b/i;

// "5 tons", "2.5 tonnes", "1,200 kg", "800 kgs". Tons are treated as metric tonnes.
// Commas must be proper thousands groups (1,200), and the number may not start in the middle of
// another number. Without that, European "1.200,50 kg" was silently read as 20050 kg; now it
// matches nothing and the weight stays null.
const WEIGHT_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(tonnes?|tons?|kilograms?|kgs?)\b/i;

function asText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.body === 'string') return value.body; // WhatsApp: text: { body }
  return '';
}

// Handles the WhatsApp Cloud API shape and the simple { message: { text, from } } / { text, from } shapes.
function extractMessage(body) {
  const wa = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const text = asText(wa?.text) || asText(body?.message?.text) || asText(body?.text);
  const rawFrom = wa?.from ?? body?.message?.from ?? body?.from;
  const from = typeof rawFrom === 'string' || typeof rawFrom === 'number' ? String(rawFrom) : 'UNKNOWN';
  return { text, from };
}

// WhatsApp messages max out at 4096 characters, so 5k is generous. The cap matters:
// WEIGHT_RE takes quadratic time on a long run of digits (80k digits froze it for ~17s),
// and a 1 MB payload would block the whole worker.
const MAX_TEXT_LENGTH = 5000;

// Returns kilograms, or null when no weight is found.
function parseLogisticsText(text) {
  const input = String(text || '').slice(0, MAX_TEXT_LENGTH);
  const containerMatch = input.match(CONTAINER_RE);
  const weightMatch = input.match(WEIGHT_RE);

  let weightKg = null;
  if (weightMatch) {
    const value = parseFloat(weightMatch[1].replace(/,/g, ''));
    const factor = /^(tonne|ton)/i.test(weightMatch[2]) ? 1000 : 1;
    if (Number.isFinite(value)) weightKg = Math.round(value * factor * 100) / 100;
  }

  return {
    trackingNumber: containerMatch ? containerMatch[0].toUpperCase() : null,
    weightKg,
  };
}

// True only for a complete container id. Used to check ids that did not come from the regex above
// (for example ids suggested by the AI fallback in llm.js).
const CONTAINER_EXACT_RE = /^(CONTAINER-[A-Z0-9]+|[A-Z]{4}\d{7})$/;
const isContainerId = (value) => typeof value === 'string' && CONTAINER_EXACT_RE.test(value);

module.exports = { extractMessage, parseLogisticsText, isContainerId };
