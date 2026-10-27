// Endpoint for the Creator Panel to pick up a queued obfuscate job from Discord.
// GET /api/discord-obfuscate-pickup?key=<tempKey>
import { db } from './_admin.js';

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    const key = String(req.query.key || '').trim();
    if (!/^[a-f0-9]{32}$/.test(key)) return json(res, 400, { ok: false, message: 'Invalid key.' });

    try {
        const ref  = db.collection('discordObfuscateQueue').doc(key);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { ok: false, message: 'No obfuscate job found — it may have expired.' });

        const data = snap.data();
        if (data.expiresAt && Date.now() > Number(data.expiresAt)) {
            await ref.delete().catch(() => {});
            return json(res, 410, { ok: false, message: 'This obfuscate link has expired. Run /obfuscate again.' });
        }

        // Return the job (source read once — delete after retrieval)
        await ref.delete().catch(() => {});
        return json(res, 200, {
            ok: true,
            source:   String(data.source || ''),
            level:    String(data.level  || 'auto'),
            filename: String(data.filename || 'script.lua')
        });
    } catch (err) {
        return json(res, 500, { ok: false, message: err.message });
    }
}
