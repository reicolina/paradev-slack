import { buildPermalink, buildPrompt, truncate } from './prompt.js';
import {
  AGENT_ACTION,
  CALLBACK_ID,
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

/** The default agent is a preset id; host agents are selected by instance id. */
function defaultAgentValue(agents, defaultAgent) {
  return agents.find((a) => a.presetId === defaultAgent)?.value || defaultAgent;
}

/**
 * Register the shortcut, options, action and view handlers on a Bolt app.
 * @param {import('@slack/bolt').App} app
 * @param {{ paradev: import('./paradev.js').ParaDev, defaultAgent?: string, allowedUserIds?: string[] }} deps
 */
export function registerHandlers(app, { paradev, defaultAgent = 'claude', allowedUserIds = [] }) {
  const isAllowed = (userId) => allowedUserIds.length === 0 || allowedUserIds.includes(userId);

  // 1. "..." on a message -> Send to ParaDev
  app.shortcut(CALLBACK_ID, async ({ shortcut, ack, client, logger }) => {
    await ack();
    if (!isAllowed(shortcut.user.id)) {
      await client.views.open({
        trigger_id: shortcut.trigger_id,
        view: messageView('Send to ParaDev', 'You are not allowed to use this app. Ask its admin to add your Slack user ID.'),
      });
      return;
    }
    // trigger_id expires in 3s, so open the modal before any ParaDev call.
    const meta = messageMetadata(shortcut);
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: buildModal({
        agents: FALLBACK_AGENTS,
        defaultAgent,
        metadata: JSON.stringify(meta),
        preview: meta.text,
      }),
    });
    logger.debug(`opened modal for ${meta.channelId}/${meta.ts}`);
  });

  // 2. Host picker
  app.options(HOST_ACTION, async ({ body, ack, logger }) => {
    if (!isAllowed(body.user?.id)) return ack({ options: [] });
    try {
      const hosts = await paradev.searchHosts(body.value?.trim());
      await ack({ options: hosts.slice(0, 100).map((h) => option(h.id, hostOptionLabel(h))) });
    } catch (err) {
      logger.error(`host search failed: ${err.message}`);
      await ack({ options: [option(ERROR_VALUE, 'Could not reach ParaDev, check the app logs')] });
    }
  });

  // 3. Workspace picker, scoped to the chosen host when there is one
  app.options(WORKSPACE_ACTION, async ({ body, ack, logger }) => {
    if (!isAllowed(body.user?.id)) return ack({ options: [] });
    const hostId = validId(body.view?.state?.values?.[HOST_BLOCK]?.[HOST_ACTION]?.selected_option?.value);
    try {
      const rows = await paradev.searchWorkspaces(body.value?.trim(), hostId);
      await ack({
        options: rows
          .slice(0, 100)
          .map(({ ws, host }) => option(encodeWorkspaceValue(ws), workspaceOptionLabel(ws, host, !hostId))),
      });
    } catch (err) {
      logger.error(`workspace search failed: ${err.message}`);
      await ack({ options: [option(ERROR_VALUE, 'Could not reach ParaDev, check the app logs')] });
    }
  });

  // 4. Host chosen -> reset the workspace picker to that host and load its harnesses
  app.action(HOST_ACTION, async ({ body, ack, client, logger }) => {
    await ack();
    const view = body.view;
    const selectedHost = body.actions?.[0]?.selected_option;
    const hostId = validId(selectedHost?.value);
    if (!hostId) return;

    let agents = FALLBACK_AGENTS;
    let agentNote;
    try {
      const host = await paradev.hostById(hostId);
      if (host && !host.online) {
        agentNote = `:warning: *${host.name}* is offline. Start ParaDev on it before sending.`;
      } else {
        const configs = await paradev.agents(hostId);
        if (configs.length) agents = agentOptions(configs);
      }
    } catch (err) {
      logger.warn(`could not load agents for host ${hostId}: ${err.message}`);
      agentNote = "Could not load this host's harnesses, showing the defaults.";
    }

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
    let text;
    try {
      await paradev.launch({ workspaceId, hostId, agent, prompt });
      text = `:rocket: Sent <${permalink}|this message> to ${where}. ${agentLabel} is on it.`;
    } catch (err) {
      logger.error(`launch failed: ${err.message}`);
      text = `:x: Could not send <${permalink}|this message> to ${where} with ${agentLabel}: ${err.message}`;
    }
    // Posting to a user ID lands in the app's DM with them.
    await client.chat.postMessage({ channel: userId, text, unfurl_links: false });
  });
}
