/**
 * The component styles every exported frontend shares. Colours, font and corners come from
 * the theme's custom properties (theme.css), so a brand change needs no other CSS. The layout
 * follows the plan: <div class="dty-app" data-nav="top|sidebar-left|sidebar-right|none" data-width="narrow|wide|full">.
 */
export const APP_CSS = String.raw`*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 16px; line-height: 1.5; }
a { color: var(--link); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.dty-app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
.dty-app[data-nav="sidebar-left"] { grid-template-columns: 240px 1fr; grid-template-rows: 1fr; }
.dty-app[data-nav="sidebar-right"] { grid-template-columns: 1fr 240px; grid-template-rows: 1fr; }
.dty-app[data-nav="sidebar-right"] .dty-nav { order: 2; border-left: 1px solid var(--border); border-right: 0; }
.dty-nav { display: flex; align-items: center; gap: 4px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.dty-app[data-nav^="sidebar"] .dty-nav { flex-direction: column; align-items: stretch; border-bottom: 0; border-right: 1px solid var(--border); padding: 20px 12px; }
.dty-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; margin-right: 16px; color: var(--text); text-decoration: none; padding: 6px 8px; }
.dty-app[data-nav^="sidebar"] .dty-brand { margin: 0 0 16px; }
.dty-brand img { width: 32px; height: 32px; object-fit: contain; border-radius: var(--radius); }
.dty-nav a.dty-link { color: var(--muted); text-decoration: none; padding: 8px 12px; border-radius: var(--radius); }
.dty-nav a.dty-link:hover { background: var(--surface2); color: var(--text); }
.dty-nav a.dty-link[aria-current="page"] { background: var(--primary); color: var(--on-primary); }
.dty-nav .dty-spacer { flex: 1; }
.dty-main { padding: 32px 20px 64px; width: 100%; margin: 0 auto; }
.dty-app[data-width="narrow"] .dty-main { max-width: 720px; }
.dty-app[data-width="wide"] .dty-main { max-width: 1120px; }
.dty-page-header h1 { margin: 0 0 6px; font-size: 1.75rem; line-height: 1.25; }
.dty-page-header p { margin: 0 0 24px; color: var(--muted); }
.dty-hero { padding: 48px 0 24px; }
.dty-hero h1 { font-size: 2.25rem; margin: 0 0 12px; }
.dty-hero p { font-size: 1.125rem; color: var(--muted); max-width: 60ch; }
.dty-links { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
.dty-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.dty-stack > * + * { margin-top: 16px; }
.dty-form { display: grid; gap: 16px; max-width: 640px; }
.dty-field { display: grid; gap: 6px; }
.dty-field label { font-weight: 600; }
.dty-field small { color: var(--muted); }
.dty-field input, .dty-field select, .dty-field textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; min-height: 44px; width: 100%; }
.dty-field textarea { min-height: 120px; resize: vertical; }
.dty-check { display: flex; gap: 10px; align-items: center; min-height: 44px; }
.dty-check input { width: 20px; height: 20px; }
.dty-btn { font: inherit; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 10px 18px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; text-decoration: none; }
.dty-btn:hover { background: var(--surface2); }
.dty-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.dty-btn.accent { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.dty-btn.danger { color: var(--danger); }
.dty-btn:disabled { opacity: .6; cursor: progress; }
.dty-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.dty-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
table.dty-table { border-collapse: collapse; width: 100%; font-size: .95rem; }
.dty-table th, .dty-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.dty-table th { color: var(--muted); font-weight: 600; background: var(--surface2); }
.dty-table tr:last-child td { border-bottom: 0; }
.dty-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.dty-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
.dty-item img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: var(--surface2); }
.dty-item .dty-item-body { padding: 14px 16px; display: grid; gap: 4px; flex: 1; }
.dty-item h3 { margin: 0; font-size: 1.05rem; }
.dty-price { font-weight: 700; font-size: 1.1rem; }
.dty-badge { display: inline-block; font-size: .8rem; padding: 2px 8px; border-radius: 999px; background: var(--surface2); color: var(--muted); }
.dty-item .dty-item-foot { padding: 0 16px 16px; }
.dty-fields { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.dty-fields dt { color: var(--muted); }
.dty-fields dd { margin: 0; overflow-wrap: anywhere; }
.dty-thumb { max-width: 240px; border-radius: var(--radius); }
.dty-status { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.dty-status[data-status="failed"], .dty-status[data-status="paused"] { color: var(--danger); }
.dty-status[data-status="succeeded"] { color: var(--success); }
.dty-notice { padding: 12px 16px; border-radius: var(--radius); background: var(--surface2); }
.dty-error { color: var(--danger); }
.dty-muted { color: var(--muted); }
.dty-values { margin: 0; padding: 10px; background: var(--surface, #f6f6f6); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.dty-empty { color: var(--muted); padding: 24px; text-align: center; }
.dty-dialog { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: 24px; max-width: 420px; width: calc(100% - 32px); }
.dty-dialog::backdrop { background: rgb(0 0 0 / .4); }
.dty-dialog-wrap { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: rgb(0 0 0 / .4); padding: 16px; }
.dty-search { display: flex; gap: 8px; margin-bottom: 16px; max-width: 480px; }
.dty-search input { flex: 1; font: inherit; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); min-height: 44px; }
@media (max-width: 760px) {
  .dty-app[data-nav^="sidebar"] { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .dty-app[data-nav^="sidebar"] .dty-nav { flex-direction: row; flex-wrap: wrap; border-right: 0; border-left: 0; border-bottom: 1px solid var(--border); padding: 10px 16px; order: 0; }
  .dty-app[data-nav^="sidebar"] .dty-brand { margin: 0 16px 0 0; }
  .dty-main { padding: 24px 16px 48px; }
  .dty-fields { grid-template-columns: 1fr; }
  .dty-fields dd { margin-bottom: 8px; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;
