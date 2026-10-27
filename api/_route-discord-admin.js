import { db } from './_admin.js';
import { hasAdminSession, sameOriginRequest } from './_adminSession.js';
import { pushLeaderboardToChannel } from './_discordBot.js';
import {
    cleanChannelIds, cleanChannelMessages, DISCORD_APPLICATION_ID, DISCORD_CHANNELS,
    DISCORD_GUILD_ID, DISCORD_PUBLIC_KEY, DISCORD_SITE_URL, discordCommands,
} from './_discordConfig.js';

const CONFIG_REF = () => db.collection('settings').doc('discordBot');
const getBotToken = () => process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '';

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.status(status).json(body);
}

function configBody(data = {}) {
    // data is the raw Firestore doc, channels/messages extracted below
    const channelIds = cleanChannelIds(data.channels);
    const messages = cleanChannelMessages(data.messages);
    return {
        applicationId: DISCORD_APPLICATION_ID,
        publicKey: DISCORD_PUBLIC_KEY,
        guildId: DISCORD_GUILD_ID,
        siteUrl: DISCORD_SITE_URL,
        tokenConfigured: Boolean(getBotToken()),
        channels: DISCORD_CHANNELS.map(channel => ({
            ...channel,
            id: channelIds[channel.key],
            message: messages[channel.key]
        })),
        leaderboardChannelId: String(data.leaderboardChannelId || ''),
        leaderboardLastPush: Number(data.leaderboardLastPush) || 0
    };
}

async function discordRequest(path, init = {}, retryCount = 0) {
    const token = getBotToken();
    if (!token) throw new Error('Set BOT_TOKEN in the Vercel project environment before connecting the bot.');
    const response = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers || {})
        },
        signal: AbortSignal.timeout(12000)
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!response.ok) {
        if (response.status === 429) {
            const retryAfter = Math.max(0, Number(response.headers.get('retry-after')) || Number(body.retry_after) || 0);
            const waitMs = Math.ceil(retryAfter * 1000) + 150;
            if (retryCount < 2 && waitMs <= 8000) {
                await new Promise(resolve => setTimeout(resolve, Math.max(250, waitMs)));
                return discordRequest(path, init, retryCount + 1);
            }
            const waitSeconds = Math.max(1, Math.ceil(retryAfter));
            throw new Error(`Discord is rate-limiting setup. Wait about ${waitSeconds} seconds, then try again.`);
        }
        const detail = String(body.message || `Discord returned HTTP ${response.status}.`).slice(0, 300);
        throw new Error(detail);
    }
    return body;
}

async function registerCommands() {
    const route = `/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`;
    const managed = discordCommands();
    const managedKeys = new Set(managed.map(command => `${command.type || 1}:${command.name}`));
    const current = await discordRequest(route);
    const preserved = (Array.isArray(current) ? current : [])
        .filter(command => command?.name && !managedKeys.has(`${command.type || 1}:${command.name}`))
        .map(command => {
            const allowedFields = [
                'id', 'name', 'type', 'description', 'options', 'default_member_permissions',
                'dm_permission', 'default_permission', 'name_localizations', 'description_localizations',
                'nsfw', 'contexts', 'integration_types', 'handler'
            ];
            return Object.fromEntries(allowedFields
                .filter(field => Object.prototype.hasOwnProperty.call(command, field))
                .map(field => [field, command[field]]));
        });
    const result = await discordRequest(route, {
        method: 'PUT',
        body: JSON.stringify([...preserved, ...managed])
    });
    if (!Array.isArray(result)) throw new Error('Discord did not confirm the command update.');
    return result.filter(command => managedKeys.has(`${command.type || 1}:${command.name}`)).length;
}

