import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { me, parse, uuid } from './http.js';

/** Watches: start a Flow for each new app item, email or file. */
export function registerWatchRoutes(api: FastifyInstance, app: App): void {
  api.get('/watches', async (req) => app.watches.list(me(req)));
  api.post('/watches', async (req, reply) => reply.status(201).send(await app.watches.create(req.body, me(req))));
  api.patch<{ Params: { id: string } }>('/watches/:id', async (req, reply) => {
    const body = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    await app.watches.setEnabled(parse(uuid, req.params.id), me(req), body.enabled);
    return reply.status(204).send();
  });
  api.delete<{ Params: { id: string } }>('/watches/:id', async (req, reply) => {
    await app.watches.remove(parse(uuid, req.params.id), me(req));
    return reply.status(204).send();
  });
  api.post<{ Params: { id: string } }>('/watches/:id/check', async (req) => app.watches.checkNow(parse(uuid, req.params.id), me(req)));
}
