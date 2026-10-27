export const DISCORD_APPLICATION_ID = '1563789940452622397';
export const DISCORD_PUBLIC_KEY = 'be7a6b422691776291e7386ed37f30625286b517af0da9da1964c09d421c7bad';
export const DISCORD_GUILD_ID = '1563443676313559100';
export const DISCORD_SITE_URL = (process.env.DISCORD_SITE_URL || 'https://voidedx.vercel.app').replace(/\/+$/, '');

export const DISCORD_CHANNELS = Object.freeze([
    { key: 'rules',      label: 'Rules',       command: 'rules',       description: 'Show the server rules panel.' },
    { key: 'notices',    label: 'Notices',      command: 'notices',     description: 'Show the latest notice panel.' },
    { key: 'features',   label: 'Features',     command: 'features',    description: 'Show the VoidedX feature panel.' },
    { key: 'topGlobals', label: 'Top-Globals',  command: 'top-globals', description: 'Open the public script leaderboard.' },
    { key: 'chat',       label: 'Chat',         command: 'chat',        description: 'Show the chat information panel.' },
    { key: 'suggestions',label: 'Suggestions',  command: 'suggestions', description: 'Show how to submit a suggestion.' },
    { key: 'site',       label: 'Site',         command: 'site',        description: 'Open the VoidedX website.' },
    { key: 'blacklist',  label: 'Blacklist',    command: 'blacklist',   description: 'Show the blacklist review information.' },
    { key: 'bypass',     label: 'Bypass',       command: 'bypass',      description: 'Show safe access troubleshooting information.' },
    { key: 'commands',   label: 'Commands',     command: 'commands',    description: 'List the available VoidedX commands.' }
]);

export const DEFAULT_CHANNEL_MESSAGES = Object.freeze({
    rules:       'Please read and follow the server rules before using the community.',
    notices:     'Official VoidedX updates and service notices will be posted here.',
    features:    'Explore VoidedX script vaults, access verification, and the public script library.',
    topGlobals:  'View the most-used public vaults on the VoidedX leaderboard.',
    chat:        'Keep chat respectful, stay on topic, and never share passwords, bot tokens, or private keys.',
    suggestions: 'Share clear, constructive ideas for improving VoidedX and the community.',
    site:        'Open the official VoidedX website and Creator Panel.',
    blacklist:   'For a blacklist review, contact the server staff with relevant context. Private moderation records are not shown by this bot.',
    bypass:      'This bot cannot bypass verification or security controls. If you are having a legitimate access issue, use the VoidedX site or contact staff.',
    commands:    'Use /help to see the available commands. Commands are limited to this VoidedX server.'
});

export function cleanChannelIds(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(DISCORD_CHANNELS.map(channel => {
        const id = String(source[channel.key] || '').trim();
        return [channel.key, /^\d{17,20}$/.test(id) ? id : ''];
    }));
}

export function cleanChannelMessages(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(DISCORD_CHANNELS.map(channel => {
        const raw = typeof source[channel.key] === 'string' ? source[channel.key] : DEFAULT_CHANNEL_MESSAGES[channel.key];
        const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        return [channel.key, (text || DEFAULT_CHANNEL_MESSAGES[channel.key]).slice(0, 1800)];
    }));
}

export function discordCommands() {
    const commands = [
        { name: 'help',        description: 'Show VoidedX help and useful links.' },
        { name: 'panel',       description: 'Open the VoidedX Creator Panel.' },
        { name: 'scripts',     description: 'Open the public VoidedX script library.' },
        { name: 'stats',       description: 'Show live VoidedX execution stats and activity.' },
        {
            name: 'leaderboard', description: 'Show the live VoidedX vault execution leaderboard.',
            options: [{
                type: 3, name: 'period', description: 'Which period to show.',
                required: false,
                choices: [
                    { name: 'All-time',   value: 'overall' },
                    { name: 'Today',      value: 'today'   },
                    { name: 'This month', value: 'month'   }
                ]
            }]
        },
        {
            name: 'verify', description: 'Open the access page for a VoidedX vault.',
            options: [{ type: 3, name: 'vault_id', description: 'The vault ID from its VoidedX link.', required: true }]
        },
        {
            name: 'vault', description: 'Look up info about a VoidedX vault.',
            options: [{ type: 3, name: 'vault_id', description: 'The vault ID to look up.', required: true }]
        },
        {
            name: 'obfuscate', description: 'Obfuscate a Lua script with VoidedX protection.',
            options: [
                { type: 11, name: 'file',  description: 'Upload a .lua file to obfuscate.', required: false },
                { type: 3,  name: 'code',  description: 'Paste Lua code directly (max 1500 chars).', required: false },
                {
                    type: 3, name: 'level', description: 'Obfuscation strength.',
                    required: false,
                    choices: [
                        { name: 'Auto (default)',  value: 'auto'     },
                        { name: 'Fast',            value: 'fast'     },
                        { name: 'Low',             value: 'low'      },
                        { name: 'Medium',          value: 'medium'   },
                        { name: 'High',            value: 'high'     },
                        { name: 'Absolute',        value: 'absolute' }
                    ]
                }
            ]
        },
        ...DISCORD_CHANNELS.map(channel => ({ name: channel.command, description: channel.description }))
    ];
    return commands.map(command => ({ ...command, type: 1 }));
}
