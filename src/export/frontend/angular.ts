/** Angular (standalone components, signals) for the page plan. */
export const ANGULAR_FILES: Record<string, string> = {
  'src/main.ts': String.raw`import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

// Zone-based change detection: the pages update after their API calls finish.
bootstrapApplication(AppComponent, { providers: [provideZoneChangeDetection({ eventCoalescing: true })] }).catch((err: unknown) => console.error(err));
`,
  'src/app/client.ts': String.raw`import { createClient, pick, pathOf, type Plan } from '../dittoly/core.js';

export const client = createClient({ baseUrl: '' });
export type Go = (path: string) => void;
export type Action = { label: string; page: string; fill: Record<string, string> };

export function openAction(plan: Plan, go: Go, item: unknown, action: Action): void {
  const q = new URLSearchParams();
  for (const [input, field] of Object.entries(action.fill)) { const v = pick(item, field); if (v !== undefined) q.set(input, String(v)); }
  go(pathOf(plan, action.page) + (q.size ? '?' + q.toString() : ''));
}

export function readForm(form: HTMLFormElement, names: { name: string; widget: string }[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const f of names) {
    const el = form.elements.namedItem(f.name);
    if (el instanceof HTMLInputElement) raw[f.name] = f.widget === 'checkbox' ? el.checked : el.value;
    else if (el instanceof HTMLSelectElement) raw[f.name] = f.widget === 'multiselect' ? Array.from(el.selectedOptions).map((o) => o.value) : el.value;
    else if (el instanceof HTMLTextAreaElement) raw[f.name] = el.value;
  }
  return raw;
}

export function problem(err: unknown): string {
  return (err as { status?: number }).status === 401 ? 'Sign in to use this page.' : (err as Error).message;
}
`,
  'src/app/field-input.component.ts': String.raw`import { Component, Input } from '@angular/core';
import type { Field } from '../dittoly/core.js';

@Component({ selector: 'dty-field', standalone: true, templateUrl: './field-input.component.html' })
export class FieldInputComponent {
  @Input({ required: true }) f!: Field;
  @Input() value: string | undefined;
  get id(): string { return 'f-' + this.f.name; }
  get initial(): string { return this.value ?? (this.f.default === undefined ? '' : String(this.f.default)); }
  get type(): string { return ['email', 'date', 'url'].includes(this.f.widget) ? this.f.widget : this.f.widget === 'number' ? 'number' : 'text'; }
}
`,
  'src/app/field-input.component.html': String.raw`@if (f.widget === 'checkbox') {
  <div class="dty-check"><input [id]="id" [name]="f.name" type="checkbox" [checked]="!!(value ?? f.default)" /><label [for]="id">{{ f.label }}</label></div>
} @else {
  <div class="dty-field">
    <label [for]="id">{{ f.label }}{{ f.required ? ' *' : '' }}</label>
    @switch (f.widget) {
      @case ('select') {
        <select [id]="id" [name]="f.name" [required]="f.required">
          @if (!f.required) { <option value=""></option> }
          @for (c of f.choices; track c.value) { <option [value]="c.value" [selected]="initial === c.value">{{ c.label }}</option> }
        </select>
      }
      @case ('multiselect') {
        <select [id]="id" [name]="f.name" multiple>@for (c of f.choices; track c.value) { <option [value]="c.value">{{ c.label }}</option> }</select>
      }
      @case ('textarea') {
        <textarea [id]="id" [name]="f.name" [required]="f.required" [attr.placeholder]="f.placeholder || null" [attr.maxlength]="f.maxLength ?? null" [value]="initial"></textarea>
      }
      @default {
        <input [id]="id" [name]="f.name" [required]="f.required" [type]="type" [attr.placeholder]="f.placeholder || null" [attr.min]="f.min ?? null" [attr.max]="f.max ?? null" [attr.step]="f.widget === 'number' && !f.integer ? 'any' : null" [attr.maxlength]="f.maxLength ?? null" [value]="initial" />
      }
    }
    @if (f.help) { <small>{{ f.help }}</small> }
  </div>
}
`,
  'src/app/show-value.component.ts': String.raw`import { Component, Input } from '@angular/core';
import { asItems, autoDisplay, columnsFor, formatValue, humanize, isImageUrl, pick, type Card, type Column, type Plan } from '../dittoly/core.js';
import { openAction, type Action, type Go } from './client';

@Component({ selector: 'dty-show', standalone: true, templateUrl: './show-value.component.html' })
export class ShowValueComponent {
  @Input() value: unknown;
  @Input() display = 'auto';
  @Input() message: string | undefined;
  @Input() columns: Column[] | undefined;
  @Input() card: Card | undefined;
  @Input() action: Action | undefined;
  @Input({ required: true }) plan!: Plan;
  @Input({ required: true }) go!: Go;
  readonly formatValue = formatValue;
  readonly humanize = humanize;
  readonly isImageUrl = isImageUrl;
  readonly pick = pick;
  readonly String = String;
  get mode(): string { return this.display === 'auto' || !this.display ? autoDisplay(this.value) : this.display; }
  get items(): unknown[] { return asItems(this.value) ?? []; }
  get fields(): [string, unknown][] { return Object.entries(this.value && typeof this.value === 'object' ? (this.value as Record<string, unknown>) : { value: this.value }); }
  get cols(): Column[] { return columnsFor(this.items, this.columns); }
  get theCard(): Card { return this.card ?? { title: columnsFor(this.items)[0]!.key }; }
  open(item: unknown): void { if (this.action) openAction(this.plan, this.go, item, this.action); }
}
`,
  'src/app/show-value.component.html': String.raw`@if (mode === 'message') {
  <p class="dty-notice">{{ message ?? formatValue(value ?? 'Done.') }}</p>
} @else if (mode === 'fields') {
  <dl class="dty-fields">
    @for (kv of fields; track kv[0]) {
      <dt>{{ humanize(kv[0]) }}</dt>
      <dd>@if (isImageUrl(kv[1])) { <img class="dty-thumb" [src]="String(kv[1])" alt="" /> } @else { {{ formatValue(kv[1]) }} }</dd>
    }
  </dl>
} @else if (!items.length) {
  <p class="dty-empty">Nothing to show.</p>
} @else if (mode === 'cards') {
  <div class="dty-grid">
    @for (it of items; track $index) {
      <article class="dty-item">
        @if (theCard.image && isImageUrl(pick(it, theCard.image))) { <img [src]="String(pick(it, theCard.image))" alt="" loading="lazy" /> }
        <div class="dty-item-body">
          @if (theCard.badge && pick(it, theCard.badge) !== undefined) { <span class="dty-badge">{{ formatValue(pick(it, theCard.badge)) }}</span> }
          <h3>{{ formatValue(pick(it, theCard.title)) }}</h3>
          @if (theCard.subtitle) { <span class="dty-muted">{{ formatValue(pick(it, theCard.subtitle)) }}</span> }
          @if (theCard.text) { <p>{{ formatValue(pick(it, theCard.text)) }}</p> }
          @if (theCard.price) { <span class="dty-price">{{ formatValue(pick(it, theCard.price)) }}</span> }
        </div>
        @if (action) { <div class="dty-item-foot"><button class="dty-btn primary" type="button" (click)="open(it)">{{ action.label }}</button></div> }
      </article>
    }
  </div>
} @else {
  <div class="dty-table-wrap"><table class="dty-table">
    <thead><tr>@for (c of cols; track c.key) { <th scope="col">{{ c.label }}</th> } @if (action) { <th></th> }</tr></thead>
    <tbody>
      @for (it of items; track $index) {
        <tr>
          @for (c of cols; track c.key) { <td>{{ formatValue(c.key ? pick(it, c.key) : it) }}</td> }
          @if (action) { <td><button class="dty-btn primary" type="button" (click)="open(it)">{{ action.label }}</button></td> }
        </tr>
      }
    </tbody>
  </table></div>
}
`,
  'src/app/run-panel.component.ts': String.raw`import { Component, EventEmitter, Input, Output } from '@angular/core';
import { coerce, resultValue, statusText, type Card, type Column, type Field, type Plan, type Run, type Source, type Waiting } from '../dittoly/core.js';
import { client, readForm, type Go } from './client';
import { FieldInputComponent } from './field-input.component';
import { ShowValueComponent } from './show-value.component';

@Component({ selector: 'dty-run', standalone: true, imports: [FieldInputComponent, ShowValueComponent], templateUrl: './run-panel.component.html' })
export class RunPanelComponent {
  @Input({ required: true }) run!: Run;
  @Input() source: Source = {};
  @Input() display = 'auto';
  @Input() message: string | undefined;
  @Input() columns: Column[] | undefined;
  @Input() card: Card | undefined;
  @Input({ required: true }) plan!: Plan;
  @Input({ required: true }) go!: Go;
  @Output() changed = new EventEmitter<Run>();
  error = '';
  readonly statusText = statusText;
  readonly resultValue = resultValue;
  fieldsOf(w: Waiting): Field[] {
    return (w.form?.fields ?? []).map((f: { name: string; label: string; help?: string; placeholder?: string; widget: string; required: boolean; choices?: { value: string; label: string }[]; default?: unknown }) => ({ name: f.name, label: f.label, help: f.help ?? '', placeholder: f.placeholder ?? '', widget: f.widget, required: f.required, choices: f.choices ?? [], default: f.default, integer: false }));
  }
  async submit(e: Event, w: Waiting): Promise<void> {
    e.preventDefault();
    const fields = this.fieldsOf(w);
    try {
      await client.answer(this.run.id, w.stepId, coerce(fields, readForm(e.target as HTMLFormElement, fields)));
      this.changed.emit(await client.settle(await client.run(this.run.id)));
    } catch (err) { this.error = (err as Error).message; }
  }
}
`,
  'src/app/run-panel.component.html': String.raw`<section class="dty-card dty-stack" aria-live="polite">
  <div class="dty-status" [attr.data-status]="run.status">{{ statusText(run) }}</div>
  @for (w of run.waiting; track w.stepId) {
    @if (w.kind === 'approval') {
      <p class="dty-muted">Someone has to approve this before it continues.</p>
    } @else {
      <form class="dty-form" (submit)="submit($event, w)">
        <h2>{{ w.title ?? 'A few more details' }}</h2>
        @if (w.form?.intro; as intro) { <p>{{ intro }}</p> }
        @for (f of fieldsOf(w); track f.name) { <dty-field [f]="f" /> }
        <div><button class="dty-btn primary" type="submit">Send</button></div>
      </form>
    }
  }
  @if (error) { <p class="dty-error">{{ error }}</p> }
  @if (run.status === 'succeeded') {
    <dty-show [value]="resultValue(run, source)" [display]="display" [message]="message" [columns]="columns" [card]="card" [plan]="plan" [go]="go" />
  }
</section>
`,
  'src/app/form-page.component.ts': String.raw`import { Component, Input, type OnInit } from '@angular/core';
import { coerce, formFields, type AppFlow, type Field, type Page, type Plan, type Run } from '../dittoly/core.js';
import { client, problem, readForm, type Go } from './client';
import { FieldInputComponent } from './field-input.component';
import { RunPanelComponent } from './run-panel.component';

@Component({ selector: 'dty-form-page', standalone: true, imports: [FieldInputComponent, RunPanelComponent], templateUrl: './form-page.component.html' })
export class FormPageComponent implements OnInit {
  @Input({ required: true }) page!: Extract<Page, { kind: 'form' }>;
  @Input({ required: true }) flow!: AppFlow;
  @Input({ required: true }) plan!: Plan;
  @Input({ required: true }) go!: Go;
  fields: Field[] = [];
  pre: Record<string, string> = {};
  run: Run | null = null;
  busy = false;
  error = '';
  ngOnInit(): void {
    this.fields = formFields(this.flow, this.page.fields);
    this.pre = Object.fromEntries(new URLSearchParams(window.location.search));
  }
  async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy = true; this.error = ''; this.run = null;
    try { this.run = await client.settle(await client.startRun(this.page.flow, coerce(this.fields, readForm(e.target as HTMLFormElement, this.fields)))); } catch (err) { this.error = problem(err); }
    this.busy = false;
  }
}
`,
  'src/app/form-page.component.html': String.raw`<div class="dty-stack">
  <form class="dty-form" (submit)="submit($event)">
    @for (f of fields; track f.name) { <dty-field [f]="f" [value]="pre[f.name]" /> }
    <div><button class="dty-btn primary" type="submit" [disabled]="busy">{{ busy ? 'Working…' : page.submitLabel }}</button></div>
  </form>
  @if (error) { <p class="dty-error">{{ error }}</p> }
  @if (run) {
    <dty-run [run]="run" [source]="page.result.source" [display]="page.result.display" [message]="page.result.message" [columns]="page.result.columns" [card]="page.result.card" [plan]="plan" [go]="go" (changed)="run = $event" />
  }
</div>
`,
  'src/app/list-page.component.ts': String.raw`import { Component, Input, type OnInit } from '@angular/core';
import { resultValue, type Page, type Plan, type Run } from '../dittoly/core.js';
import { client, problem, type Go } from './client';
import { RunPanelComponent } from './run-panel.component';
import { ShowValueComponent } from './show-value.component';

@Component({ selector: 'dty-list-page', standalone: true, imports: [RunPanelComponent, ShowValueComponent], templateUrl: './list-page.component.html' })
export class ListPageComponent implements OnInit {
  @Input({ required: true }) page!: Extract<Page, { kind: 'table' | 'cards' }>;
  @Input({ required: true }) plan!: Plan;
  @Input({ required: true }) go!: Go;
  run: Run | null = null;
  error = '';
  query = '';
  readonly resultValue = resultValue;
  ngOnInit(): void { void this.load(); }
  async load(extra: Record<string, unknown> = {}): Promise<void> {
    this.run = null; this.error = '';
    try { this.run = await client.settle(await client.startRun(this.page.flow, { ...this.page.inputs, ...extra })); } catch (err) { this.error = problem(err); }
  }
  search(e: Event): void {
    e.preventDefault();
    const q = ((e.target as HTMLFormElement).elements.namedItem('q') as HTMLInputElement).value;
    void this.load(q && this.page.search ? { [this.page.search]: q } : {});
  }
}
`,
  'src/app/list-page.component.html': String.raw`@if (page.search) {
  <form class="dty-search" role="search" (submit)="search($event)">
    <input name="q" type="search" aria-label="Search" placeholder="Search" />
    <button class="dty-btn" type="submit">Search</button>
  </form>
}
@if (error) {
  <p class="dty-error">{{ error }}</p>
} @else if (!run) {
  <p class="dty-muted">Loading…</p>
} @else if (run.status === 'succeeded') {
  <dty-show [value]="resultValue(run, page.source)" [display]="page.kind" [columns]="page.columns" [card]="page.card" [action]="page.action" [plan]="plan" [go]="go" />
} @else {
  <dty-run [run]="run" [source]="page.source" [display]="page.kind" [plan]="plan" [go]="go" (changed)="run = $event" />
}
`,
  'src/app/app.component.ts': String.raw`import { Component, type OnDestroy, type OnInit } from '@angular/core';
import { humanize, pageFor, pathOf, signOffText, type AppFlow, type AppInfo, type InboxItem, type Page } from '../dittoly/core.js';
import { client, problem } from './client';
import { FormPageComponent } from './form-page.component';
import { ListPageComponent } from './list-page.component';

type RunRow = Awaited<ReturnType<typeof client.runs>>[number];

@Component({ selector: 'app-root', standalone: true, imports: [FormPageComponent, ListPageComponent], templateUrl: './app.component.html' })
export class AppComponent implements OnInit, OnDestroy {
  info: AppInfo | null = null;
  error = '';
  path = window.location.pathname;
  signIn = false;
  signedIn = !!client.token;
  inbox: InboxItem[] | null = null;
  runs: RunRow[] | null = null;
  listError = '';
  flows = new Map<string, AppFlow>();
  readonly humanize = humanize;
  readonly pathOf = pathOf;
  readonly go = (p: string): void => { window.history.pushState(null, '', p); this.path = p.split('?')[0]!; window.scrollTo(0, 0); void this.loadLists(); };
  private readonly onPop = (): void => { this.path = window.location.pathname; void this.loadLists(); };

  async ngOnInit(): Promise<void> {
    window.addEventListener('popstate', this.onPop);
    try {
      this.info = await client.app();
      this.flows = new Map(this.info.flows.map((f) => [f.key, f]));
      document.title = this.info.name;
      await this.loadLists();
    } catch (err) { this.error = (err as Error).message; }
  }
  ngOnDestroy(): void { window.removeEventListener('popstate', this.onPop); }

  get page(): Page | null { return this.info ? pageFor(this.info.plan, this.path) : null; }
  get navPages(): Page[] { return this.info ? this.info.plan.pages.filter((p) => !(p.kind === 'home' && p.id === this.info!.plan.home)) : []; }
  get logo(): string | undefined { return (this.info?.theme?.brand as { logo?: string } | undefined)?.logo; }
  get formPage(): Extract<Page, { kind: 'form' }> | null { const p = this.page; return p && p.kind === 'form' ? p : null; }
  get listPage(): Extract<Page, { kind: 'table' | 'cards' }> | null { const p = this.page; return p && (p.kind === 'table' || p.kind === 'cards') ? p : null; }
  get homePage(): Extract<Page, { kind: 'home' }> | null { const p = this.page; return p && p.kind === 'home' ? p : null; }
  intro(p: Page): string { return 'intro' in p ? p.intro : ''; }
  title(id: string): string { return this.info?.plan.pages.find((p) => p.id === id)?.title ?? id; }
  flowName(key: string | null): string { return this.flows.get(key ?? '')?.name ?? key ?? ''; }
  date(v: string | null): string { return v ? new Date(v).toLocaleString() : ''; }
  link(e: Event, p: string): void { e.preventDefault(); this.go(p); }

  async loadLists(): Promise<void> {
    const p = this.page;
    this.listError = '';
    if (!client.token || !p) return;
    try {
      if (p.kind === 'inbox') this.inbox = await client.inbox();
      if (p.kind === 'runs') this.runs = await client.runs();
    } catch (err) { this.listError = problem(err); }
  }
  readonly signOffText = signOffText;
  async decide(it: InboxItem, d: 'approved' | 'rejected'): Promise<void> { await client.decide(it.runId, it.stepId, d, it.signOff?.sha256); await this.loadLists(); }
  saveToken(e: Event): void {
    e.preventDefault();
    client.setToken(((e.target as HTMLFormElement).elements.namedItem('token') as HTMLInputElement).value);
    this.signedIn = !!client.token; this.signIn = false; void this.loadLists();
  }
  signOut(): void { client.setToken(null); this.signedIn = false; this.signIn = false; this.inbox = null; this.runs = null; }
}
`,
  'src/app/app.component.html': String.raw`@if (error) {
  <main class="dty-main"><p class="dty-error">This app cannot be reached: {{ error }}</p></main>
} @else if (!info) {
  <main class="dty-main"><p class="dty-muted">Loading…</p></main>
} @else {
  <div class="dty-app" [attr.data-nav]="info.plan.layout.nav === 'none' ? 'top' : info.plan.layout.nav" [attr.data-width]="info.plan.layout.width">
    <nav class="dty-nav" aria-label="Main">
      <a class="dty-brand" href="/" (click)="link($event, '/')">@if (logo) { <img [src]="logo" alt="" /> }{{ info.name }}</a>
      @if (info.plan.layout.nav !== 'none') {
        @for (p of navPages; track p.id) { <a class="dty-link" [href]="p.path" [attr.aria-current]="p.id === page?.id ? 'page' : null" (click)="link($event, p.path)">{{ p.title }}</a> }
      }
      <span class="dty-spacer"></span>
      <button class="dty-btn" type="button" (click)="signIn = true">{{ signedIn ? 'Signed in' : 'Sign in' }}</button>
    </nav>
    <main id="main" class="dty-main">
      @if (!page) {
        <h1>Page not found</h1><p><a href="/" (click)="link($event, '/')">Go to the start</a></p>
      } @else if (homePage; as h) {
        <section class="dty-hero">
          <h1>{{ h.headline || h.title }}</h1>
          @if (h.text) { <p>{{ h.text }}</p> }
          <div class="dty-links">@for (id of h.links; track id; let i = $index) { <a [class]="i === 0 ? 'dty-btn primary' : 'dty-btn'" [href]="pathOf(info.plan, id)" (click)="link($event, pathOf(info.plan, id))">{{ title(id) }}</a> }</div>
        </section>
      } @else {
        <div class="dty-page-header"><h1>{{ page.title }}</h1>@if (intro(page)) { <p>{{ intro(page) }}</p> }</div>
        @if (formPage; as fp) {
          @if (flows.get(fp.flow); as flow) { <dty-form-page [page]="fp" [flow]="flow" [plan]="info.plan" [go]="go" /> }
        } @else if (listPage; as lp) {
          @for (k of [lp.id]; track k) { <dty-list-page [page]="lp" [plan]="info.plan" [go]="go" /> }
        } @else if (page.kind === 'inbox') {
          @if (!signedIn) { <p class="dty-notice">Sign in with the admin token to see what waits for you.</p> }
          @else if (listError) { <p class="dty-error">{{ listError }}</p> }
          @else if (!inbox) { <p class="dty-muted">Loading…</p> }
          @else if (!inbox.length) { <p class="dty-empty">Nothing is waiting for you.</p> }
          @else {
            <div class="dty-stack">
              @for (it of inbox; track it.runId + it.stepId) {
                <article class="dty-card dty-stack">
                  <h2>{{ (it.title ?? humanize(it.stepId)) + ' · ' + flowName(it.flow) }}</h2>
                  <p class="dty-muted">{{ date(it.createdAt) }}</p>
                  @if (it.kind === 'approval' && it.signOff) {
                    <p class="dty-muted">Text an AI wrote could steer this step. Approving lets it run with exactly these values:</p>
                    <pre class="dty-values">{{ signOffText(it) }}</pre>
                  }
                  @if (it.kind === 'approval') {
                    <div class="dty-row">
                      <button class="dty-btn primary" type="button" (click)="decide(it, 'approved')">Approve</button>
                      <button class="dty-btn danger" type="button" (click)="decide(it, 'rejected')">Reject</button>
                    </div>
                  } @else { <p class="dty-muted">This run waits for a form; open it from the page that started it.</p> }
                </article>
              }
            </div>
          }
        } @else {
          @if (!signedIn) { <p class="dty-notice">Sign in to see runs.</p> }
          @else if (listError) { <p class="dty-error">{{ listError }}</p> }
          @else if (!runs) { <p class="dty-muted">Loading…</p> }
          @else if (!runs.length) { <p class="dty-empty">No runs yet.</p> }
          @else {
            <div class="dty-table-wrap"><table class="dty-table">
              <thead><tr><th>Flow</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead>
              <tbody>@for (r of runs; track r.id) { <tr><td>{{ flowName(r.flow) }}</td><td><span class="dty-status" [attr.data-status]="r.status">{{ humanize(r.status) }}</span></td><td>{{ date(r.createdAt) }}</td><td>{{ date(r.finishedAt) }}</td></tr> }</tbody>
            </table></div>
          }
        }
      }
    </main>
    @if (signIn) {
      <div class="dty-dialog-wrap" role="dialog" aria-modal="true" aria-labelledby="dty-signin">
        <form class="dty-dialog dty-form" (submit)="saveToken($event)">
          <h2 id="dty-signin">Sign in</h2>
          <p class="dty-muted">Paste the access token you were given. It stays in this browser tab only.</p>
          <div class="dty-field"><input name="token" type="password" autocomplete="off" aria-label="Access token" /></div>
          <div class="dty-row">
            <button class="dty-btn primary" type="submit">Sign in</button>
            @if (signedIn) { <button class="dty-btn" type="button" (click)="signOut()">Sign out</button> }
            <button class="dty-btn" type="button" (click)="signIn = false">Cancel</button>
          </div>
        </form>
      </div>
    }
  </div>
}
`,
};
