/**
 * Minimal client for ParaDev's MCP endpoint (stateless streamable HTTP).
 *
 * The app calls MCP tools instead of the tRPC API because ParaDev documents OAuth access
 * tokens for the MCP endpoint; it also accepts API keys, so both auth modes share this client.
 */

export class ParaDevError extends Error {
  constructor(message, { status, unauthorized = false } = {}) {
    super(message);
    this.name = 'ParaDevError';
    this.status = status;
    this.unauthorized = unauthorized;
  }
}

/** The JSON-RPC message from a JSON or text/event-stream response body. */
export function parseRpcBody(text) {
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.length ? data[data.length - 1] : text);
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url e.g. https://api.superset.sh/mcp
   * @param {() => Promise<string>} opts.getToken bearer token for each call
   * @param {Record<string,string>} [opts.headers] extra headers
   * @param {typeof fetch} [opts.fetch]
   */
  constructor({ url, getToken, headers = {}, fetch: fetchImpl = globalThis.fetch }) {
    this.url = url;
    this.getToken = getToken;
    this.headers = headers;
    this.fetch = fetchImpl;
    this.nextId = 1;
  }

  async callTool(name, args = {}) {
    const token = await this.getToken();
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ParaDevError('ParaDev rejected the credentials', { status: res.status, unauthorized: true });
    }
    const text = await res.text();
    if (!res.ok) throw new ParaDevError(`ParaDev returned ${res.status}: ${text.slice(0, 200)}`, { status: res.status });

    const msg = parseRpcBody(text);
    if (msg.error) throw new ParaDevError(msg.error.message || 'ParaDev error');
    const result = msg.result || {};
    if (result.isError) {
      throw new ParaDevError(cleanToolError(result.content?.[0]?.text || `${name} failed`));
    }
    if (result.structuredContent && 'result' in result.structuredContent) return result.structuredContent.result;
    const textOut = result.content?.find((c) => c.type === 'text')?.text;
    try {
      return textOut ? JSON.parse(textOut) : result;
    } catch {
      return textOut;
    }
  }
}

/** "host X returned 503 for workspace.list: {...Host is not online...}" -> "Host is not online" */
export function cleanToolError(text) {
  const m = text.match(/"message":"([^"]+)"/);
  return m ? m[1] : text.slice(0, 300);
}
