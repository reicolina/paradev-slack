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

  /** Projects (checked-out repos) on a host matching a search on name or repo, by name. Offline hosts throw. */
  async searchProjects(search, hostId) {
    if (!hostId) return [];
    const projects = await this.mcp.callTool('projects_list', { hostId });
    const q = (search || '').toLowerCase();
    return projects
      .filter((p) => !q || [p.name, p.repoName, p.repoOwner].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Agents configured on a host, in the host's own display order. */
  async agents(hostId) {
    const list = await this.mcp.callTool('agents_list', { hostId });
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * Create a workspace on a host and start the agent in it once it is ready.
   * With a project it gets its own worktree on `branch`, forked from the project's default branch;
   * without one it is a project-less session.
   */
  async createWorkspace({ hostId, projectId, name, branch, agent, prompt }) {
    return this.mcp.callTool('workspaces_create', {
      hostId,
      name,
      ...(projectId && { projectId, branch }),
      agents: [{ agent, prompt }],
    });
  }
}
