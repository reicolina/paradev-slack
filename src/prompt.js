const MAX_MESSAGE_CHARS = 2000;

/**
 * Build a Slack permalink without an API call.
 * Used as a fallback when chat.getPermalink is unavailable (e.g. the bot is not in the channel).
 */
export function buildPermalink({ teamDomain, channelId, ts, threadTs }) {
  const base = `https://${teamDomain}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  if (threadTs && threadTs !== ts) {
    return `${base}?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return base;
}

export function truncate(text, max = MAX_MESSAGE_CHARS) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n[... truncated, open the link for the full message]` : text;
}

function quote(text) {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The prompt handed to the agent in the chosen ParaDev workspace.
 */
export function buildPrompt({ permalink, authorName, channelName, messageText, isThreadReply, context, senderName }) {
  const lines = [
    `A Slack message was sent to you from Slack by ${senderName}.`,
    '',
    `Slack message: ${permalink}`,
  ];
  const where = channelName ? ` in #${channelName}` : '';
  if (authorName) lines.push(`Posted by: ${authorName}${where}${isThreadReply ? ' (thread reply)' : ''}`);

  const body = truncate(messageText);
  if (body) {
    lines.push('', 'Message text:', quote(body));
  }

  const note = context?.trim();
  if (note) {
    lines.push('', `Context from ${senderName}:`, note);
  }

  lines.push(
    '',
    'If you have Slack access, open the link above to read the full message and its thread before you start.',
  );
  return lines.join('\n');
}

/** Slack mrkdwn to plain words: `<url|label>` → label, `<@U1>` and `:emoji:` dropped. */
function plainWords(text) {
  return (text || '')
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<[^>]*>/g, '')
    .replace(/:[a-z0-9_+-]+:/gi, '')
    .replace(/[*_~`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name for the new workspace: the first line of the message, else of the sender’s note. */
export function workspaceName({ context, messageText }) {
  const firstLine = (t) => plainWords((t || '').split('\n').find((l) => plainWords(l)) || '');
  const name = firstLine(messageText) || firstLine(context) || 'Slack message';
  return name.length > 60 ? `${name.slice(0, 59).trimEnd()}…` : name;
}

/** A fresh branch for the workspace's worktree, e.g. `slack/duplicate-salesforce-location-k3f9`. */
export function branchName(name, random = () => Math.random().toString(36).slice(2, 6)) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `slack/${slug || 'message'}-${random()}`;
}
