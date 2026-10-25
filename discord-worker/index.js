import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';

const token = process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;

if (!token) {
    console.error('Set BOT_TOKEN (or DISCORD_BOT_TOKEN) in this worker host before starting.');
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: {
        status: 'online',
        activities: [{ name: 'VoidedX Creator Panel', type: ActivityType.Watching }]
    }
});

client.once(Events.ClientReady, readyClient => {
    console.log(`VoidedX presence worker connected as ${readyClient.user.tag}.`);
});

client.on(Events.Error, error => {
    console.error('Discord Gateway connection error:', error.message);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        console.log(`Received ${signal}; closing the Discord connection.`);
        client.destroy();
        process.exit(0);
    });
}

client.login(token).catch(error => {
    console.error('Could not connect the presence worker to Discord:', error.message);
    process.exit(1);
});
