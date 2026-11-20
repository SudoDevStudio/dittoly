/** The few pages the app's server writes itself: the answer to a signed approve or reject link. */

export interface PageLook { name: string; primary: string; onPrimary: string; font: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const shell = (look: PageLook, title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f8fa; --text: #15181d; --muted: #555d68; --primary: ${look.primary}; --on-primary: ${look.onPrimary}; --border: #d5d9e0; }
@media (prefers-color-scheme: dark) { :root { --bg: #111418; --text: #e8eaee; --muted: #a3aab5; --border: #2c323b; } }
body { margin: 0; font: 16px/1.5 ${look.font}; background: var(--bg); color: var(--text); }
main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
code { overflow-wrap: anywhere; } a { color: inherit; }
button { font: inherit; font-weight: 600; min-height: 44px; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--text); }
button.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.muted { color: var(--muted); }
</style></head><body><main>${body}</main></body></html>`;

/** Confirm with a button (link scanners only open links), or the outcome. */
export function linkPage(look: PageLook, q: Record<string, string | undefined> | null, done = false): string {
  if (!q) return shell(look, 'Link not valid', '<h1>This link is not valid</h1><p class="muted">It may have expired, or the step was already decided.</p>');
  const verb = q.decision === 'approved' ? 'Approve' : 'Reject';
  if (done) return shell(look, 'Done', `<h1>${q.decision === 'approved' ? 'Approved' : 'Rejected'}</h1><p class="muted">The run continues on its own. You can close this page.</p>`);
  const hidden = ['run', 'step', 'decision', 'exp', 'sig'].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`).join('');
  return shell(look, `${verb}?`, `<h1>${verb} this step?</h1>
<p class="muted">Run <code>${esc(q.run ?? '')}</code>, step <code>${esc(q.step ?? '')}</code> in ${esc(look.name)}.</p>
<form method="post" action="/approve">${hidden}<button class="primary" type="submit">${verb}</button></form>`);
}
