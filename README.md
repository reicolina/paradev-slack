# ParaDev for Slack

Send any Slack message to [ParaDev](https://paradev.com) and start an AI agent on it in a fresh workspace, straight from the message's **⋯ More actions** menu. Everyone uses their own ParaDev account, so a job you send runs as you, on your hosts.

![Send to ParaDev: from a Slack message to an agent opening a PR](docs/demo.gif)

<sub>Illustrative demo with made-up data. [Watch the MP4](docs/demo.mp4).</sub>

1. On any message, click **⋯** → **Send to ParaDev**.
2. The first time, click **Connect ParaDev** and sign in. The form appears as soon as you are connected.
3. Pick the ParaDev host (online hosts first, offline ones marked).
4. Pick a project on that host (searchable), or **No project** for a scratch session.
5. Pick the AI harness (Claude by default, or anything configured on that host: Codex, Gemini, Cursor Agent, …).
6. Optionally add context, e.g. "fix this and open a PR".
7. Click **Send**. The app creates a new workspace in that project, on its own worktree and a new `slack/…` branch forked from the project's default branch, named after the message. The agent starts there with the message link, author, text and your note. You get a DM when it is on its way.

Next time, the form opens with your last host, project and harness already picked. Everything else uses ParaDev's defaults (model, effort, etc. come from the agent's configuration on the host).

## How it works

```
Slack ⋯ menu ──► this app ──► ParaDev MCP API (as you) ──► relay ──► your host ──► agent session
                   │               hosts_list, projects_list,
                   │               agents_list, workspaces_create
                   └─► "Connect ParaDev" ──► ParaDev sign-in (OAuth 2.1 + PKCE) ──► /oauth/callback
```

- **Accounts.** The app registers itself with ParaDev's OAuth server once ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) and signs each Slack user in with the authorization code flow and PKCE. Each user's tokens are stored encrypted (AES-256-GCM), refreshed before they expire, and used only for that user's requests. Nobody can reach anyone else's hosts.
- **ParaDev calls** go to ParaDev's MCP endpoint (`/mcp`), which is where ParaDev documents OAuth tokens as accepted.
- **Disconnect** from the app's **Home** tab in Slack. It revokes the token at ParaDev and deletes it here. You can also revoke the app from ParaDev itself.
- **Your last choice** rides along as [message metadata](https://api.slack.com/metadata) on the result DM, so it survives restarts with no extra storage.

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

You need permission to create Slack apps in your Slack workspace, somewhere to run a small always-on container with a public HTTPS URL (the steps below use Fly.io), and Node 20+ or Docker. Each person who uses it needs a ParaDev account with at least one host.

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick your workspace, and paste [`manifest.yml`](manifest.yml) (Socket Mode). Use [`manifest.http.yml`](manifest.http.yml) instead to receive Slack requests over HTTPS.
2. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information** → copy the **Signing Secret**.
4. Socket Mode only: **Basic Information** → **App-Level Tokens** → generate one with the `connections:write` scope (`xapp-…`).

### 2. Deploy (Fly.io)

```bash
fly launch --no-deploy --copy-config --name <your-app-name>
fly volumes create paradev_slack_data --size 1
fly secrets set \
  SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... SLACK_APP_TOKEN=xapp-... \
  PUBLIC_URL=https://<your-app-name>.fly.dev \
  TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
fly deploy
fly scale count 1
```

Then open the app's **Home** tab in Slack and click **Connect ParaDev** to check the sign-in works.

Why this shape:

- **Always on.** Slack wants an answer within 3 seconds of a click; serverless cold starts miss that. The app is idle almost all the time and fits in the smallest machine.
- **A public URL** is needed only for the sign-in callback (`/oauth/callback`) and the health check (`/healthz`). In Socket Mode, Slack traffic itself goes over an outbound WebSocket.
- **A volume** keeps linked accounts across deploys. Without it everyone would have to connect again after each deploy.
- **One machine.** The account store is a single file; do not scale out.

Railway, Render or any VPS work the same way with the included `Dockerfile`: give it a public HTTPS URL, a persistent disk at `/data`, and the same variables.

### Configuration

| Variable | Required | |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | yes | |
| `SLACK_APP_TOKEN` | Socket Mode | `xapp-…`. When empty, Slack requests come over HTTP at `PUBLIC_URL/slack/events`. |
| `PUBLIC_URL` | yes | Public HTTPS URL of the app, without a trailing slash. |
| `TOKEN_ENCRYPTION_KEY` | yes | 32 random bytes, base64: `openssl rand -base64 32`. Keep it secret and keep it stable: changing it disconnects everyone. |
| `STORE_PATH` | no | Encrypted account store. Default `./data/store.json` (`/data/store.json` in Docker). |
| `ALLOWED_SLACK_USER_IDS` | no | Comma-separated Slack member IDs allowed to use the app at all. Empty means anyone in the Slack workspace (each still acts as themselves). |
| `DEFAULT_AGENT` | no | Preset preselected in the picker. Default `claude`. |
| `PORT` | no | Default `3000`. |
| `PARADEV_URL` | no | Default `https://api.superset.sh`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` |

### Personal mode (one shared API key)

If only you use it and you would rather not run the sign-in flow, set `PARADEV_API_KEY` (ParaDev desktop app → **Settings → API Keys**) and `PARADEV_ORGANIZATION_ID`. Every allowed Slack user then acts as the key's owner, so `ALLOWED_SLACK_USER_IDS` becomes required and the app will not start without it (`ALLOW_ANY_SLACK_USER=true` is the explicit opt-out). `PUBLIC_URL` and `TOKEN_ENCRYPTION_KEY` are not needed, and Socket Mode works with no public URL at all.

## Security

- Each Slack user's ParaDev access is their own: sign-in state is single-use, expires after 15 minutes, and is bound to the Slack user and workspace that started it.
- Tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY` and the store file is written with mode `0600`. Anyone with both the file and the key can act as the linked users, so treat the key like a password.
- A refresh token ParaDev refuses (revoked, expired) unlinks the user and asks them to connect again.
- Slack requests are verified (signing secret in HTTP mode, app-level token in Socket Mode).
- Keep the Slack app's collaborators to people you trust: they can read its tokens.

## Development

```bash
npm test        # node:test; Slack and ParaDev are faked
npm run dev     # reloads on change, reads .env
```

Code map: `src/app.js` (Slack handlers), `src/views.js` (modals, Home tab), `src/accounts.js` (per-user accounts and token refresh), `src/oauth.js` (ParaDev OAuth client), `src/store.js` (encrypted store), `src/routes.js` (callback page), `src/mcp.js` + `src/paradev.js` (ParaDev calls), `src/prompt.js` (what the agent receives), `src/memory.js` (last choice), `src/index.js` (startup and modes).

## Limitations

- One install serves one Slack workspace. People from different ParaDev organizations can share it; each sees their own.
- A ParaDev sign-in is tied to the organization that was active when the user approved it. To switch, disconnect and connect again.
- Workspace lists come from the host itself, so pick an online host.
- The agent gets the message text (up to ~1,800 characters) plus the link. Reading the full thread needs Slack access inside the agent (for example the Slack plugin in ParaDev).

## License

[MIT](LICENSE)
