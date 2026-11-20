import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppBundle, Framework } from '../src/export/bundle.js';
import { checkPlan, planFlows, uiPlanSchema } from '../src/export/frontend/plan.js';
import { FRONTEND_OUT, frontendFiles } from '../src/export/frontend/templates.js';
import { deriveTheme } from '../src/export/theme.js';

/**
 * Every framework template really installs and builds (with type checks where the framework
 * runs them). Slow and needs the npm registry: in CI (its own job) or with TEST_FRONTEND_BUILD=1.
 */
const dir = mkdtempSync(path.join(tmpdir(), 'dty-fe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const flows = planFlows(
  [
    { key: 'list-products', name: 'List products', description: '', access: 'public', exposed: true, definition: { inputs: { type: 'object', properties: { q: { type: 'string' } } }, steps: [{ id: 'list', type: 'action' }] } },
    { key: 'place-order', name: 'Place order', description: '', access: 'public', exposed: true, definition: { inputs: { type: 'object', properties: { product_id: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['product_id', 'quantity'] }, steps: [{ id: 'order', type: 'action' }, { id: 'ok', type: 'approval' }] } },
  ],
  [],
);
const plan = uiPlanSchema.parse({
  layout: { nav: 'sidebar-left', width: 'wide' },
  home: 'home',
  pages: [
    { id: 'home', kind: 'home', title: 'Home', path: '/', headline: 'Fresh goods', text: 'Order online.', links: ['products'] },
    { id: 'products', kind: 'cards', title: 'Products', path: '/products', flow: 'list-products', source: { step: 'list', path: 'items' }, card: { title: 'name', image: 'image', price: 'price' }, action: { label: 'Buy', page: 'checkout', fill: { product_id: 'id' } }, search: 'q' },
    { id: 'checkout', kind: 'form', title: 'Checkout', path: '/checkout', flow: 'place-order', submitLabel: 'Place order', result: { display: 'message', message: 'Thanks!' } },
    { id: 'inbox', kind: 'inbox', title: 'Waiting', path: '/inbox' },
    { id: 'runs', kind: 'runs', title: 'Runs', path: '/runs' },
  ],
});

describe.skipIf(!process.env.TEST_FRONTEND_BUILD)('framework templates build', () => {
  it('the plan used fits its Flows', () => expect(checkPlan(plan, flows)).toEqual([]));
  for (const framework of ['react', 'vue', 'next', 'angular', 'astro'] as Framework[]) {
    it(framework, () => {
      const b = { name: 'Shop', slug: 'shop', theme: deriveTheme({ name: 'Shop', primary: '#0f766e', font: 'geometric', radius: 'large' }), frontend: { framework, plan } } as unknown as AppBundle;
      const root = path.join(dir, framework);
      for (const f of frontendFiles(b)) {
        mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
        writeFileSync(path.join(root, f.path), f.content);
      }
      const run = (args: string[]) => execFileSync('npm', args, { cwd: root, stdio: 'pipe', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1' } });
      run(['install', '--no-audit', '--no-fund']);
      run(['run', 'build']);
      if (framework === 'react' || framework === 'vue') run(['run', 'typecheck']);
      expect(existsSync(path.join(root, FRONTEND_OUT[framework], 'index.html'))).toBe(true);
    }, 600_000);
  }
});
