const HOST_CACHE_MS = 30_000;

/**
 * The few ParaDev calls this app needs, made through MCP tools as one ParaDev user.
 * @param {{ callTool: (name: string, args?: object) => Promise<any> }} mcp
 */
export class ParaDev {
  constructor(mcp) {
    this.mcp = mcp;
    this.hostCache = { at: 0, hosts: [] };
  }

  async hosts() {
    if (Date.now() - this.hostCache.at < HOST_CACHE_MS) return this.hostCache.hosts;
    const list = await this.mcp.callTool('hosts_list');
    const hosts = list.map((h) => ({ id: h.id, name: h.name, online: h.online === true || h.online === 'yes' }));
    this.hostCache = { at: Date.now(), hosts };
    return hosts;
  }

  async hostById(hostId) {
    return (await this.hosts()).find((h) => h.id === hostId);
  }

  /** Hosts matching a search, online first, then by name. */
  async searchHosts(search) {
    const q = (search || '').toLowerCase();
    return (await this.hosts())
      .filter((h) => !q || h.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  /**
   * Active workspaces on a host matching a search on name, branch or project, most recent first.
   * The list comes from the host itself, so an offline host throws.
   */
  async searchWorkspaces(search, hostId) {
    if (!hostId) return [];
    const [workspaces, host] = await Promise.all([this.mcp.callTool('workspaces_list', { hostId }), this.hostById(hostId)]);
    const q = (search || '').toLowerCase();
    return workspaces
      .filter((ws) => !ws.archivedAt && ws.worktreeExists !== false)
      .filter((ws) => !q || [ws.name, ws.branch, ws.projectName].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.name.localeCompare(b.name))
      .map((ws) => ({ ws, host }));
  }

  /** Agents configured on a host, in the host's own display order. */
  async agents(hostId) {
    const list = await this.mcp.callTool('agents_list', { hostId });
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async launch({ workspaceId, hostId, agent, prompt }) {
    return this.mcp.callTool('agents_create', { hostId, workspaceId, agent, prompt });
  }
}
