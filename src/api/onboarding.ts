import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { onboarding, setOnboardingHidden } from '../onboarding/service.js';
import { me, parse } from './http.js';

/** The home page's "Get started" checklist. */
export function registerOnboardingRoutes(api: FastifyInstance, app: App): void {
  api.get('/onboarding', async (req) => onboarding(app, me(req)));
  api.put('/onboarding', async (req) => {
    const body = parse(z.object({ hidden: z.boolean() }).strict(), req.body);
    await setOnboardingHidden(app, me(req), body.hidden);
    return onboarding(app, me(req));
  });
}
