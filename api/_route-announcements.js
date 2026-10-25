import { randomBytes } from 'node:crypto';
import { db } from './_admin.js';
import { hasAdminSession, sameOriginRequest } from './_adminSession.js';

function json(res, status, body, cache = 'no-store') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cache);
    return res.status(status).json(body);
}

function safeHttpUrl(value) {
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

function normalizeAnnouncement(item, fallbackId = '') {
    if (!item || typeof item !== 'object') return null;
    const title = String(item.title || '').slice(0, 80);
    const message = String(item.message || '').slice(0, 500);
    if (!title || !message) return null;
    return {
        id: String(item.id || fallbackId || randomBytes(12).toString('hex')),
        title,
        message,
        kind: ['info', 'success', 'warning'].includes(item.kind) ? item.kind : 'info',
        displayMode: item.displayMode === 'modal' ? 'modal' : 'banner',
        link: safeHttpUrl(String(item.link || '').trim()) || '',
        linkLabel: String(item.linkLabel || 'Learn more').slice(0, 32),
        dismissible: item.dismissible === true,
        expiresAt: Math.max(0, Number(item.expiresAt) || 0),
        enabled: item.enabled !== false,
        updatedAt: Number(item.updatedAt) || 0
    };
}

function announcementsFrom(data) {
    if (!data) return [];
    if (Array.isArray(data.announcements)) return data.announcements.map(item => normalizeAnnouncement(item)).filter(Boolean);
    const legacy = normalizeAnnouncement(data, 'legacy');
    return legacy ? [legacy] : [];
}

export default async function handler(req, res) {
    const ref = db.collection('siteSettings').doc('announcement');

    if (req.method === 'GET') {
        try {
            const snap = await ref.get();
            const all = announcementsFrom(snap.exists ? snap.data() : null);
            const adminView = hasAdminSession(req);
            const announcements = (adminView ? all : all.filter(item => item.enabled))
                .filter(item => adminView || !item.expiresAt || item.expiresAt > Date.now());
            return json(res, 200, {
                ok: true,
                announcements,
                announcement: announcements.find(item => item.enabled) || null
            });
        } catch (err) {
            console.error('Could not load announcements:', err);
            return json(res, 500, { ok: false, message: 'Could not load announcements.' });
        }
    }

    if (!['POST', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST, DELETE');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (!sameOriginRequest(req)) return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    if (!hasAdminSession(req)) return json(res, 401, { ok: false, message: 'Sign in as an administrator first.' });

    try {
        const snap = await ref.get();
        const data = snap.exists ? snap.data() : null;
        const announcements = announcementsFrom(data);
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        if (req.method === 'DELETE') {
            const id = String(body.id || '');
            if (id) {
                const next = announcements.filter(item => item.id !== id);
                if (next.length === announcements.length) return json(res, 404, { ok: false, message: 'Announcement not found.' });
                await ref.set({ announcements: next, updatedAt: Date.now() }, { merge: true });
                return json(res, 200, { ok: true, announcements: next });
            }
            await ref.set({ announcements: [], updatedAt: Date.now() }, { merge: true });
            return json(res, 200, { ok: true, announcements: [] });
        }

        const title = String(body.title || '').trim();
        const message = String(body.message || '').trim();
        const link = safeHttpUrl(String(body.link || '').trim());
        const linkLabel = String(body.linkLabel || 'Learn more').trim();
        const kind = String(body.kind || 'info');
        const displayMode = body.displayMode === 'modal' ? 'modal' : body.displayMode === 'banner' || body.displayMode === undefined ? 'banner' : null;
        const dismissible = body.dismissible === true;
        const expiresAtInput = body.expiresAt;
        const expiresAt = expiresAtInput === undefined || expiresAtInput === null || expiresAtInput === '' ? 0 : Number(expiresAtInput);

        if (!title || title.length > 80) return json(res, 400, { ok: false, message: 'Title must be 1–80 characters.' });
        if (!message || message.length > 500) return json(res, 400, { ok: false, message: 'Message must be 1–500 characters.' });
        if (link === null) return json(res, 400, { ok: false, message: 'Link must be a valid http or https URL.' });
        if (linkLabel.length > 32) return json(res, 400, { ok: false, message: 'Link text must be 32 characters or fewer.' });
        if (!['info', 'success', 'warning'].includes(kind)) return json(res, 400, { ok: false, message: 'Choose a valid announcement style.' });
        if (!displayMode) return json(res, 400, { ok: false, message: 'Choose a valid announcement display.' });
        if (!Number.isFinite(expiresAt) || (expiresAt !== 0 && expiresAt <= Date.now())) return json(res, 400, { ok: false, message: 'Choose a future expiration time or leave it blank.' });

        const existingIndex = body.id ? announcements.findIndex(item => item.id === String(body.id)) : -1;
        if (body.id && existingIndex < 0) return json(res, 404, { ok: false, message: 'Announcement not found.' });
        if (existingIndex < 0 && announcements.length >= 20) return json(res, 400, { ok: false, message: 'You can save up to 20 announcements.' });
        const now = Date.now();
        const announcement = {
            id: existingIndex >= 0 ? announcements[existingIndex].id : randomBytes(12).toString('hex'),
            title, message, kind, displayMode, link,
            linkLabel: link ? (linkLabel || 'Learn more') : '',
            dismissible, expiresAt,
            enabled: body.enabled !== false,
            updatedAt: now
        };
        const next = [...announcements];
        if (existingIndex >= 0) next[existingIndex] = announcement;
        else next.unshift(announcement);
        await ref.set({ announcements: next, updatedAt: now }, { merge: true });
        return json(res, 200, { ok: true, announcement, announcements: next });
    } catch (err) {
        console.error('Could not update announcements:', err);
        return json(res, 500, { ok: false, message: 'Could not update announcements.' });
    }
}
