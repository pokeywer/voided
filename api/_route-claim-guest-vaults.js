import { db, getAdminAuth } from './_admin.js';
import { sameOriginRequest } from './_adminSession.js';

// Guest sessions are retired: when a leftover anonymous session signs in, the
// vaults it owns are moved onto the account that just signed in. The caller
// must prove both identities, so nobody can claim another account's vaults.

const BATCH_SIZE = 400;

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

function providerOf(decoded) {
    return String(decoded?.firebase?.sign_in_provider || '');
}

async function verifyBearer(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try {
        return await getAdminAuth().verifyIdToken(match[1]);
    } catch {
        return null;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (!sameOriginRequest(req)) {
        return json(res, 403, { ok: false, message: 'Request origin was rejected.' });
    }

    const user = await verifyBearer(req);
    if (!user) return json(res, 401, { ok: false, message: 'Sign in to move guest vaults.' });
    if (providerOf(user) === 'anonymous') {
        return json(res, 403, { ok: false, message: 'Create an account to keep guest vaults.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const guestToken = String(body.guestToken || '').trim();
    if (!guestToken) return json(res, 400, { ok: false, message: 'The guest session was not provided.' });

    let guest;
    try {
        guest = await getAdminAuth().verifyIdToken(guestToken);
    } catch {
        return json(res, 401, { ok: false, message: 'The guest session has expired. Sign in again to move its vaults.' });
    }
    if (providerOf(guest) !== 'anonymous') {
        return json(res, 400, { ok: false, message: 'Only guest sessions can be moved.' });
    }
    if (guest.uid === user.uid) return json(res, 200, { ok: true, moved: 0 });

    try {
        const snapshot = await db.collection('vaults').where('uid', '==', guest.uid).get();
        if (snapshot.empty) return json(res, 200, { ok: true, moved: 0 });

        const refs = snapshot.docs.map(doc => doc.ref);
        for (let index = 0; index < refs.length; index += BATCH_SIZE) {
            const batch = db.batch();
            for (const ref of refs.slice(index, index + BATCH_SIZE)) {
                batch.update(ref, { uid: user.uid });
            }
            await batch.commit();
        }
        return json(res, 200, { ok: true, moved: refs.length });
    } catch (error) {
        console.error('[claim-guest-vaults]', error);
        return json(res, 500, { ok: false, message: 'Guest vaults could not be moved right now.' });
    }
}
