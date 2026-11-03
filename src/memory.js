export const CHOICE_EVENT = 'paradev_last_choice';
const HISTORY_LIMIT = 20;

/**
 * Remembers each user's last host, workspace and harness.
 *
 * The source of truth is Slack itself: every result DM carries the choice as message
 * metadata, so it survives restarts and redeploys without a database. An in-memory
 * cache avoids re-reading the DM on every shortcut.
 *
 * Choice shape: { hostId, hostLabel, workspaceValue, workspaceLabel, agentValue, agentLabel }
 */
export class ChoiceMemory {
  constructor() {
    this.cache = new Map();
  }

  /** Metadata to attach to the result DM. */
  metadata(choice) {
    return { event_type: CHOICE_EVENT, event_payload: choice };
  }

  remember(userId, choice) {
    this.cache.set(userId, choice);
  }

  /** Drop the cached choice, e.g. after switching ParaDev accounts. Older DMs are still checked. */
  forget(userId) {
    this.cache.delete(userId);
  }

  async recall(client, userId, logger) {
    if (this.cache.has(userId)) return this.cache.get(userId);
    try {
      const { channel } = await client.conversations.open({ users: userId });
      const { messages = [] } = await client.conversations.history({
        channel: channel.id,
        limit: HISTORY_LIMIT,
        include_all_metadata: true,
      });
      const choice = messages.find((m) => m.metadata?.event_type === CHOICE_EVENT)?.metadata.event_payload;
      if (choice?.hostId) {
        this.cache.set(userId, choice);
        return choice;
      }
    } catch (err) {
      // Missing im:history / im:write scopes, or no DM yet: start with the defaults.
      logger?.debug?.(`could not recall last choice for ${userId}: ${err.data?.error || err.message}`);
    }
    return undefined;
  }
}
