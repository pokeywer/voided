// Shared Discord bot utilities — used by both interactions and admin routes.

export const getBotToken = () => process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '';

// ── Core Discord API wrapper ──────────────────────────────────────────────────
export async function discordApi(path, init = {}, retryCount = 0) {
    const token = getBotToken();
    if (!token) throw new Error('BOT_TOKEN is not set in Vercel environment variables.');
    const isForm = init.body instanceof FormData;
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${token}`,
            ...(isForm ? {} : { 'Content-Type': 'application/json' }),
            ...(init.headers || {})
        },
        signal: AbortSignal.timeout(20000)
    });
    const raw = await res.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    if (!res.ok) {
        if (res.status === 429) {
            const wait = Math.ceil((Number(res.headers.get('retry-after') || body.retry_after || 0)) * 1000) + 200;
            if (retryCount < 2 && wait <= 9000) {
                await new Promise(r => setTimeout(r, Math.max(300, wait)));
                return discordApi(path, init, retryCount + 1);
            }
        }
        throw new Error(String(body.message || `Discord API error ${res.status}`).slice(0, 300));
    }
    return body;
}

// ── Follow-up after deferred interaction ─────────────────────────────────────
export async function sendFollowUp(applicationId, interactionToken, payload) {
    return discordApi(`/webhooks/${applicationId}/${interactionToken}`, {
        method: 'POST',
        body: JSON.stringify(payload)
    });
}

// Edit the deferred "thinking" message with real content
export async function editFollowUp(applicationId, interactionToken, payload) {
    return discordApi(`/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
    });
}

// Send a file as a follow-up
export async function sendFollowUpFile(applicationId, interactionToken, filename, fileContent, message) {
    const token = getBotToken();
    if (!token) throw new Error('BOT_TOKEN not set.');
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
        content: message || '',
        allowed_mentions: { parse: [] }
    }));
    form.append('files[0]', new Blob([fileContent], { type: 'text/plain' }), filename);
    const res = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}` },
        body: form,
        signal: AbortSignal.timeout(25000)
    });
    const raw = await res.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    if (!res.ok) throw new Error(String(body.message || `Discord file upload error ${res.status}`).slice(0, 300));
    return body;
}

// Edit the original deferred message with a file
export async function editFollowUpFile(applicationId, interactionToken, filename, fileContent, embeds = []) {
    const token = getBotToken();
    if (!token) throw new Error('BOT_TOKEN not set.');
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ embeds, allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([fileContent], { type: 'text/plain' }), filename);
    const res = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${token}` },
        body: form,
        signal: AbortSignal.timeout(25000)
    });
    const raw = await res.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    if (!res.ok) throw new Error(String(body.message || `Discord file upload error ${res.status}`).slice(0, 300));
    return body;
}

// ── Leaderboard embed builder ─────────────────────────────────────────────────
const MEDALS = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.', '9.', '10.'];

function leaderboardRows(snap, limit = 10) {
    return snap.docs
        .map(doc => {
            const d = doc.data();
            return { title: String(d.title || 'Untitled').trim().slice(0, 32), executions: Number(d.executions) || 0 };
        })
        .filter(r => r.executions > 0)
        .slice(0, limit)
        .map((r, i) => `${MEDALS[i] || `**${i + 1}.**`} \`${r.title}\` — **${r.executions.toLocaleString()}** runs`)
        .join('\n') || '*No entries yet.*';
}

