import { db, getAdminAuth } from './_admin.js';

const MAX_VAULTS = 25;
const MAX_PLAYERS = 80;

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

async function verifyOwner(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return { error: { status: 401, message: 'Sign in to see who ran your vaults.' } };
    try {
        const decoded = await getAdminAuth().verifyIdToken(match[1]);
        return { uid: decoded.uid };
    } catch {
        return { error: { status: 401, message: 'Your sign-in expired. Reload and try again.' } };
    }
}

// geo is a flat { CC: count } map written by recordExecution. Anything that is
// not a two-letter uppercase key is ignored so a bad write cannot leak through.
function readGeo(vault) {
    const geo = vault && typeof vault.geo === 'object' && vault.geo ? vault.geo : {};
    const countries = [];
    for (const [cc, raw] of Object.entries(geo)) {
        if (!/^[A-Z]{2}$/.test(cc)) continue;
        const count = Math.floor(Number(raw));
        if (!Number.isFinite(count) || count <= 0) continue;
        countries.push({ cc, executions: count });
    }
    return countries;
}

function readPlayerDoc(data) {
    const value = data && typeof data === 'object' ? data : {};
    const userId = /^\d{1,20}$/.test(String(value.userId || '')) ? String(value.userId) : null;
    return {
        username: typeof value.username === 'string' && value.username.trim()
            ? value.username.trim().slice(0, 32)
            : 'Unknown',
        userId,
        executor: typeof value.executor === 'string' && value.executor.trim()
            ? value.executor.trim().slice(0, 40)
            : null,
        hwid: typeof value.hwid === 'string' && value.hwid.trim()
            ? value.hwid.trim().slice(0, 96)
            : null,
        country: /^[A-Z]{2}$/.test(String(value.country || '')) ? String(value.country) : null,
        region: /^[A-Z0-9]{1,3}$/.test(String(value.region || '')) ? String(value.region) : null,
        runs: Math.max(0, Math.floor(Number(value.runs) || 0)),
        lastSeenAt: Math.max(0, Number(value.lastSeenAt) || 0)
    };
}

function playerIdentity(player) {
    if (player.userId) return `u:${player.userId}`;
    if (player.hwid) return `h:${player.hwid.toLowerCase()}`;
    return `n:${player.username.toLowerCase()}`;
}

async function readPlayers(vaultRef) {
    const snap = await vaultRef.collection('players').orderBy('lastSeenAt', 'desc').limit(MAX_PLAYERS).get();
    return snap.docs.map(doc => readPlayerDoc(doc.data()));
}

function mergePlayers(target, players) {
    for (const player of players) {
        const identity = playerIdentity(player);
        const existing = target.get(identity);
        if (!existing) {
            target.set(identity, { ...player });
            continue;
        }
        existing.runs += player.runs;
        if (player.lastSeenAt >= existing.lastSeenAt) {
            existing.lastSeenAt = player.lastSeenAt;
            existing.username = player.username;
            existing.executor = player.executor;
            existing.hwid = player.hwid;
            existing.country = player.country;
            existing.region = player.region;
        }
    }
}

function mergeCountries(target, countries) {
    for (const entry of countries) {
        target.set(entry.cc, (target.get(entry.cc) || 0) + entry.executions);
    }
}

function countryList(map) {
    return [...map.entries()]
        .map(([cc, executions]) => ({ cc, executions }))
        .sort((a, b) => b.executions - a.executions || a.cc.localeCompare(b.cc));
}

function playerList(map) {
    return [...map.values()]
        .sort((a, b) => b.runs - a.runs || b.lastSeenAt - a.lastSeenAt)
        .slice(0, MAX_PLAYERS);
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }

    const owner = await verifyOwner(req);
    if (owner.error) return json(res, owner.error.status, { ok: false, message: owner.error.message });

    const scopeAll = String(req.query?.all || '') === '1';
    const vaultId = String(req.query?.id || '');
    if (!scopeAll && !/^[A-Za-z0-9_-]{1,120}$/.test(vaultId)) {
        return json(res, 400, { ok: false, message: 'Missing or invalid vault ID.' });
    }

    try {
        if (!scopeAll) {
            const snap = await db.collection('vaults').doc(vaultId).get();
            if (!snap.exists) return json(res, 404, { ok: false, message: 'Vault not found.' });
            const vault = snap.data();
            if (vault.uid !== owner.uid) {
                return json(res, 403, { ok: false, message: 'Only this vault’s owner can see its activity.' });
            }

            const countries = readGeo(vault);
            const players = await readPlayers(snap.ref);
            return json(res, 200, {
                ok: true,
                scope: vaultId,
                totals: {
                    executions: Math.max(0, Math.floor(Number(vault.executions) || 0)),
                    countries: countries.length,
                    players: players.length,
                    lastRunAt: players.reduce((max, p) => Math.max(max, p.lastSeenAt), 0)
                },
                countries: countries.sort((a, b) => b.executions - a.executions),
                players
            });
        }

        const owned = await db.collection('vaults')
            .where('uid', '==', owner.uid)
            .limit(MAX_VAULTS)
            .get();

        const playersByIdentity = new Map();
        const countryTotals = new Map();
        let executions = 0;
        let vaults = 0;

        await Promise.all(owned.docs.map(async snap => {
            vaults += 1;
            const vault = snap.data() || {};
            executions += Math.max(0, Math.floor(Number(vault.executions) || 0));
            mergeCountries(countryTotals, readGeo(vault));
            mergePlayers(playersByIdentity, await readPlayers(snap.ref));
        }));

        const players = playerList(playersByIdentity);
        return json(res, 200, {
            ok: true,
            scope: 'all',
            totals: {
                executions,
                countries: countryTotals.size,
                players: playersByIdentity.size,
                vaults,
                lastRunAt: players.reduce((max, p) => Math.max(max, p.lastSeenAt), 0)
            },
            countries: countryList(countryTotals),
            players
        });
    } catch (error) {
        console.error('Vault activity failed:', error);
        return json(res, 500, { ok: false, message: 'Could not load vault activity.' });
    }
}
