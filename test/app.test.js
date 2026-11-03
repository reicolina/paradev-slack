import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHandlers } from '../src/app.js';
import { ChoiceMemory } from '../src/memory.js';
import { ParaDev } from '../src/paradev.js';
import { buildPermalink, buildPrompt } from '../src/prompt.js';
import { CALLBACK_ID, HOST_ACTION, VIEW_ID, WORKSPACE_ACTION, buildModal } from '../src/views.js';

// Captures Bolt handlers so each one can be called directly.
function fakeApp() {
  const h = { shortcut: {}, options: {}, action: {}, view: {} };
  return {
    h,
    shortcut: (id, fn) => (h.shortcut[id] = fn),
    options: (id, fn) => (h.options[id] = fn),
    action: (id, fn) => (h.action[id] = fn),
    view: (id, fn) => (h.view[id] = fn),
  };
}

function fakeClient({ dmHistory = [] } = {}) {
  const calls = [];
  const rec = (name, ret = {}) => async (args) => (calls.push([name, args]), ret);
  return {
    calls,
    views: { open: rec('views.open', { view: { id: 'V1', hash: 'h0' } }), update: rec('views.update') },
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

function fakeSdk({ online = true } = {}) {
  const launches = [];
  return {
    launches,
    hosts: {
      list: async () => [
        { id: 'H2', name: 'mac-mini', online: 'no' },
        { id: 'H1', name: 'macbook', online },
      ],
    },
    workspaces: {
      list: async ({ hostId } = {}) =>
        [
          { id: 'W2', name: 'zeta', projectName: 'api', hostId: 'H1' },
          { id: 'W1', name: 'alpha', projectName: 'web', hostId: 'H1' },
          { id: 'W3', name: 'beta', projectName: 'web', hostId: 'H2' },
        ].filter((w) => !hostId || w.hostId === hostId),
    },
    agents: {
      list: async () => [
        { id: 'cfg-codex', presetId: 'codex', label: 'Codex', order: 1 },
        { id: 'cfg-claude', presetId: 'claude', label: 'Claude', order: 0 },
      ],
      create: async (params, opts) => (launches.push({ ...params, ...opts }), { kind: 'terminal', sessionId: 's1', label: 'Claude' }),
    },
  };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const shortcut = {
  type: 'message_action',
  callback_id: CALLBACK_ID,
  trigger_id: 'T',
  user: { id: 'USENDER' },
  team: { domain: 'acme' },
  channel: { id: 'C1', name: 'bugs' },
  message_ts: '1700000000.000100',
  message: { ts: '1700000000.000100', user: 'UAUTHOR', text: 'Login is broken on Safari' },
};

function setup(opts = {}) {
  const app = fakeApp();
  const sdk = fakeSdk(opts);
  const memory = opts.memory || new ChoiceMemory();
  registerHandlers(app, { paradev: new ParaDev(sdk), allowedUserIds: opts.allowed || ['USENDER'], allowAnyone: opts.allowAnyone, memory });
  return { app, sdk, memory, client: fakeClient(opts) };
}

function submission(openedView, { host = 'H1', workspace = 'W1|H1', agentBlock = 'agent:default', agent = 'claude', context = '' } = {}) {
  return {
    ...openedView,
    state: {
      values: {
        host: { [HOST_ACTION]: { selected_option: { value: host, text: { text: 'macbook' } } } },
        [`workspace:${host}`]: { [WORKSPACE_ACTION]: { selected_option: { value: workspace, text: { text: 'alpha · web' } } } },
        [agentBlock]: { agent_select: { selected_option: { value: agent, text: { text: 'Claude' } } } },
        context: { context_input: { value: context } },
      },
    },
  };
}

test('permalink: top-level and thread reply', () => {
  assert.equal(
    buildPermalink({ teamDomain: 'acme', channelId: 'C1', ts: '1700000000.000100' }),
    'https://acme.slack.com/archives/C1/p1700000000000100',
  );
  assert.equal(
    buildPermalink({ teamDomain: 'acme', channelId: 'C1', ts: '1700000000.000200', threadTs: '1700000000.000100' }),
    'https://acme.slack.com/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1',
  );
});

test('prompt includes link, author, text and optional context', () => {
  const p = buildPrompt({ permalink: 'L', authorName: 'Ana', channelName: 'bugs', messageText: 'a\nb', context: ' fix it ', senderName: 'Rei' });
  assert.match(p, /Slack message: L/);
  assert.match(p, /Posted by: Ana in #bugs/);
  assert.match(p, /> a\n> b/);
  assert.match(p, /Context from Rei:\nfix it/);
  assert.doesNotMatch(buildPrompt({ permalink: 'L', senderName: 'Rei' }), /Context from/);
});

test('modal preselects the default harness', () => {
  const v = buildModal({ agents: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }], defaultAgent: 'claude', metadata: '{}' });
  const agentBlock = v.blocks.find((b) => b.block_id?.startsWith('agent:'));
  assert.equal(agentBlock.element.initial_option.value, 'claude');
});

test('end to end: shortcut -> host -> workspace -> submit launches the agent', async () => {
  const { app, sdk, client } = setup();
  const ack = async (r) => r;

  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack, client, logger });
  const opened = client.calls.find(([n]) => n === 'views.open')[1].view;
  assert.equal(opened.callback_id, VIEW_ID);
  assert.equal(JSON.parse(opened.private_metadata).channelId, 'C1');
  assert.deepEqual(opened.blocks.filter((b) => b.type === 'input').map((b) => b.block_id), ['host', 'workspace:any', 'agent:default', 'context']);

  let hosts;
  await app.h.options[HOST_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (hosts = r), logger });
  assert.deepEqual(hosts.options.map((o) => [o.value, o.text.text]), [['H1', 'macbook'], ['H2', 'mac-mini (offline)']]);

  const selectedHost = hosts.options[0];
  await app.h.action[HOST_ACTION]({
    body: { user: { id: 'USENDER' }, view: { ...opened, id: 'V1', hash: 'h' }, actions: [{ selected_option: selectedHost }] },
    ack,
    client,
    logger,
  });
  const updated = client.calls.find(([n]) => n === 'views.update')[1].view;
  assert.equal(updated.blocks.find((b) => b.block_id === 'host').element.initial_option.value, 'H1');
  assert.ok(updated.blocks.some((b) => b.block_id === 'workspace:H1'), 'workspace picker resets for the new host');
  const agentBlock = updated.blocks.find((b) => b.block_id?.startsWith('agent:'));
  assert.equal(agentBlock.block_id, 'agent:H1');
  assert.deepEqual(agentBlock.element.options.map((o) => o.value), ['cfg-claude', 'cfg-codex']);
  assert.equal(agentBlock.element.initial_option.value, 'cfg-claude');

  let workspaces;
  await app.h.options[WORKSPACE_ACTION]({
    body: { user: { id: 'USENDER' }, value: '', view: { state: { values: { host: { [HOST_ACTION]: { selected_option: selectedHost } } } } } },
    ack: async (r) => (workspaces = r),
    logger,
  });
  assert.deepEqual(workspaces.options.map((o) => [o.value, o.text.text]), [['W1|H1', 'alpha · web'], ['W2|H1', 'zeta · api']]);

  let submitAck;
  await app.h.view[VIEW_ID]({
    view: submission(updated, { agentBlock: 'agent:H1', agent: 'cfg-claude', context: 'fix it and open a PR' }),
    body: { user: { id: 'USENDER' } },
    ack: async (r) => (submitAck = r),
    client,
    logger,
  });
  assert.equal(submitAck, undefined, 'plain ack closes the modal');
  assert.equal(sdk.launches.length, 1);
  const launch = sdk.launches[0];
  assert.equal(launch.workspaceId, 'W1');
  assert.equal(launch.hostId, 'H1');
  assert.equal(launch.agent, 'cfg-claude');
  assert.match(launch.prompt, /https:\/\/acme\.slack\.com\/archives\/C1\/p1700000000000100/);
  assert.match(launch.prompt, /Posted by: Ana in #bugs/);
  assert.match(launch.prompt, /Context from Rei:\nfix it and open a PR/);
  const dm = client.calls.find(([n]) => n === 'chat.postMessage')[1];
  assert.equal(dm.channel, 'USENDER');
  assert.match(dm.text, /\*alpha · web\* on \*macbook\*\. Claude is on it/);
});

