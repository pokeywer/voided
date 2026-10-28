import {
    consumeObfuscationToken, getObfuscationSession, isValidObfuscationToken, sessionTokens
} from './_obfuscationSessions.js';

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

function tokenFrom(req) {
    const raw = req.query?.vx ?? req.query?.token;
    return typeof raw === 'string' ? raw.trim() : '';
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
    if (req.method === 'GET') {
        const token = tokenFrom(req);
        if (!isValidObfuscationToken(token)) {
            return json(res, 400, { ok: false, message: 'This obfuscation link is not valid. Run /obfuscate again in Discord.' });
        }
        try {
            const session = await getObfuscationSession(token);
            if (!session) {
                return json(res, 404, { ok: false, message: 'This obfuscation link is invalid or has expired. Run /obfuscate again in Discord.' });
            }
            const tokens = await sessionTokens(session);
            return json(res, 200, {
                ok: true,
                ...tokenState(tokens),
                source: typeof session.initialSource === 'string' ? session.initialSource : '',
                level: typeof session.initialLevel === 'string' ? session.initialLevel : 'auto',
                filename: typeof session.filename === 'string' ? session.filename : 'script.lua',
                discordUsername: typeof session.discordUsername === 'string' ? session.discordUsername : '',
                createdAt: Number(session.createdAt) || 0,
                expiresAt: Number(session.expiresAt) || 0
            });
        } catch (error) {
            console.error('[obfuscation-session:get]', error);
            return json(res, 500, { ok: false, message: 'Could not load this obfuscation link.' });
        }
    }

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = String(body.vx || body.token || '').trim();
    if (!isValidObfuscationToken(token)) {
        return json(res, 400, { ok: false, message: 'This obfuscation link is not valid.' });
    }
    if (String(body.action || '') !== 'consume') {
        return json(res, 400, { ok: false, message: 'Unsupported obfuscation action.' });
    }

    try {
        const result = await consumeObfuscationToken(token);
        return json(res, 200, { ok: true, ...tokenState(result) });
    } catch (error) {
        const status = Number(error?.status) || 500;
        if (status >= 500) console.error('[obfuscation-session:consume]', error);
        return json(res, status, {
            ok: false,
            resetsAt: Number(error?.resetsAt) || 0,
            message: status >= 500 ? 'Could not use a void token right now.' : String(error.message || 'Could not use a void token.')
        });
    }
}
