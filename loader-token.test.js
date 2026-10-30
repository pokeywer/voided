import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deliveryAttestation,
    issueLoaderToken,
    requestBinding,
    verifyDeliveryAttestation,
    verifyLoaderToken
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

test('delivery attestation round-trips and returns the embedded token', () => {
    const issued = issueLoaderToken('vault-1', 'sample-key', 3, requestBinding(request));
    const attested = deliveryAttestation(issued.token, 'vault-1');
    assert.equal(verifyDeliveryAttestation(attested, 'vault-1'), issued.token);
});

test('delivery attestation is bound to its vault and cannot be forged', () => {
    const issued = issueLoaderToken('vault-1', 'sample-key', 3, requestBinding(request));
    const attested = deliveryAttestation(issued.token, 'vault-1');
    assert.equal(verifyDeliveryAttestation(attested, 'vault-2'), '');
    const [tokenPart, mac] = attested.split('.').length === 3
        ? [attested.slice(0, attested.lastIndexOf('.')), attested.slice(attested.lastIndexOf('.') + 1)]
        : ['', ''];
    assert.equal(verifyDeliveryAttestation(`${tokenPart}.${mac.replace(/.$/, '0')}`, 'vault-1'), '');
    assert.equal(verifyDeliveryAttestation('anything', 'vault-1'), '');
    assert.equal(verifyDeliveryAttestation('', 'vault-1'), '');
});

test('verify accepts a token only for the day and key hint it was minted with', () => {
    const issued = issueLoaderToken('vault-1', 'sample-key', 7, requestBinding(request));
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'sample-key', 7, request, { day: today }), true);
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'sample-key', 7, request, { day: '19990101' }), false);
    assert.equal(verifyLoaderToken(issued.token, 'vault-1', 'sample-key', 7, request, { kh: 'deadbeef' }), false);
});
