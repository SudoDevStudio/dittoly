import { CORE_JS } from '../export/frontend/core.js';
import { RENDER_JS } from '../export/frontend/render.js';
import { APP_CSS } from '../export/frontend/styles.js';

/**
 * An app opened inside Dittoly is drawn by the same renderer as an exported app's built-in UI (core.js and
 * render.js), so what the team uses is what an export ships. Dittoly adds a thin bar above it: back to the
 * portal, a preview notice, and anything that stops the app's Flows from running for the team.
 */

const MAIN_JS = String.raw`import { mount } from './render.js';
const root = document.getElementById('root');
const api = root.dataset.api;
const base = root.dataset.base;
const bar = document.getElementById('dty-host');
const note = (text, cls) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; bar.append(p); };
const res = await fetch(api + '/api/app', { credentials: 'same-origin', headers: { accept: 'application/json' } });
if (res.status === 401) {
  root.textContent = '';
  const p = document.createElement('p'); p.className = 'dty-main';
  const a = document.createElement('a'); a.href = '/'; a.textContent = 'Sign in to Dittoly';
  p.append(a, ' to open this app.');
  root.append(p);
} else {
  const info = await res.json().catch(() => ({}));
  if (!res.ok) note('This app cannot be opened: ' + (info.detail ?? info.error ?? res.status), 'dty-host-error');
  else {
    if (info.preview) note('Preview of version ' + info.version + ': not approved yet. Runs started here are real and use the team’s keys.', 'dty-host-note');
    for (const p of info.problems ?? []) note(p, 'dty-host-error');
  }
  if (res.ok) mount(root, { baseUrl: api, basePath: base, session: true, headers: { 'x-dittoly-request': '1' } });
}
`;

const HOST_CSS = `.dty-host { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; padding: 6px 16px; font: 14px/1.4 var(--font, system-ui, sans-serif);
  background: var(--surface, #fff); color: var(--text, #15181d); border-bottom: 1px solid var(--border, #d5d9e0); }
.dty-host a { color: inherit; }
.dty-host p { margin: 0; }
.dty-host-note { color: var(--muted, #555d68); }
.dty-host-error { color: var(--danger, #b42318); font-weight: 600; }
`;

/** Served at /app-ui/<file>. */
export const APP_UI_FILES: Record<string, { type: string; body: string }> = {
  'core.js': { type: 'text/javascript; charset=utf-8', body: CORE_JS },
  'render.js': { type: 'text/javascript; charset=utf-8', body: RENDER_JS },
  'main.js': { type: 'text/javascript; charset=utf-8', body: MAIN_JS },
  'app.css': { type: 'text/css; charset=utf-8', body: APP_CSS },
  'host.css': { type: 'text/css; charset=utf-8', body: HOST_CSS },
};

/** The page for /a/<app>/... (live) or /a/<app>/v/<version>/... (a preview). Ids are checked uuids. */
export function appShell(appId: string, versionId: string | null): string {
  const ref = versionId ?? 'live';
  const api = `/api/apps/${appId}/v/${ref}`;
  const base = versionId ? `/a/${appId}/v/${versionId}` : `/a/${appId}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>App</title>
<link rel="stylesheet" href="${api}/theme.css">
<link rel="stylesheet" href="/app-ui/app.css">
<link rel="stylesheet" href="/app-ui/host.css">
<script type="module" src="/app-ui/main.js"></script>
</head>
<body>
<div class="dty-host" id="dty-host"><a href="/team-apps/${appId}">← Dittoly</a></div>
<div id="root" data-api="${api}" data-base="${base}"><p class="dty-main">Loading…</p></div>
<noscript>This app needs JavaScript.</noscript>
</body>
</html>`;
}
