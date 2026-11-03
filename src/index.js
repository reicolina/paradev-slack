import bolt from '@slack/bolt';
import { ApiKeyAccounts, OAuthAccounts } from './accounts.js';
import { registerHandlers } from './app.js';
import { ParaDevOAuth } from './oauth.js';
import { CALLBACK_PATH, oauthRoutes } from './routes.js';
import { Cipher, FileStore } from './store.js';

const { App, LogLevel } = bolt;
const env = process.env;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const PARADEV_URL = (env.PARADEV_URL || 'https://api.superset.sh').replace(/\/$/, '');
const MCP_URL = `${PARADEV_URL}/mcp`;
const PORT = Number(env.PORT || 3000);

// Personal mode when an API key is set; otherwise every Slack user connects their own account.
const personal = Boolean(env.PARADEV_API_KEY);

const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', ...(personal ? [] : ['PUBLIC_URL', 'TOKEN_ENCRYPTION_KEY'])];
const missing = required.filter((k) => !env[k]);
if (missing.length) fail(`Missing required env vars: ${missing.join(', ')}. See .env.example.`);

const allowedUserIds = (env.ALLOWED_SLACK_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let allowAnyone;
if (personal) {
  // Fail closed: one shared key can launch agents on every host it can see, so the app will
  // not start without a list of who may use it.
  allowAnyone = env.ALLOW_ANY_SLACK_USER === 'true';
  if (!allowedUserIds.length && !allowAnyone) {
    fail(
      'Personal mode (PARADEV_API_KEY set) needs ALLOWED_SLACK_USER_IDS: the Slack member IDs allowed to use your key ' +
        '(or ALLOW_ANY_SLACK_USER=true). To let each person use their own ParaDev account instead, remove PARADEV_API_KEY.',
    );
  }
} else {
  // Everyone acts as themselves, so the list is an optional extra filter.
  allowAnyone = allowedUserIds.length === 0;
}

let accounts;
let oauth;
if (personal) {
  accounts = new ApiKeyAccounts({ mcpUrl: MCP_URL, apiKey: env.PARADEV_API_KEY, organizationId: env.PARADEV_ORGANIZATION_ID });
} else {
  let cipher;
  try {
    cipher = new Cipher(env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    fail(err.message);
  }
  const store = new FileStore({ file: env.STORE_PATH || './data/store.json', cipher });
  oauth = new ParaDevOAuth({ issuer: PARADEV_URL, redirectUri: `${env.PUBLIC_URL.replace(/\/$/, '')}${CALLBACK_PATH}`, store });
  accounts = new OAuthAccounts({ oauth, store, mcpUrl: MCP_URL });
}

// Filled in once the handlers exist; routes are passed to the App constructor.
let onConnected = async () => {};
const routes = personal ? [] : oauthRoutes({ accounts, onConnected: (r) => onConnected(r) });

const socketMode = Boolean(env.SLACK_APP_TOKEN);
const app = new App({
  token: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  customRoutes: routes,
  ...(socketMode ? { socketMode: true, appToken: env.SLACK_APP_TOKEN, installerOptions: { port: PORT } } : {}),
  logLevel: env.LOG_LEVEL ? LogLevel[env.LOG_LEVEL.toUpperCase()] : LogLevel.INFO,
});

({ onConnected } = registerHandlers(app, {
  accounts,
  defaultAgent: env.DEFAULT_AGENT || 'claude',
  allowedUserIds,
  allowAnyone,
}));

if (oauth) {
  // Register with ParaDev now so the first "Connect" button opens within Slack's 3 second window.
  try {
    await oauth.clientId();
  } catch (err) {
    fail(`Could not register with ParaDev OAuth: ${err.message}`);
  }
}

await app.start(socketMode ? undefined : PORT);
const how = socketMode ? 'Socket Mode' : `HTTP on :${PORT}`;
const who = personal ? 'one shared ParaDev API key' : 'each user’s own ParaDev account';
console.log(`ParaDev for Slack running (${how}, ${who})`);
if (personal && allowAnyone) console.warn('ALLOW_ANY_SLACK_USER=true: anyone in the Slack workspace can launch agents with your ParaDev key.');
