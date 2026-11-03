import { ParaDev } from '../src/paradev.js';

export const logger = { debug() {}, info() {}, warn() {}, error() {} };

// Captures Bolt handlers so each one can be called directly.
export function fakeApp() {
  const h = { shortcut: {}, options: {}, action: {}, view: {}, event: {} };
  const client = fakeClient();
  return {
    h,
    client,
    logger,
    shortcut: (id, fn) => (h.shortcut[id] = fn),
    options: (id, fn) => (h.options[id] = fn),
    action: (id, fn) => (h.action[id] = fn),
    view: (id, fn) => (h.view[id] = fn),
    event: (id, fn) => (h.event[id] = fn),
  };
}

export function fakeClient({ dmHistory = [] } = {}) {
  const calls = [];
  const rec = (name, ret = {}) => async (args) => (calls.push([name, args]), typeof ret === 'function' ? ret(args) : ret);
  return {
    calls,
    called: (name) => calls.filter(([n]) => n === name).map(([, a]) => a),
    views: {
      open: rec('views.open', { view: { id: 'V1', hash: 'h0' } }),
      update: rec('views.update', (a) => ({ view: { id: a.view_id, hash: 'h1' } })),
      publish: rec('views.publish'),
    },
    conversations: {
      open: rec('conversations.open', { channel: { id: 'D1' } }),
      history: rec('conversations.history', { messages: dmHistory }),
    },
    chat: {
      getPermalink: rec('chat.getPermalink', { permalink: 'https://acme.slack.com/archives/C1/p1700000000000100' }),
      postMessage: rec('chat.postMessage'),
    },
    users: { info: async ({ user }) => ({ user: { profile: { display_name: user === 'UAUTHOR' ? 'Ana' : 'Rei' } } }) },
  };
}

/** ParaDev MCP tools over fake data. `online` controls host H1. */
export function fakeMcp({ online = true } = {}) {
  const launches = [];
  const workspaces = [
    { id: 'W2', name: 'zeta', projectName: 'api', branch: 'main', hostId: 'H1', lastActivityAt: 1 },
    { id: 'W1', name: 'alpha', projectName: 'web', branch: 'fix', hostId: 'H1', lastActivityAt: 2 },
    { id: 'W9', name: 'old', projectName: 'web', branch: 'x', hostId: 'H1', archivedAt: '2026-01-01' },
  ];
  const tools = {
    hosts_list: () => [
      { id: 'H2', name: 'mac-mini', online: false },
      { id: 'H1', name: 'macbook', online },
    ],
    workspaces_list: ({ hostId }) => {
      if (hostId === 'H2') throw Object.assign(new Error('Host is not online'), {});
      return workspaces.filter((w) => w.hostId === hostId);
    },
    agents_list: () => [
      { id: 'cfg-codex', presetId: 'codex', label: 'Codex', order: 1 },
      { id: 'cfg-claude', presetId: 'claude', label: 'Claude', order: 0 },
    ],
    agents_create: (args) => (launches.push(args), { kind: 'terminal', sessionId: 's1', label: 'Claude' }),
  };
  return { launches, callTool: async (name, args = {}) => tools[name](args) };
}

/** Accounts double: everyone listed in `connected` has a ParaDev client. */
export function fakeAccounts({ mode = 'oauth', connected = ['USENDER'], mcp = fakeMcp() } = {}) {
  const paradev = new ParaDev(mcp);
  const pending = [];
  return {
    mode,
    mcp,
    pending,
    disconnected: [],
    async forUser(_teamId, userId) {
      return connected.includes(userId) ? paradev : null;
    },
    async status(_teamId, userId) {
      return connected.includes(userId) ? { connected: true, email: 'rei@example.com' } : { connected: false };
    },
    async connectUrl({ teamId, userId, context }) {
      const state = `state-${pending.length}`;
      pending.push({ state, teamId, userId, context });
      return { url: `https://paradev.test/authorize?state=${state}`, state };
    },
    addContext(state, extra) {
      Object.assign(pending.find((p) => p.state === state).context, extra);
    },
    async disconnect(teamId, userId) {
      this.disconnected.push(userId);
      connected.splice(connected.indexOf(userId), 1);
    },
    connect(userId) {
      connected.push(userId);
    },
  };
}

export const shortcut = {
  type: 'message_action',
  callback_id: 'send_to_paradev',
  trigger_id: 'T',
  user: { id: 'USENDER', team_id: 'T1' },
  team: { id: 'T1', domain: 'acme' },
  channel: { id: 'C1', name: 'bugs' },
  message_ts: '1700000000.000100',
  message: { ts: '1700000000.000100', user: 'UAUTHOR', text: 'Login is broken on Safari' },
};

export function submission(openedView, { host = 'H1', workspace = 'W1|H1', agentBlock = 'agent:default', agent = 'claude', context = '' } = {}) {
  return {
    ...openedView,
    private_metadata: openedView.private_metadata || JSON.stringify({ channelId: 'C1', ts: '1.2', teamDomain: 'acme' }),
    state: {
      values: {
        host: { host_select: { selected_option: { value: host, text: { text: 'macbook' } } } },
        [`workspace:${host}`]: { workspace_select: { selected_option: { value: workspace, text: { text: 'alpha · web' } } } },
        [agentBlock]: { agent_select: { selected_option: { value: agent, text: { text: 'Claude' } } } },
        context: { context_input: { value: context } },
      },
    },
  };
}

/** A fetch double: routes by URL, records every request. */
export function fakeFetch(routes) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, init, body: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body });
    const route = Object.keys(routes).find((k) => u.startsWith(k));
    if (!route) throw new Error(`unexpected fetch ${u}`);
    const { status = 200, json, text, headers = {} } = await routes[route](u, init);
    const body = text ?? JSON.stringify(json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(headers)),
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  fn.requests = requests;
  return fn;
}