test('without a host, the workspace picker lists every host and labels them', async () => {
  const { app } = setup();
  let workspaces;
  await app.h.options[WORKSPACE_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (workspaces = r), logger });
  assert.deepEqual(workspaces.options.map((o) => o.text.text), ['alpha · web · macbook', 'zeta · api · macbook', 'beta · web · mac-mini (offline)']);
});

test('submit rejects a missing host and a workspace from another host', async () => {
  const { app, sdk, client } = setup();
  const meta = JSON.stringify({ channelId: 'C1', ts: '1.2', teamDomain: 'acme' });
  let submitAck;
  const run = (view) => app.h.view[VIEW_ID]({ view, body: { user: { id: 'USENDER' } }, ack: async (r) => (submitAck = r), client, logger });

  await run({ private_metadata: meta, state: { values: {} } });
  assert.deepEqual(submitAck.errors, { host: 'Pick a host.' });

  const v = submission({ private_metadata: meta }, { host: 'H1', workspace: 'W3|H2' });
  await run(v);
  assert.match(submitAck.errors['workspace:H1'], /another host/);
  assert.equal(sdk.launches.length, 0);
});

test('submit to an offline host shows an error and launches nothing', async () => {
  const { app, sdk, client } = setup({ online: false });
  let submitAck;
  await app.h.view[VIEW_ID]({
    view: submission({ private_metadata: JSON.stringify({ channelId: 'C1', ts: '1.2', teamDomain: 'acme' }) }),
    body: { user: { id: 'USENDER' } },
    ack: async (r) => (submitAck = r),
    client,
    logger,
  });
  assert.equal(submitAck.response_action, 'errors');
  assert.match(submitAck.errors.host, /offline/);
  assert.equal(sdk.launches.length, 0);
});

