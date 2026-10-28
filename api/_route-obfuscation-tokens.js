import { getAdminAuth } from './_admin.js';
import { sameOriginRequest } from './_adminSession.js';
import { consumeTokens, readTokens, websiteSubject } from './_obfuscationTokens.js';

// Website-direct obfuscation: the same daily allowance as the Discord link, but
// keyed to the signed-in browser account instead of a Discord user.
function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

async function signedInUser(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try { return await getAdminAuth().verifyIdToken(match[1]); }
    catch { return null; }
}

function tokenState(tokens) {
    return {
        credits: tokens.remaining,
        dailyRemaining: tokens.dailyRemaining,
        dailyLimit: tokens.dailyLimit,
        bonus: tokens.bonus,
        resetsAt: tokens.resetsAt
    };
}

export default async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (req.method === 'POST' && !sameOriginRequest(req)) {
        return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    }

    const user = await signedInUser(req);
    if (!user) return json(res, 401, { ok: false, message: 'Sign in to use the website obfuscator.' });

    const subject = websiteSubject(user.uid);

    try {
        if (req.method === 'GET') {
            const tokens = await readTokens(subject);
            return json(res, 200, { ok: true, ...tokenState(tokens) });
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (String(body.action || 'consume') !== 'consume') {
            return json(res, 400, { ok: false, message: 'Unsupported obfuscation action.' });
        }
        const tokens = await consumeTokens(subject);
        return json(res, 200, { ok: true, ...tokenState(tokens) });
    } catch (error) {
        const status = Number(error?.status) || 500;
        if (status >= 500) console.error('[obfuscation-tokens]', error);
        return json(res, status, {
            ok: false,
            resetsAt: Number(error?.resetsAt) || 0,
            message: status >= 500 ? 'Could not use a void token right now.' : String(error.message || 'Could not use a void token.')
        });
    }
}
