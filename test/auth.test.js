import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OAuthAccounts } from '../src/accounts.js';
import { McpClient, parseRpcBody } from '../src/mcp.js';
import { ParaDevOAuth } from '../src/oauth.js';
import { oauthRoutes } from '../src/routes.js';
import { Cipher, FileStore, MemoryStore } from '../src/store.js';
import { fakeFetch, logger } from './helpers.js';

const ISSUER = 'https://paradev.test';
const MCP = `${ISSUER}/mcp`;
const META = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  revocation_endpoint: `${ISSUER}/revoke`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const key = crypto.randomBytes(32).toString('base64');

/** A fake ParaDev: OAuth server plus an MCP endpoint that records which token called it. */
function paradevServer({ refreshError } = {}) {
  let n = 0;
  const seen = [];
  const issued = { codes: new Map() };
  const fetch = fakeFetch({
    [`${ISSUER}/.well-known/oauth-authorization-server`]: () => ({ json: META }),
    [`${ISSUER}/register`]: () => ({ status: 201, json: { client_id: 'client-1' } }),
    [`${ISSUER}/token`]: (_u, init) => {
      const b = Object.fromEntries(init.body);
      if (b.grant_type === 'authorization_code') {
        const { challenge, user } = issued.codes.get(b.code);
        const ok = crypto.createHash('sha256').update(b.code_verifier).digest('base64url') === challenge;
        if (!ok) return { status: 400, json: { error: 'invalid_grant' } };
        return { json: { access_token: jwt({ sub: user, organizationId: `org-${user}` }), refresh_token: `r-${user}-0`, expires_in: 3600 } };
      }
      if (refreshError) return { status: 400, json: { error: refreshError } };
      n += 1;
      return { json: { access_token: `fresh-${n}`, refresh_token: `r-rotated-${n}`, expires_in: 3600 } };
    },
    [`${ISSUER}/userinfo`]: () => ({ json: { email: 'rei@example.com', name: 'Rei' } }),
    [`${ISSUER}/revoke`]: () => ({ json: {} }),
    [MCP]: (_u, init) => {
      const token = init.headers.authorization.replace('Bearer ', '');
      seen.push(token);
      if (token === 'revoked') return { status: 401, json: { error: { code: 'UNAUTHORIZED' } } };
      const { params } = JSON.parse(init.body);
      return {
        text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { result: [{ id: 'H1', name: `host-of-${token.slice(0, 12)}`, online: true }] }, tool: params.name } })}\n\n`,
        headers: { 'content-type': 'text/event-stream' },
      };
    },
  });
  // The "browser" step: the user approves and ParaDev redirects back with a code.
  const approve = (authorizeUrl, user) => {
    const u = new URL(authorizeUrl);
    const code = `code-${user}`;
    issued.codes.set(code, { challenge: u.searchParams.get('code_challenge'), user });
    return { code, state: u.searchParams.get('state') };
  };
  return { fetch, seen, approve };
}

function setup(opts) {
  const server = paradevServer(opts);
  const store = opts?.store || new MemoryStore();
  const oauth = new ParaDevOAuth({ issuer: ISSUER, redirectUri: 'https://app.test/oauth/callback', store, fetch: server.fetch });
  const accounts = new OAuthAccounts({ oauth, store, mcpUrl: MCP, fetch: server.fetch });
  return { server, store, oauth, accounts };
}

test('MCP responses: event stream and tool errors', async () => {
  assert.deepEqual(parseRpcBody('event: message\ndata: {"a":1}\n\n'), { a: 1 });
  const fetch = fakeFetch({
    [MCP]: () => ({ json: { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'host H2 returned 503 for workspace.list: {"error":{"json":{"message":"Host is not online"}}}' }] } } }),
  });
  const mcp = new McpClient({ url: MCP, getToken: async () => 't', fetch });
  await assert.rejects(mcp.callTool('workspaces_list', { hostId: 'H2' }), /^ParaDevError: Host is not online$/);
});

test('client registers once and is reused across restarts', async () => {
  const store = new MemoryStore();
  const a = setup({ store });
  await a.oauth.clientId();
  const b = setup({ store });
  await b.oauth.clientId();
  assert.equal(a.server.fetch.requests.filter((r) => r.url.endsWith('/register')).length, 1);
  assert.equal(b.server.fetch.requests.filter((r) => r.url.endsWith('/register')).length, 0);
  const reg = JSON.parse(a.server.fetch.requests.find((r) => r.url.endsWith('/register')).body);
  assert.deepEqual(reg.redirect_uris, ['https://app.test/oauth/callback']);
  assert.equal(reg.token_endpoint_auth_method, 'none');
});

test('connect flow: PKCE sign-in links the Slack user, and calls run with their token', async () => {
  const { server, accounts } = setup();
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1', context: { viewId: 'V1' } });
  const q = new URL(url).searchParams;
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('scope'), 'openid profile email offline_access');

  const result = await accounts.complete(server.approve(url, 'rei'));
  assert.equal(result.userId, 'U1');
  assert.equal(result.context.viewId, 'V1');
  assert.equal(result.account.email, 'rei@example.com');
  assert.equal(result.account.organizationId, 'org-rei');
  assert.deepEqual(await accounts.status('T1', 'U1'), { connected: true, email: 'rei@example.com', name: 'Rei', organizationId: 'org-rei' });

  const paradev = await accounts.forUser('T1', 'U1');
  await paradev.hosts();
  assert.ok(server.seen.at(-1).startsWith('h.'), 'MCP called with the user’s own access token');
});

test('state is single-use and tied to the Slack user who started it', async () => {
  const { server, accounts } = setup();
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  const approved = server.approve(url, 'rei');
  await accounts.complete(approved);
  await assert.rejects(accounts.complete(approved), /expired or was already used/);
  await assert.rejects(accounts.complete({ code: 'x', state: 'forged' }), /expired or was already used/);
  assert.equal(await accounts.forUser('T1', 'U2'), null, 'another Slack user is not linked');
  assert.equal(await accounts.forUser('T2', 'U1'), null, 'same user id in another Slack workspace is not linked');
});

test('two users get two accounts', async () => {
  const { server, accounts } = setup();
  for (const [u, who] of [['U1', 'rei'], ['U2', 'ana']]) {
    const { url } = await accounts.connectUrl({ teamId: 'T1', userId: u });
    await accounts.complete(server.approve(url, who));
  }
  assert.equal((await accounts.status('T1', 'U1')).organizationId, 'org-rei');
  assert.equal((await accounts.status('T1', 'U2')).organizationId, 'org-ana');
  await (await accounts.forUser('T1', 'U2')).hosts();
  assert.equal(JSON.parse(Buffer.from(server.seen.at(-1).split('.')[1], 'base64url')).sub, 'ana');
});

test('expired access token is refreshed once (concurrent calls share it) and rotation is saved', async () => {
  const { server, store, accounts } = setup();
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  await accounts.complete(server.approve(url, 'rei'));
  const k = 'user:T1:U1';
  await store.set(k, { ...(await store.get(k)), expiresAt: Date.now() - 1 });

  const [a, b] = await Promise.all([accounts.accessToken(k), accounts.accessToken(k)]);
  assert.equal(a, 'fresh-1');
  assert.equal(b, 'fresh-1');
  assert.equal(server.fetch.requests.filter((r) => r.url.endsWith('/token') && r.body.grant_type === 'refresh_token').length, 1);
  assert.equal((await store.get(k)).refreshToken, 'r-rotated-1');
});

test('a 401 forces one refresh and retries; a refused refresh token unlinks the user', async () => {
  const ok = setup();
  let { url } = await ok.accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  await ok.accounts.complete(ok.server.approve(url, 'rei'));
  await ok.store.set('user:T1:U1', { ...(await ok.store.get('user:T1:U1')), accessToken: 'revoked' });
  const hosts = await (await ok.accounts.forUser('T1', 'U1')).hosts();
  assert.equal(hosts[0].name, 'host-of-fresh-1');

  const bad = setup({ refreshError: 'invalid_grant' });
  ({ url } = await bad.accounts.connectUrl({ teamId: 'T1', userId: 'U1' }));
  await bad.accounts.complete(bad.server.approve(url, 'rei'));
  await bad.store.set('user:T1:U1', { ...(await bad.store.get('user:T1:U1')), expiresAt: 0 });
  await assert.rejects((await bad.accounts.forUser('T1', 'U1')).hosts(), (err) => err.unauthorized && /Connect again/.test(err.message));
  assert.equal(await bad.accounts.forUser('T1', 'U1'), null);
});

test('disconnect revokes the refresh token and deletes the link', async () => {
  const { server, accounts } = setup();
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  await accounts.complete(server.approve(url, 'rei'));
  await accounts.disconnect('T1', 'U1');
  const revoke = server.fetch.requests.find((r) => r.url.endsWith('/revoke'));
  assert.equal(revoke.body.token, 'r-rei-0');
  assert.equal(await accounts.forUser('T1', 'U1'), null);
});

test('tokens are encrypted at rest; a wrong key cannot read them', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pds-')), 'store.json');
  const store = new FileStore({ file, cipher: new Cipher(key) });
  const { server, accounts } = setup({ store });
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  await accounts.complete(server.approve(url, 'rei'));

  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /r-rei-0|rei@example\.com/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const reopened = new FileStore({ file, cipher: new Cipher(key) });
  assert.equal((await reopened.get('user:T1:U1')).refreshToken, 'r-rei-0');
  const wrong = new FileStore({ file, cipher: new Cipher(crypto.randomBytes(32).toString('base64')) });
  await assert.rejects(wrong.get('user:T1:U1'));
  assert.throws(() => new Cipher('short'), /32 bytes/);
});

test('callback route: success page, then a reused link is refused', async () => {
  const { server, accounts } = setup();
  const connected = [];
  const route = oauthRoutes({ accounts, onConnected: async (r) => connected.push(r.userId), logger }).find((r) => r.path === '/oauth/callback');
  const call = async (query) => {
    const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
    await route.handler({ url: `/oauth/callback?${new URLSearchParams(query)}` }, res);
    return res;
  };
  const { url } = await accounts.connectUrl({ teamId: 'T1', userId: 'U1' });
  const approved = server.approve(url, 'rei');
  let res = await call(approved);
  assert.equal(res.status, 200);
  assert.match(res.body, /Connected to ParaDev/);
  assert.deepEqual(connected, ['U1']);
  res = await call(approved);
  assert.equal(res.status, 400);
  res = await call({ error: 'access_denied', state: 'x' });
  assert.match(res.body, /access_denied/);
  res = await call({ code: '<script>', state: '"x' });
  assert.doesNotMatch(res.body, /<script>/);
});