async function publishPanels() {
    const ref = CONFIG_REF();
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    const channels = cleanChannelIds(data.channels);
    const messages = cleanChannelMessages(data.messages);
    const published = { ...(data.publishedMessages || {}) };
    const results = [];

    for (const channel of DISCORD_CHANNELS) {
        const channelId = channels[channel.key];
        if (!channelId) {
            results.push({ channel: channel.label, ok: false, message: 'Add this channel ID in the panel first.' });
            continue;
        }
        const embed = {
            title: channel.key === 'commands' ? 'VoidedX Creator Panel' : `VoidedX · ${channel.label}`,
            description: messages[channel.key].slice(0, 3800),
            color: 0x12b8d0,
            footer: { text: 'VOIDEDX  •  Official community panel' }
        };
        const messagePayload = {
            embeds: [embed],
            allowed_mentions: { parse: [] },
            ...(channel.key === 'commands' ? {
                components: [{ type: 1, components: [
                    { type: 2, style: 5, label: 'Open Creator Panel', url: `${DISCORD_SITE_URL}/panel.html` },
                    { type: 2, style: 5, label: 'Browse Scripts', url: `${DISCORD_SITE_URL}/scripts` }
                ] }]
            } : {})
        };
        const previous = published[channel.key];
        try {
            const channelInfo = await discordRequest(`/channels/${channelId}`);
            const isForum = Number(channelInfo.type) === 15;
            let result;
            let publishedThreadId = null;
            let publishedMessageId = null;
            if (isForum && previous?.channelId === channelId && previous?.threadId && previous?.messageId) {
                try {
                    result = await discordRequest(`/channels/${previous.threadId}/messages/${previous.messageId}`, {
                        method: 'PATCH', body: JSON.stringify(messagePayload)
                    });
                    publishedThreadId = previous.threadId;
                    publishedMessageId = previous.messageId;
                } catch (error) {
                    if (!/unknown message|404/i.test(error.message)) throw error;
                }
            } else if (!isForum && previous?.channelId === channelId && previous?.messageId) {
                try {
                    result = await discordRequest(`/channels/${channelId}/messages/${previous.messageId}`, {
                        method: 'PATCH', body: JSON.stringify(messagePayload)
                    });
                    publishedMessageId = previous.messageId;
                } catch (error) {
                    if (!/unknown message|404/i.test(error.message)) throw error;
                }
            }
            if (!result && isForum) {
                const requiredTag = channelInfo.require_tag === true && Array.isArray(channelInfo.available_tags)
                    ? channelInfo.available_tags.find(tag => tag?.id)?.id
                    : null;
                const threadPayload = {
                    name: `VoidedX - ${channel.label}`.slice(0, 100),
                    auto_archive_duration: 10080,
                    message: messagePayload,
                    ...(requiredTag ? { applied_tags: [requiredTag] } : {})
                };
                result = await discordRequest(`/channels/${channelId}/threads`, {
                    method: 'POST', body: JSON.stringify(threadPayload)
                });
                publishedThreadId = String(result.id || '');
                publishedMessageId = String(result.message?.id || result.last_message_id || result.id || '');
            } else if (!result) {
                if (![0, 5].includes(Number(channelInfo.type))) {
                    throw new Error('Choose a text, announcement, or forum channel for this panel.');
                }
                result = await discordRequest(`/channels/${channelId}/messages`, {
                    method: 'POST', body: JSON.stringify(messagePayload)
                });
                publishedMessageId = String(result.id || '');
            }
            published[channel.key] = {
                channelId,
                ...(publishedThreadId ? { threadId: publishedThreadId } : {}),
                messageId: publishedMessageId,
                updatedAt: Date.now()
            };
            results.push({ channel: channel.label, ok: true, message: 'Panel published.' });
        } catch (error) {
            results.push({ channel: channel.label, ok: false, message: error.message || 'Discord could not publish this panel.' });
        }
    }
    await ref.set({ channels, messages, publishedMessages: published, updatedAt: Date.now() }, { merge: true });
    return results;
}

export default async function handler(req, res) {
    if (!hasAdminSession(req)) return json(res, 401, { ok: false, message: 'Sign in through the VoidedX admin page first.' });

    if (req.method === 'GET') {
        try {
            const snap = await CONFIG_REF().get();
            return json(res, 200, { ok: true, config: configBody(snap.exists ? snap.data() : {}) });
        } catch (error) {
            console.error('Discord panel config could not be loaded:', error);
            return json(res, 503, { ok: false, message: 'Could not load Discord settings. Check the Firebase server connection.' });
        }
    }

    if (!['PATCH', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, PATCH, POST');
        return json(res, 405, { ok: false, message: 'Method not allowed.' });
    }
    if (!sameOriginRequest(req)) return json(res, 403, { ok: false, message: 'Request origin was rejected.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (req.method === 'PATCH') {
        const channels = cleanChannelIds(body.channels);
        const messages = cleanChannelMessages(body.messages);
        try {
            await CONFIG_REF().set({ channels, messages, updatedAt: Date.now() }, { merge: true });
            return json(res, 200, { ok: true, config: configBody({ channels, messages }) });
        } catch (error) {
            console.error('Discord panel settings could not be saved:', error);
            return json(res, 503, { ok: false, message: 'Could not save Discord settings.' });
        }
    }

    try {
        if (body.action === 'register') {
            const count = await registerCommands();
            return json(res, 200, { ok: true, message: `Registered or refreshed ${count} VoidedX slash commands for the configured server.`, count });
        }
        if (body.action === 'publish') {
            const results = await publishPanels();
            const successCount = results.filter(item => item.ok).length;
            return json(res, 200, { ok: true, message: `Published or updated ${successCount} of ${results.length} channel panels.`, results });
        }
        if (body.action === 'push-leaderboard') {
            const snap   = await CONFIG_REF().get();
            const data   = snap.exists ? snap.data() : {};
            const chId   = String(body.channelId || data.leaderboardChannelId || '');
            if (!/^\d{17,20}$/.test(chId)) {
                return json(res, 400, { ok: false, message: 'Set a valid leaderboard channel ID first.' });
            }
            const messageId = await pushLeaderboardToChannel(db, chId, DISCORD_SITE_URL);
            await CONFIG_REF().set({ leaderboardChannelId: chId, leaderboardLastPush: Date.now() }, { merge: true });
            return json(res, 200, { ok: true, message: `Leaderboard posted/updated in <#${chId}>.`, messageId });
        }
        if (body.action === 'set-leaderboard-channel') {
            const chId = String(body.channelId || '').trim();
            if (!/^\d{17,20}$/.test(chId)) return json(res, 400, { ok: false, message: 'Provide a valid channel ID.' });
            await CONFIG_REF().set({ leaderboardChannelId: chId }, { merge: true });
            return json(res, 200, { ok: true, message: 'Leaderboard channel saved.' });
        }
        return json(res, 400, { ok: false, message: 'Choose register or publish.' });
    } catch (error) {
        const missingToken = !getBotToken();
        return json(res, missingToken ? 503 : 502, {
            ok: false,
            message: missingToken ? error.message : `Discord setup failed: ${error.message || 'Unknown Discord API error.'}`
        });
    }
}
// ──────────────────────────────────────────────────────────────────────────────
// Appended: leaderboard channel push + auto-refresh config
// ──────────────────────────────────────────────────────────────────────────────
