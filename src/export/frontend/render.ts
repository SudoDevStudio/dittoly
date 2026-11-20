/**
 * A framework-free renderer of the page plan (plain DOM, text only: nothing from the API is
 * ever inserted as HTML). The built-in UI and the Astro template use it.
 */
export const RENDER_JS = String.raw`import { asItems, autoDisplay, coerce, columnsFor, createClient, formatValue, formFields, humanize, isImageUrl, pageFor, pathOf, pick, resultValue, signOffText, statusText } from './core.js';

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export async function mount(root, options = {}) {
  const client = createClient(options);
  // Where the app's pages live: "" for an app at the root, a prefix when it is served under one.
  const base = (options.basePath ?? '').replace(/\/+$/, '');
  const here = () => (base && location.pathname.startsWith(base) ? location.pathname.slice(base.length) || '/' : location.pathname);
  let info;
  try { info = await client.app(); } catch (e) { root.replaceChildren(h('p', { class: 'dty-error' }, 'This app cannot be reached: ' + e.message)); return; }
  const plan = info.plan;
  const flows = new Map(info.flows.map((f) => [f.key, f]));
  document.title = info.name;
  const go = (path) => { history.pushState(null, '', base + path); render(); };
  window.addEventListener('popstate', () => render());

  function nav(active) {
    const brand = info.theme?.brand;
    return h('nav', { class: 'dty-nav', 'aria-label': 'Main' },
      h('a', { class: 'dty-brand', href: base + '/', onclick: (e) => { e.preventDefault(); go('/'); } }, brand?.logo ? h('img', { src: brand.logo, alt: '' }) : null, info.name),
      plan.layout.nav === 'none' ? null : plan.pages.filter((p) => p.kind !== 'home' || p.id !== plan.home).map((p) =>
        h('a', { class: 'dty-link', href: base + p.path, 'aria-current': p.id === active?.id ? 'page' : null, onclick: (e) => { e.preventDefault(); go(p.path); } }, p.title)),
      h('span', { class: 'dty-spacer' }),
      options.session ? null : h('button', { class: 'dty-btn', type: 'button', onclick: tokenDialog }, client.token ? 'Signed in' : 'Sign in'));
  }

  function tokenDialog() {
    const input = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Access token' });
    const dlg = h('dialog', { class: 'dty-dialog' },
      h('form', { class: 'dty-form', method: 'dialog', onsubmit: () => { client.setToken(input.value); render(); } },
        h('h2', {}, 'Sign in'),
        h('p', { class: 'dty-muted' }, 'Paste the access token you were given. It stays in this browser tab only.'),
        h('div', { class: 'dty-field' }, input),
        h('div', { class: 'dty-row' }, h('button', { class: 'dty-btn primary', type: 'submit' }, 'Sign in'),
          client.token ? h('button', { class: 'dty-btn', type: 'button', onclick: () => { client.setToken(null); dlg.close(); render(); } }, 'Sign out') : null)));
    document.body.append(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
  }

  function header(page) {
    return h('div', { class: 'dty-page-header' }, h('h1', {}, page.title), page.intro ? h('p', {}, page.intro) : null);
  }

  function fieldInput(f, value) {
    const id = 'f-' + f.name;
    const common = { id, name: f.name, required: f.required || null };
    let input;
    if (f.widget === 'select') input = h('select', common, f.required ? null : h('option', { value: '' }, ''), f.choices.map((c) => h('option', { value: c.value, selected: String(value ?? f.default ?? '') === c.value || null }, c.label)));
    else if (f.widget === 'multiselect') input = h('select', { ...common, multiple: true }, f.choices.map((c) => h('option', { value: c.value }, c.label)));
    else if (f.widget === 'textarea') input = h('textarea', { ...common, placeholder: f.placeholder || null, maxlength: f.maxLength ?? null }, value ?? f.default ?? '');
    else if (f.widget === 'checkbox') return h('div', { class: 'dty-check' }, h('input', { ...common, type: 'checkbox', checked: (value ?? f.default) ? true : null }), h('label', { for: id }, f.label));
    else input = h('input', { ...common, type: f.widget === 'number' ? 'number' : ['email', 'date', 'url'].includes(f.widget) ? f.widget : 'text', value: value ?? f.default ?? '', placeholder: f.placeholder || null, min: f.min ?? null, max: f.max ?? null, step: f.widget === 'number' && !f.integer ? 'any' : null, maxlength: f.maxLength ?? null });
    return h('div', { class: 'dty-field' }, h('label', { for: id }, f.label + (f.required ? ' *' : '')), input, f.help ? h('small', {}, f.help) : null);
  }

  function readForm(form, fields) {
    const raw = {};
    for (const f of fields) {
      const el = form.elements.namedItem(f.name);
      if (!el) continue;
      if (f.widget === 'checkbox') raw[f.name] = el.checked;
      else if (f.widget === 'multiselect') raw[f.name] = [...el.selectedOptions].map((o) => o.value);
      else raw[f.name] = el.value;
    }
    return coerce(fields, raw);
  }

  function itemCard(item, card, action) {
    const img = card.image ? pick(item, card.image) : undefined;
    return h('article', { class: 'dty-item' },
      isImageUrl(img) ? h('img', { src: img, alt: '', loading: 'lazy' }) : null,
      h('div', { class: 'dty-item-body' },
        card.badge && pick(item, card.badge) !== undefined ? h('span', { class: 'dty-badge' }, formatValue(pick(item, card.badge))) : null,
        h('h3', {}, formatValue(pick(item, card.title))),
        card.subtitle ? h('span', { class: 'dty-muted' }, formatValue(pick(item, card.subtitle))) : null,
        card.text ? h('p', {}, formatValue(pick(item, card.text))) : null,
        card.price ? h('span', { class: 'dty-price' }, formatValue(pick(item, card.price))) : null),
      action ? h('div', { class: 'dty-item-foot' }, actionButton(item, action)) : null);
  }

  function actionButton(item, action) {
    return h('button', { class: 'dty-btn primary', type: 'button', onclick: () => {
      const q = new URLSearchParams();
      for (const [input, field] of Object.entries(action.fill)) { const v = pick(item, field); if (v !== undefined) q.set(input, String(v)); }
      go(pathOf(plan, action.page) + (q.size ? '?' + q : ''));
    } }, action.label);
  }

  function showValue(value, display, opts = {}) {
    const mode = display === 'auto' || !display ? autoDisplay(value) : display;
    if (mode === 'message') return h('p', { class: 'dty-notice' }, opts.message ?? formatValue(value ?? 'Done.'));
    if (mode === 'fields') {
      const obj = value && typeof value === 'object' ? value : { value };
      return h('dl', { class: 'dty-fields' }, Object.entries(obj).flatMap(([k, v]) => [h('dt', {}, humanize(k)), h('dd', {}, isImageUrl(v) ? h('img', { src: v, alt: '', class: 'dty-thumb' }) : formatValue(v))]));
    }
    const items = asItems(value) ?? [];
    if (!items.length) return h('p', { class: 'dty-empty' }, 'Nothing to show.');
    if (mode === 'cards') {
      const card = opts.card ?? { title: columnsFor(items)[0].key };
      return h('div', { class: 'dty-grid' }, items.map((it) => itemCard(it, card, opts.action)));
    }
    const cols = columnsFor(items, opts.columns);
    return h('div', { class: 'dty-table-wrap' }, h('table', { class: 'dty-table' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c.label)), opts.action ? h('th', {}, '') : null)),
      h('tbody', {}, items.map((it) => h('tr', {}, cols.map((c) => h('td', {}, formatValue(c.key ? pick(it, c.key) : it))), opts.action ? h('td', {}, actionButton(it, opts.action)) : null)))));
  }

  function runPanel(run, onChange, opts) {
    const box = h('section', { class: 'dty-card dty-stack', 'aria-live': 'polite' }, h('div', { class: 'dty-status', 'data-status': run.status }, statusText(run)));
    for (const w of run.waiting) {
      if (w.kind === 'input' && w.form) {
        const fields = w.form.fields.map((f) => ({ name: f.name, label: f.label, help: f.help ?? '', placeholder: f.placeholder ?? '', widget: f.widget, required: f.required, choices: f.choices ?? [], default: f.default, integer: false }));
        const form = h('form', { class: 'dty-form', onsubmit: async (e) => {
          e.preventDefault();
          try { await client.answer(run.id, w.stepId, readForm(form, fields)); onChange(await client.settle(await client.run(run.id))); } catch (err) { form.append(h('p', { class: 'dty-error' }, err.message)); }
        } }, w.form.intro ? h('p', {}, w.form.intro) : null, fields.map((f) => fieldInput(f)), h('div', {}, h('button', { class: 'dty-btn primary', type: 'submit' }, 'Send')));
        box.append(h('h2', {}, w.title ?? 'A few more details'), form);
      } else if (w.kind === 'approval') box.append(h('p', { class: 'dty-muted' }, 'Someone has to approve this before it continues.'));
    }
    if (run.status === 'succeeded') box.append(showValue(resultValue(run, opts.source), opts.display, opts));
    return box;
  }

  async function formPage(page, main) {
    const flow = flows.get(page.flow);
    const fields = formFields(flow, page.fields);
    const pre = Object.fromEntries(new URLSearchParams(location.search));
    const out = h('div');
    const form = h('form', { class: 'dty-form', onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      out.replaceChildren(h('p', { class: 'dty-muted' }, 'Working…'));
      try {
        const show = (run) => out.replaceChildren(runPanel(run, show, { ...page.result }));
        show(await client.settle(await client.startRun(page.flow, readForm(form, fields))));
      } catch (err) { out.replaceChildren(h('p', { class: 'dty-error' }, err.status === 401 ? 'Sign in to use this page.' : err.message)); }
      btn.disabled = false;
    } }, fields.map((f) => fieldInput(f, pre[f.name])), h('div', {}, h('button', { class: 'dty-btn primary', type: 'submit' }, page.submitLabel)));
    main.append(header(page), h('div', { class: 'dty-stack' }, form, out));
  }

  async function listPage(page, main) {
    const out = h('div', {}, h('p', { class: 'dty-muted' }, 'Loading…'));
    const load = async (extra = {}) => {
      try {
        const run = await client.settle(await client.startRun(page.flow, { ...page.inputs, ...extra }));
        out.replaceChildren(run.status === 'succeeded' ? showValue(resultValue(run, page.source), page.kind, { columns: page.columns, card: page.card, action: page.action }) : runPanel(run, () => load(extra), { source: page.source, display: page.kind }));
      } catch (err) { out.replaceChildren(h('p', { class: 'dty-error' }, err.status === 401 ? 'Sign in to see this page.' : err.message)); }
    };
    let search = null;
    if (page.search) {
      const q = h('input', { type: 'search', 'aria-label': 'Search', placeholder: 'Search' });
      search = h('form', { class: 'dty-search', role: 'search', onsubmit: (e) => { e.preventDefault(); out.replaceChildren(h('p', { class: 'dty-muted' }, 'Loading…')); load(q.value ? { [page.search]: q.value } : {}); } }, q, h('button', { class: 'dty-btn', type: 'submit' }, 'Search'));
    }
    main.append(header(page), search, out);
    load();
  }

  async function inboxPage(page, main) {
    main.append(header(page));
    const out = h('div', { class: 'dty-stack' });
    main.append(out);
    if (!client.signedIn) { out.append(h('p', { class: 'dty-notice' }, 'Sign in with the admin token to see what waits for you.')); return; }
    try {
      const items = await client.inbox();
      if (!items.length) { out.append(h('p', { class: 'dty-empty' }, 'Nothing is waiting for you.')); return; }
      for (const it of items) {
        const card = h('article', { class: 'dty-card dty-stack' }, h('h2', {}, (it.title ?? humanize(it.stepId)) + ' · ' + (flows.get(it.flow)?.name ?? it.flow ?? '')), h('p', { class: 'dty-muted' }, new Date(it.createdAt).toLocaleString()));
        if (it.kind === 'approval') {
          if (it.signOff) card.append(h('p', { class: 'dty-muted' }, 'Text an AI wrote could steer this step. Approving lets it run with exactly these values:'), h('pre', { class: 'dty-values' }, signOffText(it)));
          card.append(h('div', { class: 'dty-row' },
            h('button', { class: 'dty-btn primary', type: 'button', onclick: async () => { await client.decide(it.runId, it.stepId, 'approved', it.signOff?.sha256); render(); } }, 'Approve'),
            h('button', { class: 'dty-btn danger', type: 'button', onclick: async () => { await client.decide(it.runId, it.stepId, 'rejected', it.signOff?.sha256); render(); } }, 'Reject')));
        } else {
          const run = await client.run(it.runId);
          card.append(runPanel(run, () => render(), { display: 'auto' }));
        }
        out.append(card);
      }
    } catch (err) { out.append(h('p', { class: 'dty-error' }, err.message)); }
  }

  async function runsPage(page, main) {
    main.append(header(page));
    if (!client.signedIn) { main.append(h('p', { class: 'dty-notice' }, 'Sign in to see runs.')); return; }
    try {
      const runs = await client.runs();
      main.append(runs.length ? h('div', { class: 'dty-table-wrap' }, h('table', { class: 'dty-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Flow'), h('th', {}, 'Status'), h('th', {}, 'Started'), h('th', {}, 'Finished'))),
        h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, flows.get(r.flow)?.name ?? r.flow ?? ''), h('td', {}, h('span', { class: 'dty-status', 'data-status': r.status }, humanize(r.status))), h('td', {}, new Date(r.createdAt).toLocaleString()), h('td', {}, r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '')))))) : h('p', { class: 'dty-empty' }, 'No runs yet.'));
    } catch (err) { main.append(h('p', { class: 'dty-error' }, err.message)); }
  }

  function homePage(page, main) {
    main.append(h('section', { class: 'dty-hero' }, h('h1', {}, page.headline || page.title), page.text ? h('p', {}, page.text) : null,
      h('div', { class: 'dty-links' }, page.links.map((id, i) => h('a', { class: 'dty-btn' + (i === 0 ? ' primary' : ''), href: base + pathOf(plan, id), onclick: (e) => { e.preventDefault(); go(pathOf(plan, id)); } }, plan.pages.find((p) => p.id === id)?.title ?? id)))));
  }

  function render() {
    const page = pageFor(plan, here());
    const main = h('main', { class: 'dty-main', id: 'main' });
    root.replaceChildren(h('div', { class: 'dty-app', 'data-nav': plan.layout.nav === 'none' ? 'top' : plan.layout.nav, 'data-width': plan.layout.width }, nav(page), main));
    if (!page) { main.append(h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: base + '/' }, 'Go to the start'))); return; }
    document.title = page.title + ' · ' + info.name;
    if (page.kind === 'home') homePage(page, main);
    else if (page.kind === 'form') formPage(page, main);
    else if (page.kind === 'table' || page.kind === 'cards') listPage(page, main);
    else if (page.kind === 'inbox') inboxPage(page, main);
    else runsPage(page, main);
  }
  render();
}
`;
