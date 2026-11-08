const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMessage, parseLogisticsText } = require('../parser');

test('tons are converted to kg', () => {
    assert.deepEqual(parseLogisticsText('CONTAINER-ABC123 weighs 5 tons'), { trackingNumber: 'CONTAINER-ABC123', weightKg: 5000 });
    assert.equal(parseLogisticsText('2.5 tonnes').weightKg, 2500);
    assert.equal(parseLogisticsText('1 ton').weightKg, 1000);
});

test('kg stays kg, thousands separators handled', () => {
    assert.equal(parseLogisticsText('800 kgs').weightKg, 800);
    assert.equal(parseLogisticsText('1,200 kg').weightKg, 1200);
});

test('ISO container id', () => {
    assert.equal(parseLogisticsText('box mskU1234567 arrived').trackingNumber, 'MSKU1234567');
});

test('no match returns nulls, not fake values', () => {
    assert.deepEqual(parseLogisticsText('hello there'), { trackingNumber: null, weightKg: null });
    assert.deepEqual(parseLogisticsText(undefined), { trackingNumber: null, weightKg: null });
});

test('extractMessage: simple, nested, and WhatsApp Cloud shapes', () => {
    assert.deepEqual(extractMessage({ text: 'hi', from: '256700000001' }), { text: 'hi', from: '256700000001' });
    assert.deepEqual(extractMessage({ message: { text: 'yo', from: 5 } }), { text: 'yo', from: '5' });
    const wa = { entry: [{ changes: [{ value: { messages: [{ from: '256700000002', text: { body: 'CONTAINER-X1 3 tons' } }] } }] }] };
    assert.deepEqual(extractMessage(wa), { text: 'CONTAINER-X1 3 tons', from: '256700000002' });
});

test('extractMessage never throws on junk', () => {
    assert.deepEqual(extractMessage({}), { text: '', from: 'UNKNOWN' });
    assert.deepEqual(extractMessage({ message: { text: { weird: 1 } } }), { text: '', from: 'UNKNOWN' });
});

// ---------------------------------------------------------------------------
// Messy-payload simulation. These run offline: no network, no credits, no real data.
// ---------------------------------------------------------------------------

test('messy invoice: weight found even when the container id is not', () => {
    const invoice = 'INVOICE #00123\n\nShipper:  Kampala Exports Ltd\nCNTR NO: MSKU 1234567   GROSS WT:  12,500.50 KGS';
    assert.equal(parseLogisticsText(invoice).weightKg, 12500.5);
});

test('messy formatting: emoji, non-breaking spaces, CRLF, null bytes', () => {
    assert.deepEqual(parseLogisticsText('📦 CONTAINER-Z9 🚚 3 tonnes ✅'), { trackingNumber: 'CONTAINER-Z9', weightKg: 3000 });
    assert.equal(parseLogisticsText('CONTAINER-Z9\u00a03\u00a0tons').weightKg, 3000);
    assert.deepEqual(parseLogisticsText('CONTAINER-A1\r\n5\r\nkg'), { trackingNumber: 'CONTAINER-A1', weightKg: 5 });
    assert.equal(parseLogisticsText('CONTAINER-A1\u0000 5 kg').trackingNumber, 'CONTAINER-A1');
});

test('ambiguous number formats give null, never a wrong value', () => {
    // European "1.200,50" used to be read as 20050 kg.
    assert.equal(parseLogisticsText('CONTAINER-X1 1.200,50 kg').weightKg, null);
    assert.equal(parseLogisticsText('CONTAINER-X1 5,00 kg').weightKg, null);
    // An absurdly large number overflows to Infinity and must not be stored.
    assert.equal(parseLogisticsText(`CONTAINER-X1 ${'9'.repeat(400)} kg`).weightKg, null);
});

test('a phone number is not mistaken for a container id', () => {
    assert.deepEqual(parseLogisticsText('call 256700000000 about 5 tons'), { trackingNumber: null, weightKg: 5000 });
});

test('huge payload does not freeze the worker', () => {
    const start = Date.now();
    parseLogisticsText('1'.repeat(1_000_000));
    parseLogisticsText('A'.repeat(1_000_000));
    parseLogisticsText('CONTAINER-' + 'A'.repeat(1_000_000));
    assert.ok(Date.now() - start < 1000, 'parser took over 1s on a 1 MB message');
});

test('hostile input types never throw', () => {
    const junk = [null, undefined, 0, 42, true, [], [1, 2], {}, { a: { b: {} } }, () => 1, Symbol.iterator.description];
    for (const value of junk) {
        assert.doesNotThrow(() => parseLogisticsText(value));
        assert.doesNotThrow(() => extractMessage(value));
        assert.doesNotThrow(() => extractMessage({ message: value }));
        assert.doesNotThrow(() => extractMessage({ entry: value }));
    }
});

test('fuzz loop: 3000 random messy messages keep every invariant and cause no unhandled rejections', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    // Deterministic pseudo-random generator so a failure is reproducible.
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const tokens = [
        'CONTAINER-AB12', 'msku1234567', 'MSKU 1234567', 'INVOICE', '#', '5', '12,500', '1.200,50', '0', '-3', '2.5',
        'tons', 'TONNES', 'kg', 'KGS', 'MT', 'T', 'gross', 'net', ':', '\n', '\r\n', '\t', '  ', '📦', '\u0000', '\u00a0',
        '256700000000', '9'.repeat(50), '.', ',', '-', '/', 'null', 'undefined', '{"a":1}',
    ];

    for (let i = 0; i < 3000; i++) {
        let text = '';
        const length = Math.floor(rand() * 25);
        for (let j = 0; j < length; j++) text += pick(tokens) + (rand() < 0.5 ? ' ' : '');

        const result = parseLogisticsText(text);
        assert.ok(result.weightKg === null || (Number.isFinite(result.weightKg) && result.weightKg >= 0), `bad weight for ${JSON.stringify(text)}`);
        assert.ok(result.trackingNumber === null || /^(CONTAINER-[A-Z0-9]+|[A-Z]{4}\d{7})$/.test(result.trackingNumber), `bad id for ${JSON.stringify(text)}`);

        const message = extractMessage({ message: { text, from: pick(['256700000000', 5, null, {}, undefined]) } });
        assert.equal(typeof message.text, 'string');
        assert.equal(typeof message.from, 'string');
    }

    await new Promise((resolve) => setImmediate(resolve)); // let any pending rejection surface
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(rejections, []);
});