export async function buildLeaderboardEmbeds(db, period = 'all') {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const queries = [
        db.collection('siteActivityDaily').doc(today).get(),
        db.collection('activeUsersDaily').doc(today).collection('players').count().get()
    ];

    if (period === 'today' || period === 'all') {
        queries.push(
            db.collection('leaderboardDaily').doc(today).collection('vaults')
                .where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get()
        );
    }
    if (period === 'month' || period === 'all') {
        queries.push(
            db.collection('leaderboardMonthly').doc(month).collection('vaults')
                .where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get()
        );
    }
    if (period === 'overall' || period === 'all') {
        queries.push(
            db.collection('vaults').where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get()
        );
    }

    const results = await Promise.all(queries);
    const activitySnap = results[0];
    const activeUsersSnap = results[1];
    const activity = activitySnap.exists ? activitySnap.data() : {};
    const executionsToday = Number(activity.executions) || 0;
    const activeUsersToday = Number(activeUsersSnap.data().count) || 0;

    let snapIndex = 2;
    const embeds = [];

    if (period === 'today' || period === 'all') {
        const snap = results[snapIndex++];
        embeds.push({
            title: `📅 Today's Leaderboard — ${today}`,
            description: leaderboardRows(snap),
            color: 0x12b8d0,
            footer: { text: `VoidedX  •  ${executionsToday.toLocaleString()} executions today  •  ${activeUsersToday.toLocaleString()} active users  •  UTC` },
            timestamp: new Date().toISOString()
        });
    }
    if (period === 'month' || period === 'all') {
        const snap = results[snapIndex++];
        embeds.push({
            title: `📆 Monthly Leaderboard — ${month}`,
            description: leaderboardRows(snap),
            color: 0xa855f7,
            footer: { text: `VoidedX  •  This month  •  UTC` },
            timestamp: new Date().toISOString()
        });
    }
    if (period === 'overall' || period === 'all') {
        const snap = results[snapIndex++];
        embeds.push({
            title: '🏆 All-Time Leaderboard',
            description: leaderboardRows(snap),
            color: 0xfbbf24,
            footer: { text: `VoidedX  •  All-time top vaults  •  UTC` },
            timestamp: new Date().toISOString()
        });
    }

    return embeds;
}

// ── Stats embed ───────────────────────────────────────────────────────────────
export async function buildStatsEmbed(db) {
    const today = new Date().toISOString().slice(0, 10);
    const [activitySnap, vaultCountSnap, activeUsersSnap, activeVaultsSnap] = await Promise.all([
        db.collection('siteActivityDaily').doc(today).get(),
        db.collection('vaults').count().get(),
        db.collection('activeUsersDaily').doc(today).collection('players').count().get(),
        db.collection('leaderboardDaily').doc(today).collection('vaults').count().get()
    ]);
    const activity = activitySnap.exists ? activitySnap.data() : {};
    const executionsToday = Number(activity.executions) || 0;
    const totalVaults    = Number(vaultCountSnap.data().count) || 0;
    const activeUsers    = Number(activeUsersSnap.data().count) || 0;
    const activeVaults   = Number(activeVaultsSnap.data().count) || 0;

    return {
        title: '📊 VoidedX Live Stats',
        color: 0x12b8d0,
        fields: [
            { name: '⚡ Executions Today',  value: `**${executionsToday.toLocaleString()}**`,  inline: true },
            { name: '👥 Active Users Today', value: `**${activeUsers.toLocaleString()}**`,       inline: true },
            { name: '🗂️ Active Vaults Today',value: `**${activeVaults.toLocaleString()}**`,      inline: true },
            { name: '📦 Total Vaults',       value: `**${totalVaults.toLocaleString()}**`,       inline: true },
            { name: '📅 Tracking Date',      value: `\`${today}\` UTC`,                          inline: true }
        ],
        footer: { text: 'VoidedX  •  Live stats from Firestore' },
        timestamp: new Date().toISOString()
    };
}

