import bolt from '@slack/bolt';
import { registerHandlers } from './app.js';
import { ParaDev } from './paradev.js';

const { App, LogLevel } = bolt;
const env = process.env;

const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'PARADEV_API_KEY', 'PARADEV_ORGANIZATION_ID'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const socketMode = Boolean(env.SLACK_APP_TOKEN);
const app = new App({
  token: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  ...(socketMode ? { socketMode: true, appToken: env.SLACK_APP_TOKEN } : {}),
  logLevel: env.LOG_LEVEL ? LogLevel[env.LOG_LEVEL.toUpperCase()] : LogLevel.INFO,
});

const allowedUserIds = (env.ALLOWED_SLACK_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Fail closed: the ParaDev key can launch agents on every host in the org, so the app
// will not start without a list of who may use it.
const allowAnyone = env.ALLOW_ANY_SLACK_USER === 'true';
if (!allowedUserIds.length && !allowAnyone) {
  console.error(
    'ALLOWED_SLACK_USER_IDS is empty. Set it to the Slack member IDs allowed to send jobs ' +
      '(or ALLOW_ANY_SLACK_USER=true to let everyone in the Slack workspace use your ParaDev key).',
  );
  process.exit(1);
}
if (allowAnyone) console.warn('ALLOW_ANY_SLACK_USER=true: anyone in the Slack workspace can launch agents with your ParaDev key.');

registerHandlers(app, {
  paradev: ParaDev.fromEnv(env),
  defaultAgent: env.DEFAULT_AGENT || 'claude',
  allowedUserIds,
  allowAnyone,
});

await app.start(socketMode ? undefined : Number(env.PORT || 3000));
console.log(socketMode ? 'ParaDev for Slack running in Socket Mode' : `ParaDev for Slack listening on :${env.PORT || 3000}`);
