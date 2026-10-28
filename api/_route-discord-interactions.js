import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { db } from './_admin.js';
import {
    cleanChannelIds, cleanChannelMessages, DEFAULT_CHANNEL_MESSAGES, DISCORD_CHANNELS,
    DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, DISCORD_PUBLIC_KEY, DISCORD_SITE_URL
} from './_discordConfig.js';
import {
    getBotToken, buildLeaderboardEmbeds, buildStatsEmbed, buildVaultEmbed,
    editFollowUp, editFollowUpFile, sendFollowUp
} from './_discordBot.js';
import { createDiscordObfuscationSession } from './_obfuscationSessions.js';

const COMMAND_CHANNEL = Object.fromEntries(DISCORD_CHANNELS.map(c => [c.command, c.key]));
const KEY_PAGE_COMMANDS = new Set(['help', 'panel', 'scripts', 'verify', 'vault', 'leaderboard', 'obfuscate', 'stats']);

function json(res, status, body) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
}

function verifyDiscordRequest(req) {
    const signature = String(req.headers['x-signature-ed25519'] || '');
    const timestamp  = String(req.headers['x-signature-timestamp'] || '');
    const rawBody    = req.rawBody;
    if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{1,20}$/.test(timestamp) || !Buffer.isBuffer(rawBody)) return false;
    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
    try {
        const rawPub    = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
        if (rawPub.length !== 32) return false;
        const spki      = Buffer.from('302a300506032b6570032100', 'hex');
        const publicKey = createPublicKey({ key: Buffer.concat([spki, rawPub]), format: 'der', type: 'spki' });
        return verifySignature(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]), publicKey, Buffer.from(signature, 'hex'));
    } catch { return false; }
}

// Immediate ephemeral text response
function respond(res, content) {
    return json(res, 200, {
        type: 4,
        data: { content: String(content || '').slice(0, 1950), flags: 64, allowed_mentions: { parse: [] } }
    });
}

// Immediate embed response (ephemeral)
function respondEmbeds(res, embeds, components = [], ephemeral = true) {
    return json(res, 200, {
        type: 4,
        data: {
            embeds,
            components,
            ...(ephemeral ? { flags: 64 } : {}),
            allowed_mentions: { parse: [] }
        }
    });
}

// Defer — show "thinking…" then follow-up async. Returns 200 immediately.
function deferEphemeral(res) {
    return json(res, 200, { type: 5, data: { flags: 64 } });
}

// Defer publicly (visible to channel)
function deferPublic(res) {
    return json(res, 200, { type: 5 });
}

function respondWithCreatorPanel(res) {
    return respondEmbeds(res, [{
        title: 'VoidedX Creator Panel',
        description: 'Manage your vaults and scripts from the VoidedX website.',
        color: 0x12b8d0,
        footer: { text: 'VOIDEDX  •  Creator tools' }
    }], [{ type: 1, components: [
        { type: 2, style: 5, label: 'Open Creator Panel', url: `${DISCORD_SITE_URL}/panel.html` },
        { type: 2, style: 5, label: 'Browse Scripts',     url: `${DISCORD_SITE_URL}/scripts`    }
    ] }]);
}

function opt(interaction, name) {
    const options = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
    const item    = options.find(o => o?.name === name);
    return item != null ? item.value : undefined;
}

function optStr(interaction, name, fallback = '') {
    const v = opt(interaction, name);
    return v != null ? String(v) : fallback;
}

