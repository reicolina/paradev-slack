import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHandlers } from '../src/app.js';
import { ChoiceMemory } from '../src/memory.js';
import { buildPermalink, buildPrompt } from '../src/prompt.js';
import { CALLBACK_ID, HOST_ACTION, VIEW_ID, WORKSPACE_ACTION, buildModal } from '../src/views.js';
import { fakeAccounts, fakeApp, fakeClient, fakeMcp, logger, shortcut, submission } from './helpers.js';

function setup(opts = {}) {
  const app = fakeApp();
  const mcp = fakeMcp(opts);
  const accounts = opts.accounts || fakeAccounts({ mcp, connected: opts.connected });
  const memory = opts.memory || new ChoiceMemory();
  const { onConnected } = registerHandlers(app, {
    accounts,
    allowedUserIds: opts.allowed || [],
    allowAnyone: opts.allowAnyone ?? !opts.allowed,
    memory,
  });
  return { app, mcp: accounts.mcp, accounts, memory, onConnected, client: fakeClient(opts) };
}

const submit = async (app, client, view, user = 'USENDER') => {
  let res;
  await app.h.view[VIEW_ID]({ view, body: { user: { id: user, team_id: 'T1' }, team: { id: 'T1' } }, ack: async (r) => (res = r), client, logger });
  return res;
};

test('permalink: top-level and thread reply', () => {
  assert.equal(buildPermalink({ teamDomain: 'acme', channelId: 'C1', ts: '1700000000.000100' }), 'https://acme.slack.com/archives/C1/p1700000000000100');
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

test('workspace labels: sessions have no project', async () => {
  const { workspaceOptionLabel } = await import('../src/views.js');
  assert.equal(workspaceOptionLabel({ name: 'scratch', projectName: null, type: 'session' }, undefined, false), 'scratch · session');
  assert.equal(workspaceOptionLabel({ name: 'x', projectName: null }, { name: 'mac', online: false }), 'x · mac (offline)');
});

test('modal preselects the default harness', () => {
  const v = buildModal({ agents: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }], defaultAgent: 'claude', metadata: '{}' });
  assert.equal(v.blocks.find((b) => b.block_id?.startsWith('agent:')).element.initial_option.value, 'claude');
});

test('end to end: shortcut -> host -> workspace -> submit launches the agent as the user', async () => {
  const { app, mcp, client } = setup();
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  const opened = client.called('views.open')[0].view;
  assert.equal(opened.callback_id, VIEW_ID);
  assert.deepEqual(opened.blocks.filter((b) => b.type === 'input').map((b) => b.block_id), ['host', 'workspace:any', 'agent:default', 'context']);

  let hosts;
  await app.h.options[HOST_ACTION]({ body: { user: { id: 'USENDER', team_id: 'T1' }, value: '' }, ack: async (r) => (hosts = r), logger });
  assert.deepEqual(hosts.options.map((o) => [o.value, o.text.text]), [['H1', 'macbook'], ['H2', 'mac-mini (offline)']]);

  const selectedHost = hosts.options[0];
  await app.h.action[HOST_ACTION]({
    body: { user: { id: 'USENDER', team_id: 'T1' }, view: { ...opened, id: 'V1', hash: 'h' }, actions: [{ selected_option: selectedHost }] },
    ack: async () => {},
    client,
    logger,
  });
  const updated = client.called('views.update')[0].view;
  assert.ok(updated.blocks.some((b) => b.block_id === 'workspace:H1'), 'workspace picker resets for the new host');
  const agentBlock = updated.blocks.find((b) => b.block_id?.startsWith('agent:'));
  assert.deepEqual(agentBlock.element.options.map((o) => o.value), ['cfg-claude', 'cfg-codex']);
  assert.equal(agentBlock.element.initial_option.value, 'cfg-claude');

  let workspaces;
  await app.h.options[WORKSPACE_ACTION]({
    body: { user: { id: 'USENDER', team_id: 'T1' }, value: '', view: { state: { values: { host: { [HOST_ACTION]: { selected_option: selectedHost } } } } } },
    ack: async (r) => (workspaces = r),
    logger,
  });
  assert.deepEqual(
    workspaces.options.map((o) => [o.value, o.text.text]),
    [['W1|H1', 'alpha · web'], ['W2|H1', 'zeta · api']],
    'most recent first, archived hidden',
  );

  const res = await submit(app, client, submission(updated, { agentBlock: 'agent:H1', agent: 'cfg-claude', context: 'fix it and open a PR' }));
  assert.equal(res, undefined, 'plain ack closes the modal');
  assert.equal(mcp.launches.length, 1);
  const launch = mcp.launches[0];
  assert.deepEqual([launch.workspaceId, launch.hostId, launch.agent], ['W1', 'H1', 'cfg-claude']);
  assert.match(launch.prompt, /https:\/\/acme\.slack\.com\/archives\/C1\/p1700000000000100/);
  assert.match(launch.prompt, /Context from Rei:\nfix it and open a PR/);
  const dm = client.called('chat.postMessage')[0];
  assert.equal(dm.channel, 'USENDER');
  assert.match(dm.text, /\*alpha · web\* on \*macbook\*\. Claude is on it/);
});

