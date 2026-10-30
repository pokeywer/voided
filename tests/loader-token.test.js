import test from 'node:test';
import assert from 'node:assert/strict';
import {
    issueLoaderToken,
    verifyLoaderToken,
    requestBinding
} from '../api/_loaderToken.js';

process.env.LOADER_TOKEN_SECRET = 'test-only-loader-secret-that-is-at-least-32-bytes-long';

const request = {
    headers: { 'x-forwarded-for': '203.0.113.10' },
    socket: { remoteAddress: '203.0.113.10' }
};

test('accepts a valid token for the matching vault, key, version and binding', () => {
    const binding = requestBinding(request);
    const issued = issueLoaderToken('vault-1', 'sample-key', 7, binding);
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'sample-key', 7, request), true);
});

test('rejects a token for a different vault, key or version', () => {
    const issued = issueLoaderToken('vault-1', 'sample-key', 7, requestBinding(request));
    assert.equal(verifyLoaderToken(issued.token, 'vault-2', 'sample-key', 7, request), false);
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'wrong-key', 7, request), false);
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'sample-key', 8, request), false);
});

test('rejects modified, malformed and expired tokens', () => {
    const issued = issueLoaderToken('vault-1', '', 0, requestBinding(request));
    const [payload, signature] = issued.token.split('.');
    const changedSignature = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    assert.equal(verifyLoaderToken(`${payload}.${changedSignature}`, 'vault-1', '', 0, request), false);
    assert.equal(verifyLoaderToken('not-a-token', 'vault-1', '', 0, request), false);

    const originalNow = Date.now;
    try {
        Date.now = () => issued.expiresAt + 1;
        assert.equal(verifyLoaderToken(issued.token, 'vault-1', '', 0, request), false);
    } finally {
        Date.now = originalNow;
    }
});

test('rejects a token presented from a different bound address', () => {
    const issued = issueLoaderToken('vault-1', '', 0, requestBinding(request));
    const otherRequest = {
        headers: { 'x-forwarded-for': '203.0.113.11' },
        socket: { remoteAddress: '203.0.113.11' }
    };
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', '', 0, otherRequest), false);
});
