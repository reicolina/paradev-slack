import crypto from 'node:crypto';
import { McpClient, ParaDevError } from './mcp.js';
import { OAuthError, jwtClaims, pkcePair } from './oauth.js';
import { ParaDev } from './paradev.js';

const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_EARLY_MS = 60 * 1000;

const userKey = (teamId, userId) => `user:${teamId}:${userId}`;

/**
 * Personal mode: one ParaDev API key from the environment, shared by every allowed Slack user.
 */
export class ApiKeyAccounts {
  mode = 'api-key';

  constructor({ mcpUrl, apiKey, organizationId, fetch }) {
    const headers = organizationId ? { 'x-superset-organization-id': organizationId } : {};
    this.paradev = new ParaDev(new McpClient({ url: mcpUrl, getToken: async () => apiKey, headers, fetch }));
  }

  async forUser() {
    return this.paradev;
  }

  async status() {
    return { connected: true, shared: true };
  }
}

/**
 * Each Slack user links their own ParaDev account with OAuth and every call runs as them.
 * Tokens are stored encrypted, refreshed before they expire, and dropped when ParaDev
 * refuses the refresh token (the user is asked to connect again).
 */
export class OAuthAccounts {
  mode = 'oauth';

  /**
   * @param {object} opts
   * @param {import('./oauth.js').ParaDevOAuth} opts.oauth
   * @param {{get:Function,set:Function,delete:Function}} opts.store encrypted store
   * @param {string} opts.mcpUrl
   * @param {typeof fetch} [opts.fetch]
   */
  constructor({ oauth, store, mcpUrl, fetch }) {
    this.oauth = oauth;
    this.store = store;
    this.mcpUrl = mcpUrl;
    this.fetch = fetch;
    this.pending = new Map(); // state -> { teamId, userId, verifier, createdAt, context }
    this.clients = new Map(); // userKey -> ParaDev (keeps each user's host cache)
    this.refreshing = new Map(); // userKey -> in-flight refresh
  }

  /** URL that starts the ParaDev sign-in for this Slack user. `context` comes back on completion. */
  async connectUrl({ teamId, userId, context = {} }) {
    this.sweep();
    const state = crypto.randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { teamId, userId, verifier, createdAt: Date.now(), context });
    return { url: await this.oauth.authorizeUrl({ state, challenge }), state };
  }

  /** Attach more context to a pending sign-in, e.g. the modal opened after the URL was made. */
  addContext(state, extra) {
    const p = this.pending.get(state);
    if (p) Object.assign(p.context, extra);
  }

  sweep() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [s, p] of this.pending) if (p.createdAt < cutoff) this.pending.delete(s);
  }

  /** Finish the OAuth callback. Returns who connected and the context given to connectUrl. */
  async complete({ code, state }) {
    this.sweep();
    const p = this.pending.get(state);
    if (!p) throw new OAuthError('This sign-in link expired or was already used. Start again from Slack.', 'invalid_state');
    this.pending.delete(state);

    const tokens = await this.oauth.exchangeCode({ code, verifier: p.verifier });
    const info = await this.oauth.userinfo(tokens.accessToken).catch(() => ({}));
    const claims = jwtClaims(tokens.accessToken);
    const account = {
      ...tokens,
      email: info.email || claims.email,
      name: info.name || claims.name,
      paradevUserId: claims.sub || info.sub,
      organizationId: claims.organizationId,
      connectedAt: Date.now(),
    };
    const key = userKey(p.teamId, p.userId);
    await this.store.set(key, account);
    this.clients.delete(key);
    return { teamId: p.teamId, userId: p.userId, context: p.context, account };
  }

  async status(teamId, userId) {
    const a = await this.store.get(userKey(teamId, userId));
    return a ? { connected: true, email: a.email, name: a.name, organizationId: a.organizationId } : { connected: false };
  }

  /** A ParaDev client acting as this Slack user, or null when they have not connected. */
  async forUser(teamId, userId) {
    const key = userKey(teamId, userId);
    if (!(await this.store.get(key))) {
      this.clients.delete(key);
      return null;
    }
    if (!this.clients.has(key)) {
      const mcp = new McpClient({ url: this.mcpUrl, getToken: () => this.accessToken(key), fetch: this.fetch });
      // One retry on 401 with a forced refresh: the token may have been revoked or rotated early.
      const callTool = mcp.callTool.bind(mcp);
      mcp.callTool = async (name, args) => {
        try {
          return await callTool(name, args);
        } catch (err) {
          // Only a 401 from ParaDev itself; a failed refresh already explains what to do.
          if (!err.unauthorized || !err.status) throw err;
          await this.accessToken(key, { force: true });
          return callTool(name, args);
        }
      };
      this.clients.set(key, new ParaDev(mcp));
    }
    return this.clients.get(key);
  }

  async accessToken(key, { force = false } = {}) {
    const a = await this.store.get(key);
    if (!a) throw new ParaDevError('Your ParaDev account is not connected.', { unauthorized: true });
    if (!force && a.expiresAt - REFRESH_EARLY_MS > Date.now()) return a.accessToken;
    if (!this.refreshing.has(key)) {
      this.refreshing.set(
        key,
        this.refreshAccount(key, a).finally(() => this.refreshing.delete(key)),
      );
    }
    return this.refreshing.get(key);
  }

  async refreshAccount(key, a) {
    if (!a.refreshToken) {
      await this.forget(key);
      throw new ParaDevError('Your ParaDev sign-in expired. Connect again.', { unauthorized: true });
    }
    try {
      const t = await this.oauth.refresh(a.refreshToken);
      // Keep the old refresh token if the server does not rotate it.
      await this.store.set(key, { ...a, ...t, refreshToken: t.refreshToken || a.refreshToken });
      return t.accessToken;
    } catch (err) {
      if (err.code === 'invalid_grant' || err.code === 'invalid_client') {
        await this.forget(key);
        throw new ParaDevError('Your ParaDev sign-in expired or was revoked. Connect again.', { unauthorized: true });
      }
      throw err;
    }
  }

  async forget(key) {
    this.clients.delete(key);
    await this.store.delete(key);
  }

  /** Revoke at ParaDev (best effort) and delete the stored tokens. */
  async disconnect(teamId, userId) {
    const key = userKey(teamId, userId);
    const a = await this.store.get(key);
    if (a?.refreshToken) await this.oauth.revoke(a.refreshToken).catch(() => false);
    await this.forget(key);
  }
}
