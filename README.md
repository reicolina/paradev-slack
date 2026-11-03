# ParaDev for Slack

Send any Slack message to a [ParaDev](https://paradev.com) workspace and start an AI agent on it, straight from the message's **⋯ More actions** menu.

1. On any message, click **⋯** → **Send to ParaDev**.
2. Pick the ParaDev host (online hosts first, offline ones marked).
3. Pick a workspace on that host (searchable).
4. Pick the AI harness (Claude by default, or anything configured on that host: Codex, Gemini, Cursor Agent, …).
5. Optionally add context, e.g. "fix this and open a PR".
6. Click **Send**. The agent starts in that workspace with the message link, author, text and your note. You get a DM when it is on its way.

Everything else uses ParaDev's defaults (model, effort, etc. come from the agent's configuration on the host).

## How it works

```
Slack ⋯ menu ──► message shortcut ──► this app ──► ParaDev API ──► relay ──► your host ──► agent session
                 (modal: workspace,                (@superset_sh/sdk:
                  harness, context)                 agents.create)
```

- Hosts come from `hosts.list`; workspaces from ParaDev's cloud index (`workspaces.list`), scoped to the chosen host.
- Harnesses are loaded from the chosen host (`agents.list`), so the picker matches what that machine has installed.
- On submit the app calls `agents.create` on that workspace. The host must be online.

The prompt the agent gets looks like this:

```
A Slack message was sent to you from Slack by Rei.

Slack message: https://acme.slack.com/archives/C0123/p1700000000000100
Posted by: Ana in #bugs

Message text:
> Login is broken on Safari

Context from Rei:
fix this and open a PR

If you have Slack access, open the link above to read the full message and its thread before you start.
```

## Setup

You need: a ParaDev account with at least one host, permission to create Slack apps in your Slack workspace, and Node 20+ (or Docker).

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick your workspace, and paste [`manifest.yml`](manifest.yml) (Socket Mode). Use [`manifest.http.yml`](manifest.http.yml) instead if you will serve it over HTTPS.
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. Socket Mode only: **Basic Information** → **App-Level Tokens** → generate one with the `connections:write` scope (`xapp-…`).

### 2. Get ParaDev credentials

- **API key:** ParaDev desktop app → **Settings → API Keys** → **Create API Key** (`sk_live_…`).
- **Organization ID:** `superset org list --json` (or the dashboard).

The API key grants full access to your ParaDev organization, so set `ALLOWED_SLACK_USER_IDS` to the Slack user IDs that may use the shortcut (Slack profile → ⋯ → **Copy member ID**).

### 3. Configure and run

```bash
cp .env.example .env   # fill it in
npm install
npm run dev
```

| Variable | Required | |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | yes | |
| `SLACK_APP_TOKEN` | Socket Mode | `xapp-…`. When set, the app uses Socket Mode; when empty, it serves HTTP on `PORT`. |
| `PARADEV_API_KEY` | yes | `sk_live_…` |
| `PARADEV_ORGANIZATION_ID` | yes | |
| `ALLOWED_SLACK_USER_IDS` | recommended | Comma-separated. Empty means anyone in the Slack workspace. |
| `DEFAULT_AGENT` | no | Preset preselected in the picker. Default `claude`. |
| `PORT` | no | HTTP mode only. Default `3000`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` |

## Deploying

**Recommended: Socket Mode on a small always-on container (Fly.io).** Socket Mode opens an outbound WebSocket to Slack, so there is no public URL, no TLS setup and no request signing to expose. Slack requires interactive requests to be acknowledged within 3 seconds and modals to open within 3 seconds of the click; an always-on process meets that every time, while serverless cold starts can miss it. The app is idle almost all the time and fits in the smallest machine.

```bash
fly launch --no-deploy --copy-config --name <your-app-name>
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... SLACK_APP_TOKEN=xapp-... \
  PARADEV_API_KEY=sk_live_... PARADEV_ORGANIZATION_ID=... ALLOWED_SLACK_USER_IDS=U0123
fly deploy
fly scale count 1   # Socket Mode: run exactly one machine
```

Other options that work the same way (they all run the included `Dockerfile`):

- **Railway / Render background worker:** connect the repo, set the env vars, no port needed.
- **Any machine you already run**, for example the box that is your ParaDev host: `docker build -t paradev-slack . && docker run -d --restart unless-stopped --env-file .env paradev-slack` or `npm start` under systemd / pm2. Free, but the shortcut stops working when that machine is off.
- **HTTP mode** (Cloud Run, Render web service, a VPS behind HTTPS): leave `SLACK_APP_TOKEN` empty, use `manifest.http.yml` with your URL, and keep at least one instance warm.

## Development

```bash
npm test        # node:test, Slack and ParaDev are faked
npm run dev     # reloads on change, reads .env
```

Code map: `src/app.js` (Slack handlers), `src/views.js` (modal), `src/prompt.js` (what the agent receives), `src/paradev.js` (ParaDev SDK calls), `src/index.js` (startup).

## Limitations

- Each install is single-tenant: one Slack app, one ParaDev organization, one API key. Agents run as the owner of that key.
- The agent gets the message text (up to ~1,800 characters) plus the link. Reading the full thread needs Slack access inside the agent (for example the Slack plugin in ParaDev).
- `@superset_sh/sdk` is in alpha; the version is pinned.

## License

[MIT](LICENSE)
