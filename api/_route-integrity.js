import { db, FieldValue } from './_admin.js';
import { isBlockingFlags, normalizeFlags } from './_loaderShield.js';

const REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_REPORTS = 8;

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

function getClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    const reportToken = String(req.query?.session || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(reportToken)) {
        return json(res, 400, { ok: false, message: 'Missing or invalid report token.' });
    }
    const trace = String(req.query?.trace || '').toLowerCase();
    if (trace && !/^[a-f0-9]{16}$/.test(trace)) {
        return json(res, 400, { ok: false, message: 'Invalid delivery trace.' });
    }
    const flags = normalizeFlags(req.query?.flags);
    if (flags.length === 0) {
        return json(res, 200, { ok: true, block: false, recorded: false });
    }

    const ip = getClientIp(req);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    const now = Date.now();

    try {
        const found = await db.collection('sessions')
            .where('reportToken', '==', reportToken)
            .limit(1)
            .get();
        const session = found.empty ? null : found.docs[0].data();
        let delivery = null;
        if (!session && trace) {
            const snap = await db.collection('loaderDeliveries').doc(trace).get();
            if (snap.exists) delivery = snap.data();
        }

        if (!session && !delivery) {
            return json(res, 200, { ok: true, block: false, recorded: false });
        }

        let block = isBlockingFlags(flags);
        if (session) {
            const previous = Array.isArray(session.tamperFlags)
                ? session.tamperFlags.filter(flag => typeof flag === 'string')
                : [];
            const merged = [...new Set([...previous, ...flags])].slice(0, 32);
            block = session.blocked === true || isBlockingFlags(merged);
            if (Number(session.tamperReports) < MAX_SESSION_REPORTS) {
                try {
                    await found.docs[0].ref.update({
                        tamperFlags: merged,
                        blocked: block,
                        tamperIp: ip,
                        tamperUserAgent: userAgent,
                        tamperedAt: now,
                        tamperReports: FieldValue.increment(1)
                    });
                } catch {}
            }
        }

        const reportId = trace || session?.shieldTrace || delivery?.trace || reportToken;
        await db.collection('loaderIntegrityReports').doc(reportId).set({
            reportToken,
            trace: trace || session?.shieldTrace || delivery?.trace || null,
            vaultId: session?.vaultId || delivery?.vaultId || null,
            userId: session?.userId || delivery?.userId || null,
            flags: FieldValue.arrayUnion(...flags),
            reportCount: FieldValue.increment(1),
            blocked: block,
            ip,
            userAgent,
            lastReportAt: now,
            expiresAt: now + REPORT_TTL_MS
        }, { merge: true });

        return json(res, 200, { ok: true, block });
    } catch (error) {
        console.error('Could not record loader integrity report:', error);
        return json(res, 500, { ok: false, block: false, message: 'Could not record the integrity report.' });
    }
}