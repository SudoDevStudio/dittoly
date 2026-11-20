/** Vue 3 single-file components for the page plan. */
export const VUE_FILES: Record<string, string> = {
  'src/App.vue': String.raw`<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { createClient, pageFor, pathOf, type AppInfo, type Page } from './dittoly/core.js';
import FormPage from './components/FormPage.vue';
import ListPage from './components/ListPage.vue';
import InboxPage from './components/InboxPage.vue';
import RunsPage from './components/RunsPage.vue';

const client = createClient({ baseUrl: import.meta.env.VITE_API_URL ?? '' });
const info = ref<AppInfo | null>(null);
const error = ref('');
const path = ref(window.location.pathname);
const signIn = ref(false);
const token = ref('');
const signedIn = ref(!!client.token);
const go = (p: string) => { window.history.pushState(null, '', p); path.value = p.split('?')[0]!; window.scrollTo(0, 0); };
const onPop = () => { path.value = window.location.pathname; };
onMounted(async () => {
  window.addEventListener('popstate', onPop);
  try { info.value = await client.app(); document.title = info.value.name; } catch (e) { error.value = (e as Error).message; }
});
onUnmounted(() => window.removeEventListener('popstate', onPop));
const plan = computed(() => info.value?.plan);
const page = computed<Page | null>(() => (plan.value ? pageFor(plan.value, path.value) : null));
const navPages = computed(() => (plan.value ? plan.value.pages.filter((p) => !(p.kind === 'home' && p.id === plan.value!.home)) : []));
const flows = computed(() => new Map((info.value?.flows ?? []).map((f) => [f.key, f])));
const logo = computed(() => (info.value?.theme?.brand as { logo?: string } | undefined)?.logo);
const linkTitle = (id: string) => plan.value?.pages.find((p) => p.id === id)?.title ?? id;
const saveToken = () => { client.setToken(token.value); signedIn.value = !!client.token; signIn.value = false; token.value = ''; };
const signOut = () => { client.setToken(null); signedIn.value = false; signIn.value = false; };
</script>

<template>
  <main v-if="error" class="dty-main"><p class="dty-error">This app cannot be reached: {{ error }}</p></main>
  <main v-else-if="!info || !plan" class="dty-main"><p class="dty-muted">Loading…</p></main>
  <div v-else class="dty-app" :data-nav="plan.layout.nav === 'none' ? 'top' : plan.layout.nav" :data-width="plan.layout.width">
    <nav class="dty-nav" aria-label="Main">
      <a class="dty-brand" href="/" @click.prevent="go('/')"><img v-if="logo" :src="logo" alt="" />{{ info.name }}</a>
      <template v-if="plan.layout.nav !== 'none'">
        <a v-for="p in navPages" :key="p.id" class="dty-link" :href="p.path" :aria-current="p.id === page?.id ? 'page' : undefined" @click.prevent="go(p.path)">{{ p.title }}</a>
      </template>
      <span class="dty-spacer" />
      <button class="dty-btn" type="button" @click="signIn = true">{{ signedIn ? 'Signed in' : 'Sign in' }}</button>
    </nav>
    <main id="main" class="dty-main" :key="path + String(signedIn)">
      <template v-if="!page"><h1>Page not found</h1><p><a href="/" @click.prevent="go('/')">Go to the start</a></p></template>
      <section v-else-if="page.kind === 'home'" class="dty-hero">
        <h1>{{ page.headline || page.title }}</h1>
        <p v-if="page.text">{{ page.text }}</p>
        <div class="dty-links"><a v-for="(id, i) in page.links" :key="id" :class="['dty-btn', { primary: i === 0 }]" :href="pathOf(plan, id)" @click.prevent="go(pathOf(plan, id))">{{ linkTitle(id) }}</a></div>
      </section>
      <template v-else>
        <div class="dty-page-header"><h1>{{ page.title }}</h1><p v-if="'intro' in page && page.intro">{{ page.intro }}</p></div>
        <FormPage v-if="page.kind === 'form' && flows.get(page.flow)" :client="client" :page="page" :flow="flows.get(page.flow)!" :plan="plan" :go="go" />
        <ListPage v-else-if="page.kind === 'table' || page.kind === 'cards'" :client="client" :page="page" :plan="plan" :go="go" />
        <InboxPage v-else-if="page.kind === 'inbox'" :client="client" :flows="flows" />
        <RunsPage v-else-if="page.kind === 'runs'" :client="client" :flows="flows" />
      </template>
    </main>
    <div v-if="signIn" class="dty-dialog-wrap" role="dialog" aria-modal="true" aria-labelledby="dty-signin">
      <form class="dty-dialog dty-form" @submit.prevent="saveToken">
        <h2 id="dty-signin">Sign in</h2>
        <p class="dty-muted">Paste the access token you were given. It stays in this browser tab only.</p>
        <div class="dty-field"><input v-model="token" type="password" autocomplete="off" aria-label="Access token" /></div>
        <div class="dty-row">
          <button class="dty-btn primary" type="submit">Sign in</button>
          <button v-if="signedIn" class="dty-btn" type="button" @click="signOut">Sign out</button>
          <button class="dty-btn" type="button" @click="signIn = false">Cancel</button>
        </div>
      </form>
    </div>
  </div>
</template>
`,
  'src/components/FieldInput.vue': String.raw`<script setup lang="ts">
import type { Field } from '../dittoly/core.js';
const props = defineProps<{ f: Field; value?: string }>();
const id = 'f-' + props.f.name;
const initial = props.value ?? (props.f.default === undefined ? '' : String(props.f.default));
const inputType = ['email', 'date', 'url'].includes(props.f.widget) ? props.f.widget : props.f.widget === 'number' ? 'number' : 'text';
</script>

<template>
  <div v-if="f.widget === 'checkbox'" class="dty-check"><input :id="id" :name="f.name" type="checkbox" :checked="!!(value ?? f.default)" /><label :for="id">{{ f.label }}</label></div>
  <div v-else class="dty-field">
    <label :for="id">{{ f.label }}{{ f.required ? ' *' : '' }}</label>
    <select v-if="f.widget === 'select'" :id="id" :name="f.name" :required="f.required">
      <option v-if="!f.required" value="" />
      <option v-for="c in f.choices" :key="c.value" :value="c.value" :selected="initial === c.value">{{ c.label }}</option>
    </select>
    <select v-else-if="f.widget === 'multiselect'" :id="id" :name="f.name" multiple><option v-for="c in f.choices" :key="c.value" :value="c.value">{{ c.label }}</option></select>
    <textarea v-else-if="f.widget === 'textarea'" :id="id" :name="f.name" :required="f.required" :placeholder="f.placeholder || undefined" :maxlength="f.maxLength" :value="initial" />
    <input v-else :id="id" :name="f.name" :required="f.required" :type="inputType" :placeholder="f.placeholder || undefined" :min="f.min" :max="f.max" :step="f.widget === 'number' && !f.integer ? 'any' : undefined" :maxlength="f.maxLength" :value="initial" />
    <small v-if="f.help">{{ f.help }}</small>
  </div>
</template>
`,
  'src/components/ShowValue.vue': String.raw`<script setup lang="ts">
import { computed } from 'vue';
import { asItems, autoDisplay, columnsFor, formatValue, humanize, isImageUrl, pathOf, pick, type Card, type Column, type Plan } from '../dittoly/core.js';
type Action = { label: string; page: string; fill: Record<string, string> };
const props = defineProps<{ value: unknown; display: string; message?: string; columns?: Column[]; card?: Card; action?: Action; plan: Plan; go: (p: string) => void }>();
const mode = computed(() => (props.display === 'auto' || !props.display ? autoDisplay(props.value) : props.display));
const items = computed(() => asItems(props.value) ?? []);
const fields = computed(() => Object.entries(props.value && typeof props.value === 'object' ? (props.value as Record<string, unknown>) : { value: props.value }));
const cols = computed(() => columnsFor(items.value, props.columns));
const card = computed<Card>(() => props.card ?? { title: columnsFor(items.value)[0]!.key });
const open = (item: unknown) => {
  if (!props.action) return;
  const q = new URLSearchParams();
  for (const [input, field] of Object.entries(props.action.fill)) { const v = pick(item, field); if (v !== undefined) q.set(input, String(v)); }
  props.go(pathOf(props.plan, props.action.page) + (q.size ? '?' + q.toString() : ''));
};
</script>

<template>
  <p v-if="mode === 'message'" class="dty-notice">{{ message ?? formatValue(value ?? 'Done.') }}</p>
  <dl v-else-if="mode === 'fields'" class="dty-fields">
    <template v-for="[k, v] in fields" :key="k"><dt>{{ humanize(k) }}</dt><dd><img v-if="isImageUrl(v)" class="dty-thumb" :src="String(v)" alt="" /><template v-else>{{ formatValue(v) }}</template></dd></template>
  </dl>
  <p v-else-if="!items.length" class="dty-empty">Nothing to show.</p>
  <div v-else-if="mode === 'cards'" class="dty-grid">
    <article v-for="(it, i) in items" :key="i" class="dty-item">
      <img v-if="card.image && isImageUrl(pick(it, card.image))" :src="String(pick(it, card.image))" alt="" loading="lazy" />
      <div class="dty-item-body">
        <span v-if="card.badge && pick(it, card.badge) !== undefined" class="dty-badge">{{ formatValue(pick(it, card.badge)) }}</span>
        <h3>{{ formatValue(pick(it, card.title)) }}</h3>
        <span v-if="card.subtitle" class="dty-muted">{{ formatValue(pick(it, card.subtitle)) }}</span>
        <p v-if="card.text">{{ formatValue(pick(it, card.text)) }}</p>
        <span v-if="card.price" class="dty-price">{{ formatValue(pick(it, card.price)) }}</span>
      </div>
      <div v-if="action" class="dty-item-foot"><button class="dty-btn primary" type="button" @click="open(it)">{{ action.label }}</button></div>
    </article>
  </div>
  <div v-else class="dty-table-wrap"><table class="dty-table">
    <thead><tr><th v-for="c in cols" :key="c.key" scope="col">{{ c.label }}</th><th v-if="action" /></tr></thead>
    <tbody><tr v-for="(it, i) in items" :key="i"><td v-for="c in cols" :key="c.key">{{ formatValue(c.key ? pick(it, c.key) : it) }}</td><td v-if="action"><button class="dty-btn primary" type="button" @click="open(it)">{{ action.label }}</button></td></tr></tbody>
  </table></div>
</template>
`,
  'src/components/RunPanel.vue': String.raw`<script setup lang="ts">
import { ref } from 'vue';
import { coerce, resultValue, statusText, type Card, type Client, type Column, type Field, type Plan, type Run, type Source } from '../dittoly/core.js';
import FieldInput from './FieldInput.vue';
import ShowValue from './ShowValue.vue';
const props = defineProps<{ client: Client; run: Run; source: Source; display: string; message?: string; columns?: Column[]; card?: Card; plan: Plan; go: (p: string) => void }>();
const emit = defineEmits<{ change: [run: Run] }>();
const error = ref('');
const fieldsOf = (form?: { fields: { name: string; label: string; help?: string; placeholder?: string; widget: string; required: boolean; choices?: { value: string; label: string }[]; default?: unknown }[] }): Field[] =>
  (form?.fields ?? []).map((f) => ({ name: f.name, label: f.label, help: f.help ?? '', placeholder: f.placeholder ?? '', widget: f.widget, required: f.required, choices: f.choices ?? [], default: f.default, integer: false }));
const submit = async (e: Event, stepId: string, fields: Field[]) => {
  const form = e.target as HTMLFormElement;
  const raw: Record<string, unknown> = {};
  for (const f of fields) {
    const el = form.elements.namedItem(f.name);
    if (el instanceof HTMLInputElement) raw[f.name] = f.widget === 'checkbox' ? el.checked : el.value;
    else if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) raw[f.name] = el.value;
  }
  try { await props.client.answer(props.run.id, stepId, coerce(fields, raw)); emit('change', await props.client.settle(await props.client.run(props.run.id))); } catch (err) { error.value = (err as Error).message; }
};
</script>

<template>
  <section class="dty-card dty-stack" aria-live="polite">
    <div class="dty-status" :data-status="run.status">{{ statusText(run) }}</div>
    <template v-for="w in run.waiting" :key="w.stepId">
      <p v-if="w.kind === 'approval'" class="dty-muted">Someone has to approve this before it continues.</p>
      <form v-else class="dty-form" @submit.prevent="submit($event, w.stepId, fieldsOf(w.form))">
        <h2>{{ w.title ?? 'A few more details' }}</h2>
        <p v-if="w.form?.intro">{{ w.form.intro }}</p>
        <FieldInput v-for="f in fieldsOf(w.form)" :key="f.name" :f="f" />
        <div><button class="dty-btn primary" type="submit">Send</button></div>
      </form>
    </template>
    <p v-if="error" class="dty-error">{{ error }}</p>
    <ShowValue v-if="run.status === 'succeeded'" :value="resultValue(run, source)" :display="display" :message="message" :columns="columns" :card="card" :plan="plan" :go="go" />
  </section>
</template>
`,
  'src/components/FormPage.vue': String.raw`<script setup lang="ts">
import { computed, ref } from 'vue';
import { coerce, formFields, type AppFlow, type Client, type Page, type Plan, type Run } from '../dittoly/core.js';
import FieldInput from './FieldInput.vue';
import RunPanel from './RunPanel.vue';
const props = defineProps<{ client: Client; page: Extract<Page, { kind: 'form' }>; flow: AppFlow; plan: Plan; go: (p: string) => void }>();
const fields = computed(() => formFields(props.flow, props.page.fields));
const pre = Object.fromEntries(new URLSearchParams(window.location.search));
const run = ref<Run | null>(null);
const busy = ref(false);
const error = ref('');
const submit = async (e: Event) => {
  const form = e.target as HTMLFormElement;
  const raw: Record<string, unknown> = {};
  for (const f of fields.value) {
    const el = form.elements.namedItem(f.name);
    if (el instanceof HTMLInputElement) raw[f.name] = f.widget === 'checkbox' ? el.checked : el.value;
    else if (el instanceof HTMLSelectElement) raw[f.name] = f.widget === 'multiselect' ? [...el.selectedOptions].map((o) => o.value) : el.value;
    else if (el instanceof HTMLTextAreaElement) raw[f.name] = el.value;
  }
  busy.value = true; error.value = ''; run.value = null;
  try { run.value = await props.client.settle(await props.client.startRun(props.page.flow, coerce(fields.value, raw))); } catch (err) { error.value = (err as { status?: number }).status === 401 ? 'Sign in to use this page.' : (err as Error).message; }
  busy.value = false;
};
</script>

<template>
  <div class="dty-stack">
    <form class="dty-form" @submit.prevent="submit">
      <FieldInput v-for="f in fields" :key="f.name" :f="f" :value="pre[f.name]" />
      <div><button class="dty-btn primary" type="submit" :disabled="busy">{{ busy ? 'Working…' : page.submitLabel }}</button></div>
    </form>
    <p v-if="error" class="dty-error">{{ error }}</p>
    <RunPanel v-if="run" :client="client" :run="run" :source="page.result.source" :display="page.result.display" :message="page.result.message" :columns="page.result.columns" :card="page.result.card" :plan="plan" :go="go" @change="(r) => (run = r)" />
  </div>
</template>
`,
  'src/components/ListPage.vue': String.raw`<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { resultValue, type Client, type Page, type Plan, type Run } from '../dittoly/core.js';
import RunPanel from './RunPanel.vue';
import ShowValue from './ShowValue.vue';
const props = defineProps<{ client: Client; page: Extract<Page, { kind: 'table' | 'cards' }>; plan: Plan; go: (p: string) => void }>();
const run = ref<Run | null>(null);
const error = ref('');
const query = ref('');
const load = async (extra: Record<string, unknown> = {}) => {
  run.value = null; error.value = '';
  try { run.value = await props.client.settle(await props.client.startRun(props.page.flow, { ...props.page.inputs, ...extra })); } catch (err) { error.value = (err as { status?: number }).status === 401 ? 'Sign in to see this page.' : (err as Error).message; }
};
const search = () => load(query.value && props.page.search ? { [props.page.search]: query.value } : {});
onMounted(() => load());
</script>

<template>
  <form v-if="page.search" class="dty-search" role="search" @submit.prevent="search">
    <input v-model="query" type="search" aria-label="Search" placeholder="Search" />
    <button class="dty-btn" type="submit">Search</button>
  </form>
  <p v-if="error" class="dty-error">{{ error }}</p>
  <p v-else-if="!run" class="dty-muted">Loading…</p>
  <ShowValue v-else-if="run.status === 'succeeded'" :value="resultValue(run, page.source)" :display="page.kind" :columns="page.columns" :card="page.card" :action="page.action" :plan="plan" :go="go" />
  <RunPanel v-else :client="client" :run="run" :source="page.source" :display="page.kind" :plan="plan" :go="go" @change="(r) => (run = r)" />
</template>
`,
  'src/components/InboxPage.vue': String.raw`<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { humanize, signOffText, type AppFlow, type Client, type InboxItem } from '../dittoly/core.js';
const props = defineProps<{ client: Client; flows: Map<string, AppFlow> }>();
const items = ref<InboxItem[] | null>(null);
const error = ref('');
const load = async () => { try { items.value = await props.client.inbox(); } catch (err) { error.value = (err as Error).message; } };
const decide = async (it: InboxItem, d: 'approved' | 'rejected') => { await props.client.decide(it.runId, it.stepId, d, it.signOff?.sha256); await load(); };
onMounted(() => { if (props.client.token) void load(); });
</script>

<template>
  <p v-if="!client.token" class="dty-notice">Sign in with the admin token to see what waits for you.</p>
  <p v-else-if="error" class="dty-error">{{ error }}</p>
  <p v-else-if="!items" class="dty-muted">Loading…</p>
  <p v-else-if="!items.length" class="dty-empty">Nothing is waiting for you.</p>
  <div v-else class="dty-stack">
    <article v-for="it in items" :key="it.runId + it.stepId" class="dty-card dty-stack">
      <h2>{{ (it.title ?? humanize(it.stepId)) + ' · ' + (flows.get(it.flow ?? '')?.name ?? it.flow ?? '') }}</h2>
      <p class="dty-muted">{{ new Date(it.createdAt).toLocaleString() }}</p>
      <template v-if="it.kind === 'approval' && it.signOff"><p class="dty-muted">Text an AI wrote could steer this step. Approving lets it run with exactly these values:</p><pre class="dty-values">{{ signOffText(it) }}</pre></template>
      <div v-if="it.kind === 'approval'" class="dty-row">
        <button class="dty-btn primary" type="button" @click="decide(it, 'approved')">Approve</button>
        <button class="dty-btn danger" type="button" @click="decide(it, 'rejected')">Reject</button>
      </div>
      <p v-else class="dty-muted">This run waits for a form; open it from the page that started it.</p>
    </article>
  </div>
</template>
`,
  'src/components/RunsPage.vue': String.raw`<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { humanize, type AppFlow, type Client } from '../dittoly/core.js';
const props = defineProps<{ client: Client; flows: Map<string, AppFlow> }>();
const runs = ref<Awaited<ReturnType<Client['runs']>> | null>(null);
const error = ref('');
onMounted(async () => { if (props.client.token) { try { runs.value = await props.client.runs(); } catch (err) { error.value = (err as Error).message; } } });
</script>

<template>
  <p v-if="!client.token" class="dty-notice">Sign in to see runs.</p>
  <p v-else-if="error" class="dty-error">{{ error }}</p>
  <p v-else-if="!runs" class="dty-muted">Loading…</p>
  <p v-else-if="!runs.length" class="dty-empty">No runs yet.</p>
  <div v-else class="dty-table-wrap"><table class="dty-table">
    <thead><tr><th>Flow</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead>
    <tbody><tr v-for="r in runs" :key="r.id"><td>{{ flows.get(r.flow ?? '')?.name ?? r.flow }}</td><td><span class="dty-status" :data-status="r.status">{{ humanize(r.status) }}</span></td><td>{{ new Date(r.createdAt).toLocaleString() }}</td><td>{{ r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '' }}</td></tr></tbody>
  </table></div>
</template>
`,
  'src/main.ts': String.raw`import { createApp } from 'vue';
import App from './App.vue';
import './theme.css';
import './app.css';

createApp(App).mount('#app');
`,
  'src/env.d.ts': String.raw`/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
`,
};