async function getChannelSettings() {
    let timer;
    try {
        const snap = await Promise.race([
            db.collection('settings').doc('discordBot').get(),
            new Promise(r => { timer = setTimeout(() => r(null), 900); })
        ]);
        const data = snap?.exists ? snap.data() : {};
        return { channels: cleanChannelIds(data.channels), messages: cleanChannelMessages(data.messages) };
    } catch {
        return { channels: cleanChannelIds({}), messages: { ...DEFAULT_CHANNEL_MESSAGES } };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Run heavy work after responding (Vercel keeps the lambda alive briefly)
function runAsync(fn) {
    Promise.resolve().then(fn).catch(err => console.error('[discord-interactions async]', err));
}

// Download a Discord attachment by URL and return text
async function fetchAttachment(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Could not download attachment (${res.status})`);
    const text = await res.text();
    if (text.length > 200_000) throw new Error('File is too large. Maximum is 200 KB.');
    return text;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return json(res, 405, { error: 'Method not allowed.' });
    }
    if (!verifyDiscordRequest(req)) return json(res, 401, { error: 'Invalid Discord request signature.' });

    const interaction = req.body && typeof req.body === 'object' ? req.body : {};
    if (interaction.type === 1) return json(res, 200, { type: 1 });
    if (interaction.type !== 2 || !interaction.data?.name) return json(res, 400, { error: 'Unsupported interaction.' });
    if (String(interaction.guild_id || '') !== DISCORD_GUILD_ID) {
        return respond(res, 'This VoidedX bot is only available in the configured server.');
    }

    const name        = String(interaction.data.name);
    const channelKey  = COMMAND_CHANNEL[name];
    const settings    = await getChannelSettings();
    const appId       = DISCORD_APPLICATION_ID;
    const itoken      = String(interaction.token || '');

    // Enforce channel restrictions for non-global commands
    if (channelKey && !KEY_PAGE_COMMANDS.has(name)) {
        const configured = settings.channels[channelKey];
        if (configured) {
            const current = String(interaction.channel_id || '');
            const parent  = String(interaction.channel?.parent_id || '');
            if (configured !== current && configured !== parent) {
                const ch = DISCORD_CHANNELS.find(c => c.key === channelKey);
                return respond(res, `Use /${name} in the configured #${ch?.label || 'channel'} channel.`);
            }
        }
    }

    const messages = settings.messages;

    // ── /help ────────────────────────────────────────────────────────────────
    if (name === 'help' || name === 'commands') {
        return respondEmbeds(res, [{
            title: '📖 VoidedX Commands',
            color: 0x12b8d0,
            fields: [
                { name: '🔧 Tools', value: [
                    '`/leaderboard [period]` — Live execution leaderboard',
                    '`/stats` — Live site activity & stats',
                    '`/vault <id>` — Look up vault info',
                    '`/verify <id>` — Open a vault access page',
                    '`/obfuscate [file] [code] [level]` — Private obfuscation link (8 tokens/day)',
                    '`/panel` — Open the Creator Panel',
                    '`/scripts` — Browse public scripts'
                ].join('\n'), inline: false },
                { name: '📣 Info panels', value: DISCORD_CHANNELS.map(c => `\`/${c.command}\``).join('  '), inline: false }
            ],
            footer: { text: `VoidedX  •  ${DISCORD_SITE_URL}` }
        }]);
    }

    // ── /panel ───────────────────────────────────────────────────────────────
    if (name === 'panel') return respondWithCreatorPanel(res);

    // ── /scripts ─────────────────────────────────────────────────────────────
    if (name === 'scripts') {
        return respondEmbeds(res, [{
            title: '📜 VoidedX Script Library',
            description: 'Browse and execute public Lua scripts from the VoidedX community.',
            color: 0x12b8d0,
            footer: { text: 'VoidedX  •  Public scripts' }
        }], [{ type: 1, components: [
            { type: 2, style: 5, label: 'Browse Scripts', url: `${DISCORD_SITE_URL}/scripts` }
        ] }]);
    }

    // ── /stats ───────────────────────────────────────────────────────────────
    if (name === 'stats') {
        deferEphemeral(res);
        runAsync(async () => {
            try {
                const embed = await buildStatsEmbed(db);
                await editFollowUp(appId, itoken, {
                    embeds: [embed],
                    components: [{ type: 1, components: [
                        { type: 2, style: 5, label: 'Full Leaderboard', url: `${DISCORD_SITE_URL}/leaderboard` }
                    ]}],
                    allowed_mentions: { parse: [] }
                });
            } catch (err) {
                await editFollowUp(appId, itoken, { content: `Could not fetch stats: ${err.message}` }).catch(() => {});
            }
        });
        return;
    }

    // ── /leaderboard ─────────────────────────────────────────────────────────
    if (name === 'leaderboard') {
        const period = optStr(interaction, 'period', 'all');
        deferEphemeral(res);
        runAsync(async () => {
            try {
                const embeds = await buildLeaderboardEmbeds(db, period);
                await editFollowUp(appId, itoken, {
                    embeds,
                    components: [{ type: 1, components: [
                        { type: 2, style: 5, label: 'Full Leaderboard', url: `${DISCORD_SITE_URL}/leaderboard` },
                        { type: 2, style: 5, label: 'Creator Panel',    url: `${DISCORD_SITE_URL}/panel.html`  }
                    ]}],
                    allowed_mentions: { parse: [] }
                });
            } catch (err) {
                await editFollowUp(appId, itoken, { content: `Could not fetch leaderboard: ${err.message}` }).catch(() => {});
            }
        });
        return;
    }

    // ── /vault ───────────────────────────────────────────────────────────────
    if (name === 'vault') {
        const vaultId = optStr(interaction, 'vault_id').trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(vaultId)) return respond(res, 'That vault ID looks invalid.');
        deferEphemeral(res);
        runAsync(async () => {
            try {
                const embed = await buildVaultEmbed(db, vaultId, DISCORD_SITE_URL);
                if (!embed) {
                    await editFollowUp(appId, itoken, { content: `No vault found with ID \`${vaultId}\`.` });
                    return;
                }
                await editFollowUp(appId, itoken, {
                    embeds: [embed],
                    components: [{ type: 1, components: [
                        { type: 2, style: 5, label: 'Open Vault Page', url: `${DISCORD_SITE_URL}/vault.html?id=${encodeURIComponent(vaultId)}` }
                    ]}],
                    allowed_mentions: { parse: [] }
                });
            } catch (err) {
                await editFollowUp(appId, itoken, { content: `Could not fetch vault: ${err.message}` }).catch(() => {});
            }
        });
        return;
    }

    // ── /verify ───────────────────────────────────────────────────────────────
    if (name === 'verify') {
        const vaultId = optStr(interaction, 'vault_id').trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(vaultId)) return respond(res, 'That vault ID looks invalid.');
        return respondEmbeds(res, [{
            title: '🔑 Vault Access',
            description: `Open the access page for vault \`${vaultId}\`.`,
            color: 0x12b8d0,
            footer: { text: 'VoidedX  •  Vault verification' }
        }], [{ type: 1, components: [
            { type: 2, style: 5, label: 'Open Access Page', url: `${DISCORD_SITE_URL}/vault.html?id=${encodeURIComponent(vaultId)}` }
        ] }]);
    }

    // ── /obfuscate ────────────────────────────────────────────────────────────
    if (name === 'obfuscate') {
        const level        = optStr(interaction, 'level', 'auto');
        const inlineCode   = optStr(interaction, 'code', '').trim();
        const fileOption   = opt(interaction, 'file'); // attachment ID

        // Resolve the attachment URL from interaction data
        const attachments  = interaction.data?.resolved?.attachments || {};
        const attachmentId = typeof fileOption === 'string' ? fileOption : String(fileOption ?? '');
        const attachment   = attachments[attachmentId];

        const discordUser   = interaction.member?.user || interaction.user || {};
        const discordUserId = String(discordUser.id || '');
        const discordName   = String(discordUser.global_name || discordUser.username || '');

        if (!getBotToken()) {
            return respond(res, 'Bot token is not configured. Ask the administrator to set `BOT_TOKEN` in Vercel.');
        }

        deferEphemeral(res);
        runAsync(async () => {
            try {
                let source = '';
                let filename = 'script.lua';
                if (attachment) {
                    // Validate it's a lua file
                    filename = String(attachment.filename || 'script.lua');
                    const fname = filename.toLowerCase();
                    if (fname && !fname.endsWith('.lua') && !fname.endsWith('.txt')) {
                        await editFollowUp(appId, itoken, { content: 'Only `.lua` or `.txt` files are accepted.' });
                        return;
                    }
                    source = await fetchAttachment(String(attachment.url || attachment.proxy_url));
                } else if (inlineCode) {
                    source = inlineCode.slice(0, 50000);
                }

                const session = await createDiscordObfuscationSession({
                    discordUserId,
                    discordUsername: discordName,
                    source,
                    level,
                    filename
                });

                const obfuscateUrl = `${DISCORD_SITE_URL}/obfuscation?vx=${encodeURIComponent(session.token)}`;
                const expiresUnix = Math.floor((session.expiresAt || Date.now()) / 1000);
                const resetUnix = Math.floor((session.resetsAt || Date.now()) / 1000);
                const left = Math.max(0, Number(session.credits) || 0);

                await editFollowUp(appId, itoken, {
                    embeds: [{
                        title: 'VoidedX Obfuscator',
                        description: [
                            source
                                ? `**File:** \`${filename}\` (${source.length.toLocaleString()} chars)`
                                : '**File:** upload or paste it on the page',
                            `**Default strength:** \`${level}\``,
                            `**Void tokens:** **${left}** of ${session.dailyLimit || 8} left today`,
                            '',
                            left > 0
                                ? 'Open the page to obfuscate and download the protected file. Choose strength, armor layers, junk noise, and output style there. You can also save the result to a VoidedX vault.'
                                : 'Today\'s tokens are used up. Open the page to queue a script for tomorrow, or ask an admin for bonus tokens.',
                            '',
                            'Each successful obfuscation uses one token. Tokens refill at midnight UTC; the link is personal, so do not share it. Bonus tokens granted by an admin are spent after the daily ones.',
                            `⏱️ Tokens reset <t:${resetUnix}:R>. Link expires <t:${expiresUnix}:R>.`
                        ].join('\n'),
                        color: 0xa855f7,
                        footer: { text: 'VoidedX  •  8 void tokens per day' },
                        timestamp: new Date().toISOString()
                    }],
                    components: [{ type: 1, components: [
                        { type: 2, style: 5, label: 'Open Obfuscator', url: obfuscateUrl }
                    ]}],
                    allowed_mentions: { parse: [] }
                });
            } catch (err) {
                await editFollowUp(appId, itoken, { content: `Obfuscate setup failed: ${err.message}` }).catch(() => {});
            }
        });
        return;
    }

    // ── Channel info commands ─────────────────────────────────────────────────
    if (name === 'site') {
        return respondEmbeds(res, [{
            title: '🌐 VoidedX Website',
            description: messages.site,
            color: 0x12b8d0,
            url: DISCORD_SITE_URL,
            footer: { text: 'VoidedX' }
        }], [{ type: 1, components: [
            { type: 2, style: 5, label: 'Open VoidedX', url: DISCORD_SITE_URL }
        ] }]);
    }

    if (name === 'top-globals') {
        return respondEmbeds(res, [{
            title: '🏆 Top Globals',
            description: messages.topGlobals,
            color: 0xfbbf24,
            footer: { text: 'VoidedX  •  Leaderboard' }
        }], [{ type: 1, components: [
            { type: 2, style: 5, label: 'View Leaderboard', url: `${DISCORD_SITE_URL}/leaderboard` }
        ] }]);
    }

    if (channelKey && Object.prototype.hasOwnProperty.call(messages, channelKey)) {
        const extra = name === 'suggestions' ? '\nPost your idea in this channel.'
            : name === 'blacklist' ? '\nContact staff with your context — the bot does not expose private moderation records.'
            : name === 'bypass'    ? '\nThe bot cannot bypass verification. Use the VoidedX site or contact staff.'
            : '';
        return respondEmbeds(res, [{
            title: `${DISCORD_CHANNELS.find(c => c.key === channelKey)?.label || name}`,
            description: messages[channelKey] + extra,
            color: 0x12b8d0,
            footer: { text: 'VoidedX' }
        }]);
    }

    return respond(res, `Use /help to see available commands. ${DISCORD_SITE_URL}`);
}