test('users outside the allowlist cannot launch', async () => {
  const { app, sdk, client } = setup({ allowed: ['USOMEONE_ELSE'] });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  assert.match(client.calls[0][1].view.blocks[0].text.text, /not allowed/);
  let submitAck;
  await app.h.view[VIEW_ID]({ view: submission({}), body: { user: { id: 'USENDER' } }, ack: async (r) => (submitAck = r), client, logger });
  assert.equal(submitAck.response_action, 'errors');
  assert.equal(sdk.launches.length, 0);
});

const remembered = {
  hostId: 'H1',
  hostLabel: 'macbook',
  workspaceValue: 'W2|H1',
  workspaceLabel: 'zeta · api',
  agentValue: 'cfg-codex',
  agentLabel: 'Codex',
};

function prefilled(client) {
  const update = client.calls.find(([n]) => n === 'views.update');
  if (!update) return undefined;
  const [, { view, view_id, hash }] = update;
  const block = (id) => view.blocks.find((b) => b.block_id === id || b.block_id?.startsWith(`${id}:`));
  return {
    view_id,
    hash,
    host: block('host').element.initial_option?.value,
    workspace: block('workspace').element.initial_option?.value,
    agent: block('agent').element.initial_option?.value,
  };
}

test('submit stores the choice in the DM metadata', async () => {
  const { app, memory, client } = setup();
  await app.h.view[VIEW_ID]({
    view: submission({ private_metadata: JSON.stringify({ channelId: 'C1', ts: '1.2', teamDomain: 'acme' }) }, { agentBlock: 'agent:H1', agent: 'cfg-claude' }),
    body: { user: { id: 'USENDER' } },
    ack: async () => {},
    client,
    logger,
  });
  const dm = client.calls.find(([n]) => n === 'chat.postMessage')[1];
  assert.equal(dm.metadata.event_type, 'paradev_last_choice');
  assert.deepEqual(dm.metadata.event_payload, {
    hostId: 'H1',
    hostLabel: 'macbook',
    workspaceValue: 'W1|H1',
    workspaceLabel: 'alpha · web',
    agentValue: 'cfg-claude',
    agentLabel: 'Claude',
  });
  assert.deepEqual(memory.cache.get('USENDER'), dm.metadata.event_payload);
});

test('shortcut prefills host, workspace and harness from the last DM (after a restart)', async () => {
  const dmHistory = [{ text: 'hi' }, { text: 'sent', metadata: { event_type: 'paradev_last_choice', event_payload: remembered } }];
  const { app, client } = setup({ dmHistory });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  assert.deepEqual(prefilled(client), { view_id: 'V1', hash: 'h0', host: 'H1', workspace: 'W2|H1', agent: 'cfg-codex' });
  assert.equal(client.calls.find(([n]) => n === 'conversations.history')[1].include_all_metadata, true);
});

test('a deleted workspace is not prefilled, the host and harness still are', async () => {
  const memory = new ChoiceMemory();
  memory.remember('USENDER', { ...remembered, workspaceValue: 'GONE|H1' });
  const { app, client } = setup({ memory });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  const p = prefilled(client);
  assert.equal(p.host, 'H1');
  assert.equal(p.workspace, undefined);
  assert.equal(p.agent, 'cfg-codex');
  assert.ok(!client.calls.some(([n]) => n === 'conversations.history'), 'cache hit skips the DM read');
});

test('no remembered choice leaves the modal on its defaults', async () => {
  const { app, client } = setup();
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  assert.equal(prefilled(client), undefined);
});

test('an empty allowlist denies everyone, at every step', async () => {
  const { app, sdk, client } = setup({ allowed: [] });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  assert.match(client.calls[0][1].view.blocks[0].text.text, /not allowed/);

  let hosts;
  await app.h.options[HOST_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (hosts = r), logger });
  assert.deepEqual(hosts.options, []);
  let workspaces;
  await app.h.options[WORKSPACE_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (workspaces = r), logger });
  assert.deepEqual(workspaces.options, []);

  await app.h.action[HOST_ACTION]({ body: { user: { id: 'USENDER' }, view: {}, actions: [{ selected_option: { value: 'H1' } }] }, ack: async () => {}, client, logger });
  assert.ok(!client.calls.some(([n]) => n === 'views.update'), 'no host details for a denied user');

  let submitAck;
  await app.h.view[VIEW_ID]({ view: submission({}), body: { user: { id: 'USENDER' } }, ack: async (r) => (submitAck = r), client, logger });
  assert.equal(submitAck.response_action, 'errors');
  assert.equal(sdk.launches.length, 0);
});
