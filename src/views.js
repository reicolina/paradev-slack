export const CALLBACK_ID = 'send_to_paradev';
export const VIEW_ID = 'send_to_paradev_modal';
export const HOST_BLOCK = 'host';
export const HOST_ACTION = 'host_select';
export const PROJECT_ACTION = 'project_select';
/** Project option for a project-less session (a scratch folder). */
export const NO_PROJECT = 'none';
export const AGENT_ACTION = 'agent_select';
export const CONTEXT_BLOCK = 'context';
export const CONTEXT_ACTION = 'context_input';

// Used until the chosen workspace's host reports its own configured agents.
export const FALLBACK_AGENTS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'cursor-agent', label: 'Cursor Agent' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'amp', label: 'Amp' },
  { value: 'droid', label: 'Droid' },
];

const plain = (text) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true });

function option(value, label) {
  return { text: plain(label), value };
}

// Block ids change with the host so Slack drops the old selection and applies the new initial_option.
export function agentBlockId(hostId) {
  return `agent:${hostId || 'default'}`;
}

export function projectBlockId(hostId) {
  return `project:${hostId || 'any'}`;
}

/** Find a block's value when its id carries a suffix, e.g. `project:<hostId>`. */
export function findValue(values, prefix, actionId) {
  const key = Object.keys(values || {}).find((k) => k === prefix || k.startsWith(`${prefix}:`));
  return key ? values[key]?.[actionId] : undefined;
}

/**
 * @param {object} p
 * @param {Array<{value:string,label:string}>} p.agents
 * @param {string} p.defaultAgent preset id to preselect
 * @param {string} [p.hostId]
 * @param {string} p.metadata JSON string carried to the submission
 * @param {string} [p.preview] the message text, shown read-only
 * @param {string} [p.agentNote] small note under the harness picker
 * @param {object} [p.selectedHost] option to keep selected in the host picker
 * @param {object} [p.selectedProject] option to preselect in the project picker
 */
export function buildModal({ agents, defaultAgent, hostId, metadata, preview, agentNote, selectedHost, selectedProject }) {
  const options = agents.slice(0, 100).map((a) => option(a.value, a.label));
  const initial =
    options.find((o) => o.value === defaultAgent) ||
    options.find((o) => o.text.text.toLowerCase() === defaultAgent.toLowerCase()) ||
    options[0];

  const blocks = [];
  if (preview) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `>${preview.slice(0, 280).replace(/\n/g, '\n>')}${preview.length > 280 ? '…' : ''}` }],
    });
  }

  blocks.push(
    {
      type: 'input',
      block_id: HOST_BLOCK,
      dispatch_action: true,
      label: plain('ParaDev host'),
      element: {
        type: 'external_select',
        action_id: HOST_ACTION,
        placeholder: plain('Pick a host'),
        min_query_length: 0,
        ...(selectedHost ? { initial_option: selectedHost } : {}),
      },
    },
    {
      type: 'input',
      block_id: projectBlockId(hostId),
      label: plain('Project'),
      hint: plain('A new workspace is created in this project for the agent.'),
      element: {
        type: 'external_select',
        action_id: PROJECT_ACTION,
        placeholder: plain(hostId ? 'Search projects on this host' : 'Pick a host first'),
        min_query_length: 0,
        ...(selectedProject ? { initial_option: selectedProject } : {}),
      },
    },
    {
      type: 'input',
      block_id: agentBlockId(hostId),
      label: plain('AI harness'),
      element: {
        type: 'static_select',
        action_id: AGENT_ACTION,
        options,
        ...(initial ? { initial_option: initial } : {}),
      },
    },
  );

  if (agentNote) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: agentNote }] });
  }

  blocks.push({
    type: 'input',
    block_id: CONTEXT_BLOCK,
    optional: true,
    label: plain('Context (optional)'),
    element: {
      type: 'plain_text_input',
      action_id: CONTEXT_ACTION,
      multiline: true,
      max_length: 3000,
      placeholder: plain('Anything the agent should know, e.g. "fix this bug and open a PR"'),
    },
  });

  return {
    type: 'modal',
    callback_id: VIEW_ID,
    title: plain('Send to ParaDev'),
    submit: plain('Send'),
    close: plain('Cancel'),
    private_metadata: metadata,
    blocks,
  };
}

export function hostOptionLabel(host) {
  return `${host.name}${host.online ? '' : ' (offline)'}`;
}

export function projectOptionLabel(project) {
  const repo = project.repoName && project.repoName !== project.name ? ` · ${project.repoName}` : '';
  return `${project.name}${repo}`;
}

export const NO_PROJECT_LABEL = 'No project (scratch session)';

export const CONNECT_ACTION = 'connect_paradev';
export const DISCONNECT_ACTION = 'disconnect_paradev';
export const CONNECT_VIEW_ID = 'connect_paradev_modal';

function connectButton(url, text = 'Connect ParaDev') {
  return { type: 'button', action_id: CONNECT_ACTION, text: plain(text), url, style: 'primary' };
}

/** Shown instead of the form until the user links their own ParaDev account. */
export function connectModal({ url, metadata, reason }) {
  return {
    type: 'modal',
    callback_id: CONNECT_VIEW_ID,
    title: plain('Send to ParaDev'),
    close: plain('Cancel'),
    private_metadata: metadata,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${reason ? `${reason}\n\n` : ''}Connect your ParaDev account first. Jobs you send run as you, on your own hosts.`,
        },
      },
      { type: 'actions', elements: [connectButton(url)] },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Sign in opens in your browser. Keep this window open: the form appears here once you are connected.' }],
      },
    ],
  };
}

/** App Home tab: connection status and connect / disconnect. */
export function homeView({ status, connectUrl }) {
  const blocks = [{ type: 'header', text: plain('ParaDev for Slack') }];
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: 'On any message, open *⋯ More actions* and pick *Send to ParaDev* to start an agent on it in a new workspace in one of your projects.',
    },
  });
  if (status.shared) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'This install uses one shared ParaDev account set by its admin.' }] });
  } else if (status.connected) {
    const who = [status.name, status.email && `(${status.email})`].filter(Boolean).join(' ') || 'your ParaDev account';
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: Connected as *${who}*.` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: DISCONNECT_ACTION,
            text: plain('Disconnect'),
            style: 'danger',
            confirm: {
              title: plain('Disconnect ParaDev?'),
              text: { type: 'mrkdwn', text: 'The app forgets your ParaDev sign-in. You can connect again any time.' },
              confirm: plain('Disconnect'),
              deny: plain('Cancel'),
            },
          },
        ],
      },
    );
  } else {
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: 'Not connected. Connect your ParaDev account to send jobs to your own hosts.' } },
      { type: 'actions', elements: [connectButton(connectUrl)] },
    );
  }
  return { type: 'home', blocks };
}

export { option, plain };
