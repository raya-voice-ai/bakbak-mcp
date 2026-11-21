/**
 * The authorization page: one small, accessible, self-contained HTML form.
 * No scripts, no external resources; styles carry a per-response nonce.
 */

import { DASHBOARD_URL } from '../../tools/errors.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1b18;--muted:#5d5850;--accent:#c2410c;--accent-text:#fff;--border:#d6d2ca;--error:#b42318;--focus:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--card:#211e1b;--text:#f3f1ed;--muted:#b4aca1;--accent:#fb923c;--accent-text:#1d1b18;--border:#433d36;--error:#fda29b;--focus:#93c5fd}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px 28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;margin-bottom:20px}
.brand svg{flex:none}
h1{font-size:22px;line-height:1.3;margin:0 0 12px}
p{margin:0 0 12px;color:var(--muted)}
strong{color:var(--text)}
label{display:block;font-weight:600;margin:20px 0 6px}
input[type=password]{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.hint{font-size:14px;margin-top:6px}
.error{color:var(--error);font-weight:600;margin-top:16px}
.actions{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap}
button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
a{color:inherit}
.fine{font-size:13px;margin-top:24px}
`;

const LOGO = `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect width="28" height="28" rx="7" fill="#c2410c"/><path d="M8 9.5h7.5a3.5 3.5 0 0 1 0 7H8zm0 7h8.5a3.25 3.25 0 0 1 0 6.5H8z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round" transform="translate(0 -2.5)"/></svg>`;

function layout(title: string, nonce: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<div class="brand">${LOGO}<span>Bakbak</span></div>
${body}
</main>
</body>
</html>`;
}

export interface ConsentPageInput {
  nonce: string;
  clientName: string;
  /** Where the user returns after connecting (host only is shown). */
  redirectHost: string;
  /** The sealed pending request. */
  request: string;
  /** Anti-CSRF token; must equal the cookie set with this page and the nonce sealed in `request`. */
  csrfToken: string;
  /** Shown above the form after a failed attempt. */
  error?: string | undefined;
}

export function consentPage(input: ConsentPageInput): string {
  const client = escapeHtml(input.clientName);
  const error = input.error
    ? `<p class="error" id="key-error" role="alert">${escapeHtml(input.error)}</p>`
    : '';
  const describedBy = input.error ? 'key-hint key-error' : 'key-hint';
  return layout(
    `Connect ${input.clientName} to Bakbak`,
    input.nonce,
    `<h1>Connect ${client} to Bakbak</h1>
<p><strong>${client}</strong> wants to create speech with your Bakbak account. It will use your account's credits.</p>
<p>After you connect, you will return to <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(input.request)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}">
<label for="api_key">Bakbak API key</label>
<input id="api_key" name="api_key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required minlength="8" maxlength="512" aria-describedby="${describedBy}"${input.error ? ' aria-invalid="true" autofocus' : ' autofocus'}>
<p class="hint" id="key-hint">Don't have a key? <a href="${DASHBOARD_URL}" target="_blank" rel="noopener noreferrer">Get one from the Bakbak dashboard</a>.</p>
${error}
<div class="actions">
<button type="submit" name="action" value="connect" class="primary">Connect</button>
<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
</div>
</form>
<p class="fine">Your key is checked with Bakbak and then kept only inside encrypted tokens given to ${client}. This server stores no copy. To revoke access, delete the key in the dashboard.</p>`,
  );
}

export function errorPage(nonce: string, title: string, message: string): string {
  return layout(
    title,
    nonce,
    `<h1>${escapeHtml(title)}</h1>
<p role="alert">${escapeHtml(message)}</p>
<p>Return to the app you came from and try connecting again.</p>`,
  );
}
