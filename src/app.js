import { ChoiceMemory } from './memory.js';
import { buildPermalink, buildPrompt, truncate } from './prompt.js';
import {
  AGENT_ACTION,
  CALLBACK_ID,
  CONNECT_ACTION,
  DISCONNECT_ACTION,
  connectModal,
  homeView,
  CONTEXT_ACTION,
  CONTEXT_BLOCK,
  FALLBACK_AGENTS,
  VIEW_ID,
  HOST_ACTION,
  HOST_BLOCK,
  WORKSPACE_ACTION,
  buildModal,
  decodeWorkspaceValue,
  encodeWorkspaceValue,
  findValue,
  hostOptionLabel,
  option,
  plain,
  workspaceOptionLabel,
} from './views.js';

// Value of the "could not reach ParaDev" option, so it can never be submitted as a real id.
const ERROR_VALUE = 'error';
const validId = (id) => (id && id !== ERROR_VALUE ? id : undefined);

/** Fields of the original message carried from the shortcut to the submission. */
function messageMetadata(shortcut) {
  const msg = shortcut.message || {};
  return {
    channelId: shortcut.channel?.id,
    channelName: shortcut.channel?.name,
    teamDomain: shortcut.team?.domain,
    ts: msg.ts || shortcut.message_ts,
    threadTs: msg.thread_ts,
    authorId: msg.user || msg.bot_id,
    // private_metadata is capped at 3000 chars, so keep the text short; the link has the rest.
    text: truncate(msg.text || '', 1800),
  };
}

