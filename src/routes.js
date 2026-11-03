export const CALLBACK_PATH = '/oauth/callback';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function page(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5fb;color:#1f1b2e}
main{max-width:28rem;padding:2rem;margin:1rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002}h1{font-size:1.25rem;margin:0 0 .5rem}
@media (prefers-color-scheme:dark){body{background:#15131d;color:#eee}main{background:#221f2e}}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}

function send(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  res.end(html);
}

/**
 * HTTP routes served next to Slack: the ParaDev OAuth callback and a health check.
 * @param {{ accounts: import('./accounts.js').OAuthAccounts, onConnected: (r: object) => Promise<void>, logger?: Console }} deps
 */
export function oauthRoutes({ accounts, onConnected, logger = console }) {
  return [
    {
      path: '/healthz',
      method: ['GET'],
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      },
    },
    {
      path: CALLBACK_PATH,
      method: ['GET'],
      handler: async (req, res) => {
        const q = new URL(req.url, 'http://localhost').searchParams;
        if (q.get('error')) {
          return send(res, 400, page('Not connected', `ParaDev did not connect: ${q.get('error_description') || q.get('error')}. You can close this tab and try again from Slack.`));
        }
        if (!q.get('code') || !q.get('state')) {
          return send(res, 400, page('Not connected', 'This link is missing its sign-in details. Start again from Slack.'));
        }
        try {
          const result = await accounts.complete({ code: q.get('code'), state: q.get('state') });
          await onConnected(result).catch((err) => logger.warn?.(`post-connect step failed: ${err.message}`));
          send(res, 200, page('Connected to ParaDev', 'You can close this tab and go back to Slack.'));
        } catch (err) {
          logger.warn?.(`OAuth callback failed: ${err.message}`);
          const msg = err.code === 'invalid_state' ? err.message : 'Something went wrong connecting your account. Close this tab and try again from Slack.';
          send(res, 400, page('Not connected', msg));
        }
      },
    },
  ];
}
