# VoidedX Discord presence worker

The Vercel website handles signed Discord slash-command interactions and uses the bot token for REST requests. Vercel functions are request-based, so they do not hold the persistent Discord Gateway connection needed for an online bot status. This small worker maintains that connection and sets the bot presence to online.

## Run it on an always-on Node host

1. Deploy this `discord-worker` folder as its own Node service on a host that keeps processes running (for example, a small VPS or an always-on worker service).
2. Set `BOT_TOKEN` in that service's private environment variables. The Vercel environment variables are not automatically shared with another host.
3. Use Node.js 20 or newer, install the dependencies with `npm install`, and set the service start command to `npm start`.
4. Leave the existing Discord Interactions Endpoint URL pointed at `https://voidedx.vercel.app/api/discord-interactions`. The worker only maintains the Gateway presence; Vercel continues handling slash-command replies.

Do not run multiple copies with the same bot token. Do not commit the token to this folder or expose it in frontend code. If Discord shows the worker as offline, check that the worker process is running and its private token is valid.
