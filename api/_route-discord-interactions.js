import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { db } from './_admin.js';
import {
    cleanChannelIds, cleanChannelMessages, DEFAULT_CHANNEL_MESSAGES, DISCORD_CHANNELS,
    DISCORD_GUILD_ID, DISCORD_PUBLIC_KEY, DISCORD_SITE_URL
} from './_discordConfig.js';

const COMMAND_CHANNEL = Object.fromEntries(DISCORD_CHANNELS.map(channel => [channel.command, channel.key]));
const KEY_PAGE_COMMANDS = new Set(['help', 'panel', 'scripts', 'verify']);

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

function verifyDiscordRequest(req) {
    const signature = String(req.headers['x-signature-ed25519'] || '');
    const timestamp = String(req.headers['x-signature-timestamp'] || '');
    const rawBody = req.rawBody;
    if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{1,20}$/.test(timestamp) || !Buffer.isBuffer(rawBody)) return false;
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
    try {
        const rawPublicKey = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
        if (rawPublicKey.length !== 32) return false;
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, rawPublicKey]), format: 'der', type: 'spki' });
        const signedContent = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
        return verifySignature(null, signedContent, publicKey, Buffer.from(signature, 'hex'));
    } catch {
        return false;
    }
}

function respond(res, content) {
    return json(res, 200, {
        type: 4,
        data: {
            content: String(content || '').slice(0, 1950),
            flags: 64,
            allowed_mentions: { parse: [] }
        }
    });
}

function commandOption(interaction, name) {
    const options = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
    const item = options.find(option => option?.name === name);
    return item ? String(item.value || '') : '';
}

async function getChannelSettings() {
    let timer;
    try {
        const snap = await Promise.race([
            db.collection('settings').doc('discordBot').get(),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 900); })
        ]);
        const data = snap?.exists ? snap.data() : {};
        return { channels: cleanChannelIds(data.channels), messages: cleanChannelMessages(data.messages) };
    } catch {
        return { channels: cleanChannelIds({}), messages: { ...DEFAULT_CHANNEL_MESSAGES } };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function resolveChannelId(interaction) {
    const current = String(interaction.channel_id || '');
    const parent = String(interaction.channel?.parent_id || '');
    return { current, parent };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { error: 'Method not allowed.' });
    }
    if (!verifyDiscordRequest(req)) return json(res, 401, { error: 'Invalid Discord request signature.' });

    const interaction = req.body && typeof req.body === 'object' ? req.body : {};
    if (interaction.type === 1) return json(res, 200, { type: 1 });
    if (interaction.type !== 2 || !interaction.data?.name) return json(res, 400, { error: 'Unsupported Discord interaction.' });
    if (String(interaction.guild_id || '') !== DISCORD_GUILD_ID) {
        return respond(res, 'This VoidedX bot is available only in its configured server.');
    }

    const name = String(interaction.data.name);
    const channelKey = COMMAND_CHANNEL[name];
    const settings = await getChannelSettings();
    if (channelKey && !KEY_PAGE_COMMANDS.has(name)) {
        const configuredChannel = settings.channels[channelKey];
        if (configuredChannel) {
            const { current, parent } = resolveChannelId(interaction);
            if (configuredChannel !== current && configuredChannel !== parent) {
                const channel = DISCORD_CHANNELS.find(item => item.key === channelKey);
                return respond(res, `Use /${name} in the configured #${channel?.label || 'channel'} channel.`);
            }
        }
    }

    const messages = settings.messages;
    if (name === 'help' || name === 'commands') {
        return respond(res, [
            '**VoidedX commands**',
            '`/panel` — open the Creator Panel',
            '`/scripts` — browse the public script library',
            '`/verify vault_id:<id>` — open a vault access page',
            '`/rules`, `/notices`, `/features`, `/top-globals`',
            '`/chat`, `/suggestions`, `/site`, `/blacklist`, `/bypass`',
            `Website: ${DISCORD_SITE_URL}`
        ].join('\n'));
    }
    if (name === 'panel') return respond(res, `Open your VoidedX Creator Panel: ${DISCORD_SITE_URL}/panel.html`);
    if (name === 'scripts') return respond(res, `Browse the VoidedX script library: ${DISCORD_SITE_URL}/scripts`);
    if (name === 'verify') {
        const vaultId = commandOption(interaction, 'vault_id');
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(vaultId)) return respond(res, 'That vault ID does not look valid. Copy the ID from the VoidedX vault link.');
        return respond(res, `Open the vault access page: ${DISCORD_SITE_URL}/vault.html?id=${encodeURIComponent(vaultId)}`);
    }
    if (name === 'site') return respond(res, `${messages.site}\n${DISCORD_SITE_URL}`);
    if (name === 'top-globals') return respond(res, `${messages.topGlobals}\n${DISCORD_SITE_URL}/leaderboard`);
    if (Object.prototype.hasOwnProperty.call(messages, channelKey)) {
        const tail = name === 'suggestions'
            ? '\nPlease post your idea in this channel.'
            : name === 'blacklist'
                ? '\nThe bot does not expose private moderation records.'
                : name === 'bypass'
                    ? '\nThe bot cannot bypass verification or security controls.'
                    : '';
        return respond(res, messages[channelKey] + tail);
    }
    return respond(res, `Use /help to see the VoidedX commands. ${DISCORD_SITE_URL}`);
}
