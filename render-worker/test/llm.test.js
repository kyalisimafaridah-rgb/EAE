const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, createExtractor, MAX_INPUT_CHARS, MAX_OUTPUT_TOKENS } = require('../llm');

const ENV = {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'test-model',
    DEEPSEEK_INPUT_USD_PER_M: '0.44',
    DEEPSEEK_OUTPUT_USD_PER_M: '1.32',
    CREDITS_PER_USD: '1000',
};
const config = loadConfig(ENV);
const noWait = { sleep: async () => {} };

// Builds a fake fetch. Each item is a status code, 'net' (network error) or { status, body }.
function fakeFetch(sequence) {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        const next = sequence[Math.min(calls.length - 1, sequence.length - 1)];
        if (next === 'net') throw new Error('network down');
        const { status, body } = typeof next === 'number' ? { status: next, body: {} } : next;
        return new Response(JSON.stringify(body), { status });
    };
    return { impl, calls };
}

const answer = (content, usage = { prompt_tokens: 1000, completion_tokens: 100 }) => ({
    status: 200,
    body: { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage },
});

test('loadConfig: off without a key, strict when half-configured', () => {
    assert.equal(loadConfig({}), null);
    assert.throws(() => loadConfig({ DEEPSEEK_API_KEY: 'k' }), /DEEPSEEK_MODEL.*CREDITS_PER_USD/);
    assert.throws(() => loadConfig({ ...ENV, CREDITS_PER_USD: 'abc' }), /CREDITS_PER_USD/);
    assert.throws(() => loadConfig({ ...ENV, DEEPSEEK_INPUT_USD_PER_M: '0' }), /DEEPSEEK_INPUT_USD_PER_M/);
    assert.equal(config.model, 'test-model');
});

test('happy path: extracts, converts tonnes, and prices from the reported usage', async () => {
    const { impl, calls } = fakeFetch([answer({ container_id: 'MSKU 1234567', weight_value: 12.5, weight_unit: 'tonnes' })]);
    const extract = createExtractor(config, { fetchImpl: impl, ...noWait });
    const result = await extract('CNTR NO: MSKU 1234567 GROSS WT 12.5 tonnes');

    assert.deepEqual(result, { trackingNumber: 'MSKU1234567', weightKg: 12500, costCredits: 0.572 });
    // (1000 * 0.44 + 100 * 1.32) / 1e6 USD * 1000 credits per USD = 0.572

    const sent = calls[0];
    assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
    assert.equal(sent.body.model, 'test-model');
    assert.equal(sent.body.max_tokens, MAX_OUTPUT_TOKENS);
    assert.deepEqual(sent.body.thinking, { type: 'disabled' });
    assert.deepEqual(sent.body.response_format, { type: 'json_object' });
    assert.match(sent.body.messages[0].content, /json/i);
});

test('input sent to the model is capped', async () => {
    const { impl, calls } = fakeFetch([answer({ container_id: null, weight_value: null, weight_unit: null })]);
    await createExtractor(config, { fetchImpl: impl, ...noWait })('x'.repeat(100_000));
    assert.equal(calls[0].body.messages[1].content.length, MAX_INPUT_CHARS);
});

test('an invented container id is rejected, but the tokens are still charged', async () => {
    const { impl } = fakeFetch([answer({ container_id: 'MSKU7654321', weight_value: null, weight_unit: null })]);
    const result = await createExtractor(config, { fetchImpl: impl, ...noWait })('cargo arrived, container number not given');
    assert.equal(result.trackingNumber, null);
    assert.ok(result.costCredits > 0);
});

test('malformed container ids are rejected', async () => {
    for (const bad of ['NOT-AN-ID', 'MSK1234567', 123, ['MSKU1234567'], '']) {
        const { impl } = fakeFetch([answer({ container_id: bad, weight_value: null, weight_unit: null })]);
        const result = await createExtractor(config, { fetchImpl: impl, ...noWait })('MSKU1234567');
        assert.equal(result.trackingNumber, null, `accepted ${JSON.stringify(bad)}`);
    }
});

