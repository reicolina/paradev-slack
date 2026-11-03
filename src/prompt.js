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
