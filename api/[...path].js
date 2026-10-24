// Vercel deploys this catch-all as the single API function. The underscore-
// prefixed route modules below are bundled implementation files, not routes.
import adminAuth from './_route-admin-auth.js';
import adminDashboard from './_route-admin-dashboard.js';
import adminScripts from './_route-admin-scripts.js';
import adminVaults from './_route-admin-vaults.js';
import announcements from './_route-announcements.js';
import keypage from './_route-keypage.js';
import leaderboard from './_route-leaderboard.js';
import linkvertiseConfig from './_route-linkvertise-config.js';
import loaderToken from './_route-loader-token.js';
import payload from './_route-payload.js';
import raw from './_route-raw.js';
import scripts from './_route-scripts.js';
import vaultinfo from './_route-vaultinfo.js';
import verify from './_route-verify.js';

const handlers = {
    'admin-auth': adminAuth,
    'admin-dashboard': adminDashboard,
    'admin-scripts': adminScripts,
    'admin-vaults': adminVaults,
    announcements,
    keypage,
    leaderboard,
    'linkvertise-config': linkvertiseConfig,
    'loader-token': loaderToken,
    payload,
    raw,
    scripts,
    vaultinfo,
    verify
};

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