test('bad weights are rejected: unknown unit, negative, text, infinity, missing unit', async () => {
    const cases = [
        { weight_value: 5, weight_unit: 'lbs' },
        { weight_value: -5, weight_unit: 'kg' },
        { weight_value: '5', weight_unit: 'kg' },
        { weight_value: 5, weight_unit: null },
        { weight_value: 1e308, weight_unit: 'tonnes' },
    ];
    for (const weight of cases) {
        const { impl } = fakeFetch([answer({ container_id: 'MSKU1234567', ...weight })]);
        const result = await createExtractor(config, { fetchImpl: impl, ...noWait })('MSKU1234567 5');
        assert.equal(result.weightKg, null, `accepted ${JSON.stringify(weight)}`);
    }
});

test('non-JSON, fenced JSON and empty answers do not throw', async () => {
    const run = async (content) => createExtractor(config, { fetchImpl: fakeFetch([answer(content)]).impl, ...noWait })('MSKU1234567 5 kg');

    assert.equal((await run('sorry, I cannot help')).trackingNumber, null);
    assert.equal((await run('')).trackingNumber, null);
    assert.equal((await run('null')).trackingNumber, null);
    const fenced = await run('```json\n{"container_id":"MSKU1234567","weight_value":5,"weight_unit":"kg"}\n```');
    assert.deepEqual([fenced.trackingNumber, fenced.weightKg], ['MSKU1234567', 5]);
});

test('missing usage is charged at the worst case, not zero', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { choices: [{ message: { content: '{}' } }] } }]);
    const result = await createExtractor(config, { fetchImpl: impl, ...noWait })('hello');
    assert.ok(result.costCredits > 0);
});

test('retries 429/5xx and network errors, not 4xx', async () => {
    const run = async (sequence, text = 'MSKU1234567') => {
        const { impl, calls } = fakeFetch(sequence);
        const result = await createExtractor(config, { fetchImpl: impl, ...noWait })(text);
        return { result, calls: calls.length };
    };
    const ok = answer({ container_id: 'MSKU1234567', weight_value: null, weight_unit: null });

    assert.equal((await run([503, ok])).calls, 2);
    assert.equal((await run([429, ok])).result.trackingNumber, 'MSKU1234567');
    assert.equal((await run(['net', ok])).calls, 2);
    assert.deepEqual(await run([500]), { result: null, calls: 2 });   // gives up after 2 attempts
    assert.deepEqual(await run([401]), { result: null, calls: 1 });   // bad key: no retry
    assert.deepEqual(await run([402]), { result: null, calls: 1 });   // empty balance: no retry
    assert.deepEqual(await run([400]), { result: null, calls: 1 });
});

test('a failed call charges nothing (returns null)', async () => {
    const { impl } = fakeFetch(['net']);
    assert.equal(await createExtractor(config, { fetchImpl: impl, ...noWait })('MSKU1234567'), null);
});

test('empty text makes no call', async () => {
    const { impl, calls } = fakeFetch([200]);
    const extract = createExtractor(config, { fetchImpl: impl, ...noWait });
    for (const value of ['', '   \n', null, undefined]) assert.equal(await extract(value), null);
    assert.equal(calls.length, 0);
});

test('per-minute call cap stops spending, then resets', async () => {
    let clock = 1_000_000;
    const { impl, calls } = fakeFetch([answer({ container_id: null, weight_value: null, weight_unit: null })]);
    const extract = createExtractor({ ...config, maxCallsPerMinute: 2 }, { fetchImpl: impl, ...noWait, now: () => clock });

    assert.notEqual(await extract('one'), null);
    assert.notEqual(await extract('two'), null);
    assert.equal(await extract('three'), null);
    assert.equal(calls.length, 2);

    clock += 61_000;
    assert.notEqual(await extract('four'), null);
    assert.equal(calls.length, 3);
});

test('never throws, even when fetch itself blows up in odd ways', async () => {
    const weird = [
        async () => { throw 'a string, not an Error'; },
        async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
        async () => ({ ok: false, status: 500, text: async () => { throw new Error('no body'); } }),
        async () => ({ ok: true, json: async () => null }),
    ];
    for (const fetchImpl of weird) {
        const result = await createExtractor(config, { fetchImpl, ...noWait })('MSKU1234567');
        assert.ok(result === null || typeof result === 'object');
    }
});
