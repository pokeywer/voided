// Called by Vercel Cron (every 24h) to auto-push the leaderboard to Discord.
// Set up in vercel.json: { "crons": [{ "path": "/api/discord-leaderboard-refresh", "schedule": "0 0 * * *" }] }
import { db } from './_admin.js';
import { DISCORD_SITE_URL } from './_discordConfig.js';
import { pushLeaderboardToChannel } from './_discordBot.js';

export default async function handler(req, res) {
    // Accept Vercel cron (no auth header needed — it's internal) or admin bearer token
    const authHeader = req.headers.authorization || '';
    const cronSecret = process.env.CRON_SECRET || '';
    const isCron = req.headers['x-vercel-cron'] === '1';
    const isAuthed = cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!isCron && !isAuthed) {
        return res.status(401).json({ ok: false, message: 'Unauthorized.' });
    }

    try {
        const snap = await db.collection('settings').doc('discordBot').get();
        const data = snap.exists ? snap.data() : {};
        const channelId = String(data.leaderboardChannelId || '').trim();
        if (!channelId) {
            return res.status(200).json({ ok: true, skipped: true, reason: 'No leaderboard channel configured.' });
        }
        const messageId = await pushLeaderboardToChannel(db, channelId, DISCORD_SITE_URL);
        return res.status(200).json({ ok: true, channelId, messageId, pushedAt: new Date().toISOString() });
    } catch (err) {
        console.error('[discord-leaderboard-refresh] Error:', err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
