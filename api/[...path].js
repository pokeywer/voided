// Vercel deploys this catch-all as the single API function. The underscore-
// prefixed route modules below are bundled implementation files, not routes.
import adminAuth from './_route-admin-auth.js';
import adminDashboard from './_route-admin-dashboard.js';
import adminScripts from './_route-admin-scripts.js';
import adminOperations from './_route-admin-operations.js';
import adminVaults from './_route-admin-vaults.js';
import announcements from './_route-announcements.js';
import discordAdmin from './_route-discord-admin.js';
import discordInteractions from './_route-discord-interactions.js';
import gatewayConfig from './_route-gateway-config.js';
import gatewayPostback from './_route-gateway-postback.js';
import integrity from './_route-integrity.js';
import keypage from './_route-keypage.js';
import leaderboard from './_route-leaderboard.js';
import linkvertiseConfig from './_route-linkvertise-config.js';
import loaderToken from './_route-loader-token.js';
import obfuscationSession from './_route-obfuscation-session.js';
import payload from './_route-payload.js';
import raw from './_route-raw.js';
import scripts from './_route-scripts.js';
import staff from './_route-staff.js';
import vaultBackups from './_route-vault-backups.js';
import vaultinfo from './_route-vaultinfo.js';
import verify from './_route-verify.js';

const handlers = {
    'admin-auth': adminAuth,
    'admin-dashboard': adminDashboard,
    'admin-scripts': adminScripts,
    'admin-operations': adminOperations,
    'admin-vaults': adminVaults,
    announcements,
    'discord-admin': discordAdmin,
    'discord-interactions': discordInteractions,
    'gateway-config': gatewayConfig,
    'gateway-postback': gatewayPostback,
    integrity,
    keypage,
    leaderboard,
    'linkvertise-config': linkvertiseConfig,
    'loader-token': loaderToken,
    'obfuscation-session': obfuscationSession,
    payload,
    raw,
    scripts,
    staff,
    'vault-backups': vaultBackups,
    vaultinfo,
    verify
};

// Keep the project on one Vercel API function while preserving Discord's raw
// request bytes for Ed25519 signature validation.
export const config = { api: { bodyParser: false } };

async function readJsonBody(req) {
    if (['GET', 'HEAD'].includes(String(req.method || '').toUpperCase())) return;

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 12 * 1024 * 1024) {
            const error = new Error('Request body is too large.');
            error.status = 413;
            throw error;
        }
        chunks.push(buffer);
    }

    const rawBody = Buffer.concat(chunks);
    req.rawBody = rawBody;
    if (!rawBody.length) {
        req.body = {};
        return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
        req.body = {};
        return;
    }
    try {
        req.body = JSON.parse(rawBody.toString('utf8'));
    } catch {
        const error = new Error('Request body must be valid JSON.');
        error.status = 400;
        throw error;
    }
}

function routeName(req) {
    const routeParam = req.query?.path;
    const routeParts = Array.isArray(routeParam)
        ? routeParam
        : typeof routeParam === 'string'
            ? routeParam.split('/')
            : [];
    if (routeParts.length && routeParts[0]) return String(routeParts[0]);

    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    return pathname
        .replace(/^\/api\/?/, '')
        .replace(/\/+$/, '')
        .split('/')
        .filter(Boolean)[0] || '';
}

export default async function handler(req, res) {
    try {
        await readJsonBody(req);
    } catch (error) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(error.status || 400).json({ error: error.message || 'Invalid request body.' });
    }

    const name = routeName(req);
    const routeHandler = handlers[name];

    if (!routeHandler) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'API route not found.' });
    }

    try {
        return await routeHandler(req, res);
    } catch (error) {
        console.error(`[api:${name}]`, error);
        if (res.headersSent) return res.end();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(500).json({ error: 'The API request failed.' });
    }
}
