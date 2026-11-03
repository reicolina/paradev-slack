import Superset from '@superset_sh/sdk';

const HOST_CACHE_MS = 30_000;

/**
 * Thin wrapper over the ParaDev SDK with the few calls this app needs.
 * Takes an SDK client so tests can pass a fake.
 */
export class ParaDev {
  constructor(sdk) {
    this.sdk = sdk;
    this.hostCache = { at: 0, hosts: [] };
  }

  static fromEnv(env = process.env) {
    return new ParaDev(
      new Superset({
        apiKey: env.PARADEV_API_KEY,
        organizationId: env.PARADEV_ORGANIZATION_ID,
        ...(env.PARADEV_BASE_URL ? { baseURL: env.PARADEV_BASE_URL } : {}),
        ...(env.PARADEV_RELAY_URL ? { relayURL: env.PARADEV_RELAY_URL } : {}),
      }),
    );
  }

  async hosts() {
    if (Date.now() - this.hostCache.at < HOST_CACHE_MS) return this.hostCache.hosts;
    const hosts = await this.sdk.hosts.list();
    this.hostCache = { at: Date.now(), hosts };
    return hosts;
  }

  async hostById(hostId) {
    return (await this.hosts()).find((h) => h.id === hostId);
  }

  /** Workspaces matching a search, online hosts first, then by name. */
  async searchWorkspaces(search) {
    const [workspaces, hosts] = await Promise.all([
      this.sdk.workspaces.list(search ? { search } : {}),
      this.hosts(),
    ]);
    const byId = new Map(hosts.map((h) => [h.id, h]));
    return workspaces
      .map((ws) => ({ ws, host: byId.get(ws.hostId) }))
      .sort((a, b) => Number(Boolean(b.host?.online)) - Number(Boolean(a.host?.online)) || a.ws.name.localeCompare(b.ws.name));
  }

  /** Agents configured on a host, in the host's own display order. */
  async agents(hostId) {
    const list = await this.sdk.agents.list({ hostId });
    return [...list].sort((a, b) => a.order - b.order);
  }

  async launch({ workspaceId, hostId, agent, prompt }) {
    return this.sdk.agents.create({ workspaceId, agent, prompt }, { hostId });
  }
}
