import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { budgetBody, deletePrice, priceBody, setBudget, setPrice, usageReport } from '../ai/metering.js';
import { baselineBody, savings, setBaseline } from '../insights/savings.js';
import { insights, setManualMinutes } from '../insights/service.js';
import { me, parse, uuid } from './http.js';

/** Run insights and AI usage. */
export function registerInsightRoutes(api: FastifyInstance, app: App): void {
  api.get<{ Querystring: { days?: string; team?: string } }>('/insights', async (req) =>
    insights(app.db, me(req), Number(req.query.days ?? 30), req.query.team ? parse(uuid, req.query.team) : undefined),
  );
  // Proof of savings: what the Flows saved by not asking an AI every time.
  api.get<{ Querystring: { days?: string; team?: string } }>('/insights/savings', async (req) =>
    savings(app.db, me(req), Number(req.query.days ?? 30), req.query.team ? parse(uuid, req.query.team) : undefined),
  );
  api.put<{ Params: { id: string } }>('/flows/:id/ai-baseline', async (req, reply) => {
    await setBaseline(app.db, me(req), parse(uuid, req.params.id), parse(baselineBody, req.body));
    return reply.status(204).send();
  });
  api.put<{ Params: { id: string } }>('/flows/:id/manual-minutes', async (req, reply) => {
    const body = parse(z.object({ minutes: z.number().int().nullable() }).strict(), req.body);
    await setManualMinutes(app.db, me(req), parse(uuid, req.params.id), body.minutes);
    return reply.status(204).send();
  });

  api.get<{ Querystring: { month?: string } }>('/ai/usage', async (req) => usageReport(app.db, me(req), req.query.month));
  api.put<{ Params: { id: string } }>('/teams/:id/ai-budget', async (req, reply) => {
    await setBudget(app.db, me(req), parse(uuid, req.params.id), parse(budgetBody, req.body));
    return reply.status(204).send();
  });
  api.delete<{ Params: { id: string } }>('/teams/:id/ai-budget', async (req, reply) => {
    await setBudget(app.db, me(req), parse(uuid, req.params.id), null);
    return reply.status(204).send();
  });
  api.put('/ai/prices', async (req, reply) => {
    await setPrice(app.db, me(req), parse(priceBody, req.body));
    return reply.status(204).send();
  });
  api.delete<{ Querystring: { provider?: string; model?: string } }>('/ai/prices', async (req, reply) => {
    const q = parse(z.object({ provider: z.string().min(1).max(40), model: z.string().min(1).max(100) }).strict(), req.query);
    await deletePrice(app.db, me(req), q.provider, q.model);
    return reply.status(204).send();
  });
}
