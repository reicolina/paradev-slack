import { buildPermalink, buildPrompt, truncate } from './prompt.js';
import {
  AGENT_ACTION,
  CALLBACK_ID,
  CONTEXT_ACTION,
  CONTEXT_BLOCK,
  FALLBACK_AGENTS,
  VIEW_ID,
  WORKSPACE_ACTION,
  WORKSPACE_BLOCK,
  buildModal,
  decodeWorkspaceValue,
  encodeWorkspaceValue,
  option,
  plain,
  workspaceOptionLabel,
} from './views.js';

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

  // 2. Workspace picker search
  app.options(WORKSPACE_ACTION, async ({ body, ack, logger }) => {
    if (!isAllowed(body.user?.id)) return ack({ options: [] });
    try {
      const rows = await paradev.searchWorkspaces(body.value?.trim());
      await ack({
        options: rows.slice(0, 100).map(({ ws, host }) => option(encodeWorkspaceValue(ws), workspaceOptionLabel(ws, host))),
      });
    } catch (err) {
      logger.error(`workspace search failed: ${err.message}`);
      await ack({ options: [option('error|', 'Could not reach ParaDev, check the app logs')] });
    }
  });

  // 3. Workspace chosen -> load that host's harnesses
  app.action(WORKSPACE_ACTION, async ({ body, ack, client, logger }) => {
    await ack();
    const view = body.view;
    const selectedWorkspace = body.actions?.[0]?.selected_option;
    const { hostId } = decodeWorkspaceValue(selectedWorkspace?.value);
    if (!hostId) return;

    let agents = FALLBACK_AGENTS;
    let agentNote;
    let host;
    try {
      host = await paradev.hostById(hostId);
      if (host && !host.online) {
        agentNote = `:warning: *${host.name}* is offline. Start ParaDev on it before sending.`;
      } else {
        const configs = await paradev.agents(hostId);
        if (configs.length) agents = agentOptions(configs);
      }
    } catch (err) {
      logger.warn(`could not load agents for host ${hostId}: ${err.message}`);
      agentNote = 'Could not load this host\'s harnesses, showing the defaults.';
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
          selectedWorkspace,
        }),
      });
    } catch (err) {
      // hash_conflict: the user changed the view again; the newer update wins.
      logger.debug(`views.update skipped: ${err.data?.error || err.message}`);
    }
  });

  // 4. Submit -> start the agent in the workspace
  app.view(VIEW_ID, async ({ view, body, ack, client, logger }) => {
    const userId = body.user.id;
    if (!isAllowed(userId)) {
      return ack({ response_action: 'errors', errors: { [WORKSPACE_BLOCK]: 'You are not allowed to use this app.' } });
    }

    const values = view.state.values;
    const wsOption = values[WORKSPACE_BLOCK]?.[WORKSPACE_ACTION]?.selected_option;
    const { workspaceId, hostId } = decodeWorkspaceValue(wsOption?.value);
    if (!workspaceId || !hostId) {
      return ack({ response_action: 'errors', errors: { [WORKSPACE_BLOCK]: 'Pick a workspace.' } });
    }
    const agentBlock = Object.keys(values).find((k) => k.startsWith('agent:'));
    const agentOption = values[agentBlock]?.[AGENT_ACTION]?.selected_option;
    const agent = agentOption?.value || defaultAgent;
    const context = values[CONTEXT_BLOCK]?.[CONTEXT_ACTION]?.value || '';

    const host = await paradev.hostById(hostId).catch(() => undefined);
    if (host && !host.online) {
      return ack({
        response_action: 'errors',
        errors: { [WORKSPACE_BLOCK]: `${host.name} is offline. Start ParaDev on it, or pick another workspace.` },
      });
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

    const wsLabel = wsOption.text.text;
    const agentLabel = agentOption?.text?.text || agent;
    let text;
    try {
      await paradev.launch({ workspaceId, hostId, agent, prompt });
      text = `:rocket: Sent <${permalink}|this message> to *${wsLabel}*. ${agentLabel} is on it.`;
    } catch (err) {
      logger.error(`launch failed: ${err.message}`);
      text = `:x: Could not send <${permalink}|this message> to *${wsLabel}* with ${agentLabel}: ${err.message}`;
    }
    // Posting to a user ID lands in the app's DM with them.
    await client.chat.postMessage({ channel: userId, text, unfurl_links: false });
  });
}