test('workspace search filters by name, branch or project, and needs a host', async () => {
  const { app } = setup();
  const search = async (value, host) => {
    let r;
    const view = host ? { state: { values: { host: { [HOST_ACTION]: { selected_option: { value: host } } } } } } : undefined;
    await app.h.options[WORKSPACE_ACTION]({ body: { user: { id: 'USENDER' }, value, view }, ack: async (x) => (r = x), logger });
    return r.options.map((o) => o.value);
  };
  assert.deepEqual(await search('', undefined), []);
  assert.deepEqual(await search('api', 'H1'), ['W2|H1']);
  assert.deepEqual(await search('fix', 'H1'), ['W1|H1']);
});

test('submit validation: offline host, missing host, workspace from another host', async () => {
  const offline = setup({ online: false });
  let res = await submit(offline.app, offline.client, submission({}));
  assert.match(res.errors.host, /offline/);

  const { app, mcp, client } = setup();
  res = await submit(app, client, { private_metadata: '{}', state: { values: {} } });
  assert.deepEqual(res.errors, { host: 'Pick a host.' });
  res = await submit(app, client, submission({}, { host: 'H1', workspace: 'W3|H2' }));
  assert.match(res.errors['workspace:H1'], /another host/);
  assert.equal(mcp.launches.length + offline.mcp.launches.length, 0);
});

test('a user who has not connected gets a Connect modal, then the form once they connect', async () => {
  const { app, accounts, onConnected, client } = setup({ connected: [] });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  const modal = client.called('views.open')[0].view;
  assert.equal(modal.callback_id, 'connect_paradev_modal');
  const button = modal.blocks.find((b) => b.type === 'actions').elements[0];
  assert.equal(button.url, 'https://paradev.test/authorize?state=state-0');
  assert.equal(accounts.pending[0].context.viewId, 'V1', 'the modal id rides along with the sign-in');

  let hosts;
  await app.h.options[HOST_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (hosts = r), logger });
  assert.match(hosts.options[0].text.text, /Connect ParaDev first/);
  assert.match((await submit(app, client, submission({}))).errors.host, /Connect your ParaDev account/);

  // The OAuth callback completes for this user.
  accounts.connect('USENDER');
  await onConnected({ teamId: 'T1', userId: 'USENDER', context: accounts.pending[0].context, account: { email: 'rei@example.com' } });
  const appClient = app.client;
  assert.match(appClient.called('chat.postMessage')[0].text, /Connected to ParaDev as \*rei@example.com\*/);
  const swapped = appClient.called('views.update')[0];
  assert.equal(swapped.view_id, 'V1');
  assert.equal(swapped.view.callback_id, VIEW_ID, 'connect modal became the form');
  assert.equal(JSON.parse(swapped.view.private_metadata).channelId, 'C1');
  assert.equal(appClient.called('views.publish')[0].user_id, 'USENDER', 'home tab refreshed');
});

