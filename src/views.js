export const CALLBACK_ID = 'send_to_paradev';
export const VIEW_ID = 'send_to_paradev_modal';
export const WORKSPACE_BLOCK = 'workspace';
export const WORKSPACE_ACTION = 'workspace_select';
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

/** Block ids change with the agent list so Slack applies the new initial_option. */
export function agentBlockId(hostId) {
  return `agent:${hostId || 'default'}`;
}

/**
 * @param {object} p
 * @param {Array<{value:string,label:string}>} p.agents
 * @param {string} p.defaultAgent preset id to preselect
 * @param {string} [p.hostId]
 * @param {string} p.metadata JSON string carried to the submission
 * @param {string} [p.preview] the message text, shown read-only
 * @param {string} [p.agentNote] small note under the harness picker
 * @param {object} [p.selectedWorkspace] option to keep selected in the workspace picker
 */
export function buildModal({ agents, defaultAgent, hostId, metadata, preview, agentNote, selectedWorkspace }) {
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
      block_id: WORKSPACE_BLOCK,
      dispatch_action: true,
      label: plain('ParaDev workspace'),
      element: {
        type: 'external_select',
        action_id: WORKSPACE_ACTION,
        placeholder: plain('Search workspaces'),
        min_query_length: 0,
        ...(selectedWorkspace ? { initial_option: selectedWorkspace } : {}),
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

export function workspaceOptionLabel(ws, host) {
  const status = host ? (host.online ? '' : ' (offline)') : '';
  const where = host?.name ? ` · ${host.name}` : '';
  return `${ws.name} · ${ws.projectName}${where}${status}`;
}

export function encodeWorkspaceValue(ws) {
  return `${ws.id}|${ws.hostId}`;
}

export function decodeWorkspaceValue(value) {
  const [workspaceId, hostId] = String(value || '').split('|');
  return { workspaceId, hostId };
}

export { option, plain };
