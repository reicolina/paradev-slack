import crypto from 'node:crypto';

export const SCOPES = 'openid profile email offline_access';
const CLIENT_KEY = 'oauth:client';

export class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

const b64url = (buf) => buf.toString('base64url');

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Claims of a JWT access token, unverified: only used to show the user which org they linked. */
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * OAuth 2.1 public client for ParaDev (authorization code + PKCE, refresh tokens).
 * Registers itself once through RFC 7591 dynamic client registration and keeps the client id in the store.
 */
export class ParaDevOAuth {
  /**
   * @param {object} opts
   * @param {string} opts.issuer e.g. https://api.superset.sh
   * @param {string} opts.redirectUri e.g. https://your-app.fly.dev/oauth/callback
   * @param {{get:Function,set:Function}} opts.store
   * @param {string} [opts.resource] RFC 8707 resource the tokens are for, e.g. https://api.superset.sh/mcp.
   *   ParaDev only issues a JWT the MCP endpoint accepts when this is sent; without it the token is opaque.
   * @param {string} [opts.clientName]
   * @param {typeof fetch} [opts.fetch]
   */
  constructor({ issuer, redirectUri, resource, store, clientName = 'ParaDev for Slack', fetch: fetchImpl = globalThis.fetch }) {
    this.issuer = issuer.replace(/\/$/, '');
    this.redirectUri = redirectUri;
    this.resource = resource;
    this.store = store;
    this.clientName = clientName;
    this.fetch = fetchImpl;
    this.meta = null;
    this.client = null;
  }

  async metadata() {
    if (this.meta) return this.meta;
    const res = await this.fetch(`${this.issuer}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new OAuthError(`OAuth discovery failed: ${res.status}`);
    this.meta = await res.json();
    return this.meta;
  }

  /** The registered client, registering on first use or when the redirect URI changed. */
  async clientId() {
    if (this.client?.redirectUri === this.redirectUri) return this.client.clientId;
    const saved = await this.store.get(CLIENT_KEY);
    if (saved?.redirectUri === this.redirectUri && saved.issuer === this.issuer) {
      this.client = saved;
      return saved.clientId;
    }
    const { registration_endpoint: url } = await this.metadata();
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPES,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.client_id) throw new OAuthError(`client registration failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    this.client = { clientId: body.client_id, redirectUri: this.redirectUri, issuer: this.issuer };
    await this.store.set(CLIENT_KEY, this.client);
    return this.client.clientId;
  }

  async authorizeUrl({ state, challenge }) {
    const [{ authorization_endpoint: url }, clientId] = await Promise.all([this.metadata(), this.clientId()]);
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
      ...(this.resource && { resource: this.resource }),
    });
    return `${url}?${q}`;
  }

  async tokenRequest(params) {
    const [{ token_endpoint: url }, clientId] = await Promise.all([this.metadata(), this.clientId()]);
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ ...params, client_id: clientId, ...(this.resource && { resource: this.resource }) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new OAuthError(body.error_description || body.error || `token request failed: ${res.status}`, body.error);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
  }

  exchangeCode({ code, verifier }) {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier });
  }

  refresh(refreshToken) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async userinfo(accessToken) {
    const { userinfo_endpoint: url } = await this.metadata();
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    return res.ok ? res.json() : {};
  }

  /** Best effort: the local link is removed whether or not ParaDev confirms. */
  async revoke(token) {
    const [{ revocation_endpoint: url }, clientId] = await Promise.all([this.metadata(), this.clientId()]);
    if (!url) return false;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
    return res.ok;
  }
}
