# @ptbk/dashboard

app.ptbk.io: account sign-up with passkeys, engine list, billing (Stripe), engine status, and links to engines. Also the HTTP API engines and relays talk to:

- `POST /v1/engines/register`: engine registration (spec, Interfaces 1)
- `GET /internal/v1/engines/{engineId}`: registry lookup for relays, relay-key authenticated (Interfaces 2)
- `POST /v1/engines/{engineId}/heartbeat`: signed heartbeat (Interfaces 4)

Planned stack: TanStack Start on Cloudflare Workers, D1, a Durable Object per engine, Cron Triggers for monitoring jobs. Stores no engine content. Not scaffolded yet.
