import assert from 'node:assert/strict';
import test from 'node:test';

const { classifyAgent, inspectFetch } = await import('../api/_clientGate.js');

const requestWith = userAgent => ({ headers: { 'user-agent': userAgent } });

test('HTTP libraries are identified and refused while executors pass', () => {
    const blocked = [
        'undici', 'node', 'Node.js/20', 'node-fetch/1.1', 'axios/1.6.0', 'got/9.6.0',
        'python-requests/2.31.0', 'aiohttp/3.9', 'okhttp/4.12.0', 'Go-http-client/2.0',
        'curl/8.4.0', 'PostmanRuntime/7.36', 'insomnia/8.2', 'workerd', 'Cloudflare-Workers',
        'Vercel', 'headlessChrome/120', 'Selenium/4.15', 'python-urllib3/2.1'
    ];
    for (const agent of blocked) {
        assert.equal(classifyAgent(agent), 'client-library', `${agent} should be a client library`);
        assert.equal(inspectFetch(requestWith(agent)).block, true, `${agent} should be blocked`);
    }

    // The key and payload hops are fetched through whatever HTTP backend the
    // executor happens to use, and a phone executor can send a command-line or
    // platform client identity. Those are logged, not refused, so no runner is
    // locked out of its own loader. Server-side script runtimes stay refused.
    const portable = ['curl/8.4.0', 'Wget/1.21', 'okhttp/4.12.0', 'Java/1.8.0_352', 'NSUrlSession/1.0'];
    for (const agent of portable) {
        assert.equal(classifyAgent(agent, { toleratePortable: true }), 'other', `${agent} should only be logged on a gate hop`);
        assert.equal(inspectFetch(requestWith(agent), '', 'gate').block, false, `${agent} should pass a gate hop`);
        assert.equal(inspectFetch(requestWith(agent)).block, true, `${agent} should still be refused on the bootstrap link`);
    }
    for (const agent of ['python-requests/2.31.0', 'undici', 'Node.js/20', 'workerd']) {
        assert.equal(inspectFetch(requestWith(agent), '', 'gate').block, true, `${agent} should be blocked on a gate hop too`);
    }

    const allowed = [
        'Roblox/WinInet', 'Roblox/1.6.0', 'Synapse-X/1.0', 'Script-Ware', 'Krnl/1.0',
        'Fluxus/1.0', 'Delta/1.0', 'Codex', 'Hydrogen', 'Spore/1.0', 'Arceus X',
        'Volcano', 'Potassium', 'Macsploit', 'Nervum', 'JAViS', 'Bcore', 'orthus',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'some-unknown-agent/2', ''
    ];
    for (const agent of allowed) {
        assert.notEqual(classifyAgent(agent), 'client-library', `${agent} must not be blocked`);
        assert.equal(inspectFetch(requestWith(agent)).block, false, `${agent} should be allowed`);
    }
});

test('the guard can be turned down to observe or off', () => {
    process.env.LOADER_FETCH_GUARD = 'log';
    assert.equal(inspectFetch(requestWith('undici')).block, false);
    assert.equal(inspectFetch(requestWith('undici')).mode, 'log');
    process.env.LOADER_FETCH_GUARD = 'off';
    assert.equal(inspectFetch(requestWith('undici')).mode, 'off');
    assert.equal(inspectFetch(requestWith('undici')).block, false);
    delete process.env.LOADER_FETCH_GUARD;
    assert.equal(inspectFetch(requestWith('undici')).mode, 'enforce');
    assert.equal(inspectFetch(requestWith('undici')).block, true);
});

test('fingerprints are stable, short and never the raw agent', () => {
    const first = inspectFetch(requestWith('Roblox/WinInet')).fingerprint;
    const second = inspectFetch(requestWith('Roblox/WinInet')).fingerprint;
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{16}$/u);
    assert.ok(!first.includes('roblox'));
});