test('each Slack user acts as their own account: an unconnected user cannot use a connected one', async () => {
  const { app, client } = setup({ connected: ['USENDER'] });
  const other = { ...shortcut, user: { id: 'UOTHER', team_id: 'T1' } };
  await app.h.shortcut[CALLBACK_ID]({ shortcut: other, ack: async () => {}, client, logger });
  assert.equal(client.called('views.open')[0].view.callback_id, 'connect_paradev_modal');
});

test('home tab shows status and disconnect works', async () => {
  const { app, accounts, client } = setup();
  await app.h.event.app_home_opened({ event: { tab: 'home', user: 'USENDER' }, body: { team_id: 'T1' }, client, logger });
  assert.match(JSON.stringify(client.called('views.publish')[0].view), /Connected as/);
  await app.h.action.disconnect_paradev({ body: { user: { id: 'USENDER', team_id: 'T1' } }, ack: async () => {}, client });
  assert.deepEqual(accounts.disconnected, ['USENDER']);
  assert.match(JSON.stringify(client.called('views.publish')[1].view), /Not connected/);
});

test('personal mode: allowlist denies everyone else at every step', async () => {
  const { app, mcp, client } = setup({ allowed: ['USOMEONE_ELSE'], accounts: fakeAccounts({ mode: 'api-key' }) });
  await app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client, logger });
  assert.match(client.calls[0][1].view.blocks[0].text.text, /not allowed/);
  let hosts;
  await app.h.options[HOST_ACTION]({ body: { user: { id: 'USENDER' }, value: '' }, ack: async (r) => (hosts = r), logger });
  assert.deepEqual(hosts.options, []);
  await app.h.action[HOST_ACTION]({ body: { user: { id: 'USENDER' }, view: {}, actions: [{ selected_option: { value: 'H1' } }] }, ack: async () => {}, client, logger });
  assert.equal(client.called('views.update').length, 0);
  assert.equal((await submit(app, client, submission({}))).response_action, 'errors');
  assert.equal(mcp.launches.length, 0);
});

const remembered = { hostId: 'H1', hostLabel: 'macbook', workspaceValue: 'W2|H1', workspaceLabel: 'zeta · api', agentValue: 'cfg-codex', agentLabel: 'Codex' };

function prefilled(client) {
  const update = client.called('views.update')[0];
  if (!update) return undefined;
  const block = (id) => update.view.blocks.find((b) => b.block_id === id || b.block_id?.startsWith(`${id}:`));
  return {
    host: block('host').element.initial_option?.value,
    workspace: block('workspace').element.initial_option?.value,
    agent: block('agent').element.initial_option?.value,
  };
}

test('submit stores the choice in the DM metadata', async () => {
  const { app, memory, client } = setup();
  await submit(app, client, submission({}, { agentBlock: 'agent:H1', agent: 'cfg-claude' }));
  const dm = client.called('chat.postMessage')[0];
  assert.equal(dm.metadata.event_type, 'paradev_last_choice');
  assert.equal(dm.metadata.event_payload.workspaceValue, 'W1|H1');
  assert.deepEqual(memory.cache.get('USENDER'), dm.metadata.event_payload);
});

test('shortcut prefills the last choice from the DM, skipping deleted workspaces and unknown hosts', async () => {
  const dmHistory = [{ text: 'sent', metadata: { event_type: 'paradev_last_choice', event_payload: remembered } }];
  let s = setup({ dmHistory });
  await s.app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client: s.client, logger });
  assert.deepEqual(prefilled(s.client), { host: 'H1', workspace: 'W2|H1', agent: 'cfg-codex' });

  const memory = new ChoiceMemory();
  memory.remember('USENDER', { ...remembered, workspaceValue: 'GONE|H1' });
  s = setup({ memory });
  await s.app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client: s.client, logger });
  assert.deepEqual(prefilled(s.client), { host: 'H1', workspace: undefined, agent: 'cfg-codex' });

  const other = new ChoiceMemory();
  other.remember('USENDER', { ...remembered, hostId: 'H-from-another-account' });
  s = setup({ memory: other });
  await s.app.h.shortcut[CALLBACK_ID]({ shortcut, ack: async () => {}, client: s.client, logger });
  assert.equal(prefilled(s.client), undefined);
});