function messageView(title, text) {
  return {
    type: 'modal',
    title: plain(title),
    close: plain('Close'),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

async function displayName(client, userId, logger) {
  if (!userId) return undefined;
  try {
    const { user } = await client.users.info({ user: userId });
    return user?.profile?.display_name || user?.real_name || user?.name || `<@${userId}>`;
  } catch (err) {
    logger?.debug?.(`users.info failed for ${userId}: ${err.message}`);
    return `<@${userId}>`;
  }
}

async function permalinkFor(client, meta, logger) {
  try {
    const res = await client.chat.getPermalink({ channel: meta.channelId, message_ts: meta.ts });
    if (res.permalink) return res.permalink;
  } catch (err) {
    logger?.debug?.(`chat.getPermalink failed, building the link: ${err.message}`);
  }
  return buildPermalink(meta);
}

function agentOptions(configs) {
  return configs.map((a) => ({ value: a.id, label: a.label || a.presetId, presetId: a.presetId }));
}

/** Pick the remembered harness if the host still has it, else the default preset. */
function defaultAgentValue(agents, defaultAgent, rememberedValue) {
  if (rememberedValue && agents.some((a) => a.value === rememberedValue)) return rememberedValue;
  return agents.find((a) => a.presetId === defaultAgent)?.value || defaultAgent;
}

/** A host's harnesses for the picker, or the fallback list with a note explaining why. */
async function hostAgents(paradev, hostId, logger) {
  try {
    const host = await paradev.hostById(hostId);
    if (host && !host.online) {
      return { agents: FALLBACK_AGENTS, agentNote: `:warning: *${host.name}* is offline. Start ParaDev on it before sending.` };
    }
    const configs = await paradev.agents(hostId);
    return { agents: configs.length ? agentOptions(configs) : FALLBACK_AGENTS };
  } catch (err) {
    logger.warn(`could not load agents for host ${hostId}: ${err.message}`);
    return { agents: FALLBACK_AGENTS, agentNote: "Could not load this host's harnesses, showing the defaults." };
  }
}

/** The remembered workspace option, only if it still exists on that host. */
async function stillExists(paradev, choice, logger) {
  try {
    const rows = await paradev.searchWorkspaces(undefined, choice.hostId);
    const ws = rows.find(({ ws }) => encodeWorkspaceValue(ws) === choice.workspaceValue);
    return ws ? option(choice.workspaceValue, choice.workspaceLabel) : undefined;
  } catch (err) {
    logger.debug(`could not check remembered workspace: ${err.message}`);
    return undefined;
  }
}

const teamOf = (body) => body.team?.id || body.user?.team_id || body.team_id || body.view?.team_id;

function notConnectedText(err) {
  return err?.unauthorized ? `${err.message} Open the ParaDev app's Home tab in Slack to connect.` : undefined;
}

/**
 * Register every Slack handler on a Bolt app.
 *
 * `accounts` decides which ParaDev account a Slack user acts as: their own (OAuth mode) or a
 * shared API key (personal mode). Access also fails closed on `allowedUserIds` unless
 * `allowAnyone` is set.
 *
 * Returns `onConnected`, which the OAuth callback route calls when a user finishes signing in.
 * @param {import('@slack/bolt').App} app
 * @param {{ accounts: import('./accounts.js').OAuthAccounts | import('./accounts.js').ApiKeyAccounts,
 *   defaultAgent?: string, allowedUserIds?: string[], allowAnyone?: boolean, memory?: ChoiceMemory }} deps
 */
export function registerHandlers(
  app,
  { accounts, defaultAgent = 'claude', allowedUserIds = [], allowAnyone = false, memory = new ChoiceMemory() },
) {
  const isAllowed = (userId) => Boolean(userId) && (allowAnyone || allowedUserIds.includes(userId));
  const oauth = accounts.mode === 'oauth';

  /** Show the form in an open modal, then fill in the user's last choice. */
  async function showForm({ client, paradev, viewId, hash, meta, userId, logger }) {
    const metadata = JSON.stringify(meta);
    let current = { id: viewId, hash };
    if (!hash) {
      // Replacing the connect modal: no hash, the form replaces whatever is there.
      const res = await client.views.update({
        view_id: viewId,
        view: buildModal({ agents: FALLBACK_AGENTS, defaultAgent, metadata, preview: meta.text }),
      });
      current = res?.view || current;
    }

    const choice = await memory.recall(client, userId, logger);
    if (!choice || !current?.id) return;
    // A remembered host from another ParaDev account (or a removed one) is skipped.
    const host = await paradev.hostById(choice.hostId).catch(() => undefined);
    if (!host) return;
    const [{ agents, agentNote }, selectedWorkspace] = await Promise.all([
      hostAgents(paradev, choice.hostId, logger),
      stillExists(paradev, choice, logger),
    ]);
    try {
      await client.views.update({
        view_id: current.id,
        hash: current.hash,
        view: buildModal({
          agents,
          defaultAgent: defaultAgentValue(agents, defaultAgent, choice.agentValue),
          hostId: choice.hostId,
          metadata,
          preview: meta.text,
          agentNote,
          selectedHost: option(choice.hostId, hostOptionLabel(host)),
          selectedWorkspace,
        }),
      });
    } catch (err) {
      // hash_conflict: the user already changed something; leave their edits alone.
      logger.debug(`prefill skipped: ${err.data?.error || err.message}`);
    }
  }

  async function publishHome(client, teamId, userId) {
    const status = await accounts.status(teamId, userId);
    const connectUrl = !status.connected && oauth ? (await accounts.connectUrl({ teamId, userId, context: { from: 'home' } })).url : undefined;
    await client.views.publish({ user_id: userId, view: homeView({ status, connectUrl }) });
  }

  // 1. "..." on a message -> Send to ParaDev
  app.shortcut(CALLBACK_ID, async ({ shortcut, ack, client, logger }) => {
    await ack();
    const userId = shortcut.user.id;
    if (!isAllowed(userId)) {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: messageView('Send to ParaDev', 'You are not allowed to use this app. Ask its admin to add your Slack user ID.'),
      });
      return;
    }
    // trigger_id expires in 3s, so open a modal before any ParaDev call.
    const meta = messageMetadata(shortcut);
    const metadata = JSON.stringify(meta);
    const teamId = teamOf(shortcut);
    const paradev = await accounts.forUser(teamId, userId);

    if (!paradev) {
      const { url, state } = await accounts.connectUrl({ teamId, userId, context: { meta } });
      const opened = await client.views.open({ trigger_id: shortcut.trigger_id, view: connectModal({ url, metadata }) });
      accounts.addContext(state, { viewId: opened?.view?.id });
      return;
    }

    const opened = await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildModal({ agents: FALLBACK_AGENTS, defaultAgent, metadata, preview: meta.text }),
    });
    logger.debug(`opened modal for ${meta.channelId}/${meta.ts}`);
    if (opened?.view?.id) {
      await showForm({ client, paradev, viewId: opened.view.id, hash: opened.view.hash, meta, userId, logger });
    }
  });

  // URL buttons still send an action; acknowledge it.
  app.action(CONNECT_ACTION, async ({ ack }) => ack());

  // 2. Host picker
  app.options(HOST_ACTION, async ({ body, ack, logger }) => {
    if (!isAllowed(body.user?.id)) return ack({ options: [] });
    const paradev = await accounts.forUser(teamOf(body), body.user.id);
    if (!paradev) return ack({ options: [option(ERROR_VALUE, 'Connect ParaDev first (app Home tab)')] });
    try {
      const hosts = await paradev.searchHosts(body.value?.trim());
      await ack({ options: hosts.slice(0, 100).map((h) => option(h.id, hostOptionLabel(h))) });
    } catch (err) {
      logger.error(`host search failed: ${err.message}`);
      const label = err.unauthorized ? 'Reconnect ParaDev (app Home tab)' : 'Could not reach ParaDev, try again';
      await ack({ options: [option(ERROR_VALUE, label)] });
    }
  });

  // 3. Workspace picker, scoped to the chosen host
  app.options(WORKSPACE_ACTION, async ({ body, ack, logger }) => {
    if (!isAllowed(body.user?.id)) return ack({ options: [] });
    const hostId = validId(body.view?.state?.values?.[HOST_BLOCK]?.[HOST_ACTION]?.selected_option?.value);
    if (!hostId) return ack({ options: [] });
    const paradev = await accounts.forUser(teamOf(body), body.user.id);
    if (!paradev) return ack({ options: [] });
    try {
      const rows = await paradev.searchWorkspaces(body.value?.trim(), hostId);
      await ack({
        options: rows.slice(0, 100).map(({ ws, host }) => option(encodeWorkspaceValue(ws), workspaceOptionLabel(ws, host, false))),
      });
    } catch (err) {
      logger.error(`workspace search failed: ${err.message}`);
      await ack({ options: [option(ERROR_VALUE, err.message.slice(0, 70))] });
    }
  });

  // 4. Host chosen -> reset the workspace picker to that host and load its harnesses
  app.action(HOST_ACTION, async ({ body, ack, client, logger }) => {
    await ack();
    if (!isAllowed(body.user?.id)) return;
    const view = body.view;
    const selectedHost = body.actions?.[0]?.selected_option;
    const hostId = validId(selectedHost?.value);
    if (!hostId) return;
    const paradev = await accounts.forUser(teamOf(body), body.user.id);
    if (!paradev) return;

    const { agents, agentNote } = await hostAgents(paradev, hostId, logger);

    try {
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: buildModal({
          agents,
          defaultAgent: defaultAgentValue(agents, defaultAgent),
          hostId,
          metadata: view.private_metadata,
          preview: JSON.parse(view.private_metadata).text,
          agentNote,
          selectedHost,
        }),
      });
    } catch (err) {
      // hash_conflict: the user changed the view again; the newer update wins.
      logger.debug(`views.update skipped: ${err.data?.error || err.message}`);
    }
  });

  // 5. Submit -> start the agent in the workspace
  app.view(VIEW_ID, async ({ view, body, ack, client, logger }) => {
    const userId = body.user.id;
    const values = view.state?.values || {};
    const wsBlock = Object.keys(values).find((k) => k.startsWith('workspace')) || HOST_BLOCK;
    const fail = (block, message) => ack({ response_action: 'errors', errors: { [block]: message } });

    if (!isAllowed(userId)) return fail(HOST_BLOCK, 'You are not allowed to use this app.');
    const paradev = await accounts.forUser(teamOf(body), userId);
    if (!paradev) return fail(HOST_BLOCK, 'Connect your ParaDev account first (app Home tab).');

    const chosenHostId = validId(values[HOST_BLOCK]?.[HOST_ACTION]?.selected_option?.value);
    const wsOption = findValue(values, 'workspace', WORKSPACE_ACTION)?.selected_option;
    const { workspaceId, hostId } = decodeWorkspaceValue(wsOption?.value);
    if (!chosenHostId) return fail(HOST_BLOCK, 'Pick a host.');
    if (!validId(workspaceId) || !hostId) return fail(wsBlock, 'Pick a workspace.');
    if (hostId !== chosenHostId) return fail(wsBlock, 'That workspace is on another host. Pick it again.');

    const agentOption = findValue(values, 'agent', AGENT_ACTION)?.selected_option;
    const agent = agentOption?.value || defaultAgent;
    const context = values[CONTEXT_BLOCK]?.[CONTEXT_ACTION]?.value || '';

    const host = await paradev.hostById(hostId).catch(() => undefined);
    if (host && !host.online) {
      return fail(HOST_BLOCK, `${host.name} is offline. Start ParaDev on it, or pick another host.`);
    }
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const [permalink, authorName, senderName] = await Promise.all([
      permalinkFor(client, meta, logger),
      displayName(client, meta.authorId, logger),
      displayName(client, userId, logger),
    ]);
    const prompt = buildPrompt({
      permalink,
      authorName,
      channelName: meta.channelName,
      messageText: meta.text,
      isThreadReply: Boolean(meta.threadTs && meta.threadTs !== meta.ts),
      context,
      senderName,
    });

    const where = host?.name ? `*${wsOption.text.text}* on *${host.name}*` : `*${wsOption.text.text}*`;
    const agentLabel = agentOption?.text?.text || agent;
    const choice = {
      hostId,
      hostLabel: values[HOST_BLOCK][HOST_ACTION].selected_option.text.text,
      workspaceValue: wsOption.value,
      workspaceLabel: wsOption.text.text,
      agentValue: agent,
      agentLabel,
    };
    memory.remember(userId, choice);
    let text;
    try {
      await paradev.launch({ workspaceId, hostId, agent, prompt });
      text = `:rocket: Sent <${permalink}|this message> to ${where}. ${agentLabel} is on it.`;
    } catch (err) {
      logger.error(`launch failed: ${err.message}`);
      text = `:x: Could not send <${permalink}|this message> to ${where} with ${agentLabel}: ${notConnectedText(err) || err.message}`;
    }
    // Its metadata is how the next shortcut remembers this choice.
    await client.chat.postMessage({ channel: userId, text, unfurl_links: false, metadata: memory.metadata(choice) });
  });

  // 6. App Home: connection status, connect and disconnect
  app.event('app_home_opened', async ({ event, body, client, logger }) => {
    if (event.tab !== 'home' || !isAllowed(event.user)) return;
    try {
      await publishHome(client, body.team_id || teamOf(body), event.user);
    } catch (err) {
      logger.error(`home publish failed: ${err.message}`);
    }
  });

  app.action(DISCONNECT_ACTION, async ({ body, ack, client }) => {
    await ack();
    if (!oauth) return;
    const teamId = teamOf(body);
    await accounts.disconnect(teamId, body.user.id);
    memory.forget(body.user.id);
    await publishHome(client, teamId, body.user.id);
  });

  /** Called by the OAuth callback once a Slack user has linked their ParaDev account. */
  async function onConnected({ teamId, userId, context, account }) {
    const client = app.client;
    const logger = app.logger || console;
    memory.forget(userId);
    const who = account.email || account.name || 'your ParaDev account';
    await client.chat
      .postMessage({ channel: userId, text: `:white_check_mark: Connected to ParaDev as *${who}*. Messages you send run as you.` })
      .catch((err) => logger.warn(`connect DM failed: ${err.message}`));
    await publishHome(client, teamId, userId).catch((err) => logger.debug(`home publish failed: ${err.message}`));
    // If the user started from a message, turn the waiting connect modal into the form.
    if (context?.viewId && context.meta) {
      const paradev = await accounts.forUser(teamId, userId);
      await showForm({ client, paradev, viewId: context.viewId, meta: context.meta, userId, logger }).catch((err) =>
        logger.debug(`could not swap the connect modal for the form: ${err.data?.error || err.message}`),
      );
    }
  }

  return { onConnected };
}