// ── Vault info embed ──────────────────────────────────────────────────────────
export async function buildVaultEmbed(db, vaultId, siteUrl) {
    const snap = await db.collection('vaults').doc(vaultId).get();
    if (!snap.exists) return null;
    const d = snap.data();
    const title      = String(d.title || 'Untitled Vault').slice(0, 80);
    const executions = Number(d.executions) || 0;
    const requireKey = d.requireKey === true;
    const paused     = d.paused === true;
    const updated    = d.updatedAt ? new Date(d.updatedAt).toISOString().slice(0, 10) : 'unknown';
    return {
        title: `📦 ${title}`,
        color: paused ? 0x6b7280 : 0x12b8d0,
        fields: [
            { name: 'Vault ID',    value: `\`${vaultId}\``,                  inline: true },
            { name: 'Executions',  value: `**${executions.toLocaleString()}**`, inline: true },
            { name: 'Access',      value: requireKey ? '🔑 Key required' : '🌐 Public', inline: true },
            { name: 'Status',      value: paused ? '⏸️ Paused' : '✅ Active',  inline: true },
            { name: 'Last updated',value: updated,                            inline: true }
        ],
        url: `${siteUrl}/vault.html?id=${encodeURIComponent(vaultId)}`,
        footer: { text: 'VoidedX  •  Vault info' },
        timestamp: new Date().toISOString()
    };
}

// ── Auto-refresh: push leaderboard to a configured channel ───────────────────
export async function pushLeaderboardToChannel(db, channelId, siteUrl) {
    const token = getBotToken();
    if (!token || !channelId) return null;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const [overallSnap, dailySnap, monthlySnap, activitySnap, activeUsersSnap] = await Promise.all([
        db.collection('vaults').where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get(),
        db.collection('leaderboardDaily').doc(today).collection('vaults')
            .where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get(),
        db.collection('leaderboardMonthly').doc(month).collection('vaults')
            .where('executions', '>', 0).orderBy('executions', 'desc').limit(10).get(),
        db.collection('siteActivityDaily').doc(today).get(),
        db.collection('activeUsersDaily').doc(today).collection('players').count().get()
    ]);

    const activity       = activitySnap.exists ? activitySnap.data() : {};
    const executionsToday = Number(activity.executions) || 0;
    const activeUsers     = Number(activeUsersSnap.data().count) || 0;

    const embeds = [
        {
            title: `📅 Today — ${today}`,
            description: leaderboardRows(dailySnap),
            color: 0x12b8d0,
            footer: { text: `${executionsToday.toLocaleString()} executions  •  ${activeUsers.toLocaleString()} active users` }
        },
        {
            title: `📆 This Month — ${month}`,
            description: leaderboardRows(monthlySnap),
            color: 0xa855f7
        },
        {
            title: '🏆 All-Time Top',
            description: leaderboardRows(overallSnap),
            color: 0xfbbf24,
            timestamp: new Date().toISOString(),
            footer: { text: 'VoidedX  •  Auto-refreshes every 24h  •  UTC' }
        }
    ];

    const components = [{
        type: 1,
        components: [
            { type: 2, style: 5, label: 'Full Leaderboard', url: `${siteUrl}/leaderboard` },
            { type: 2, style: 5, label: 'Creator Panel',    url: `${siteUrl}/panel.html`  }
        ]
    }];

    // Check if we have an existing pinned message to edit
    const ref  = db.collection('settings').doc('discordBot');
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const existingMsgId = data.leaderboardBoardcast?.messageId;
    const existingChannelId = data.leaderboardBoardcast?.channelId;

    let messageId = null;
    if (existingMsgId && existingChannelId === channelId) {
        try {
            const patched = await discordApi(`/channels/${channelId}/messages/${existingMsgId}`, {
                method: 'PATCH',
                body: JSON.stringify({ embeds, components, allowed_mentions: { parse: [] } })
            });
            messageId = patched.id;
        } catch {
            messageId = null; // will post a fresh one below
        }
    }

    if (!messageId) {
        const posted = await discordApi(`/channels/${channelId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ embeds, components, allowed_mentions: { parse: [] } })
        });
        messageId = posted.id;
    }

    await ref.set({
        leaderboardBoardcast: { channelId, messageId, updatedAt: Date.now() }
    }, { merge: true });

    return messageId;
}
