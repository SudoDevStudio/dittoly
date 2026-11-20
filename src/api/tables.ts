import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { defaultTeamFor } from '../core/teams.js';
import { me, parse, uuid } from './http.js';

/** Data tables (team admins create them and change columns; team members change rows), and Flow tests. */
export function registerTableRoutes(api: FastifyInstance, app: App): void {
  api.get<{ Params: { id: string } }>('/teams/:id/tables', async (req) => app.tables.list(me(req), parse(uuid, req.params.id)));
  // The tables a Flow can use: its team's (an existing Flow), a chosen team's, or the person's default team's.
  api.get<{ Querystring: { flowId?: string; teamId?: string } }>('/flow-tables', async (req) => {
    const actor = me(req);
    let team: string;
    if (req.query.flowId) {
      const flowId = parse(uuid, req.query.flowId);
      await app.flows.assertCanSee(app.db, actor, { flowId });
      team = (await app.db.query<{ team_id: string }>(`SELECT team_id FROM flows WHERE id = $1`, [flowId])).rows[0]!.team_id;
      return app.tables.inTeam(app.db, team);
    }
    team = req.query.teamId ? parse(uuid, req.query.teamId) : await defaultTeamFor(app.db, actor.id);
    return app.tables.list(actor, team);
  });
  api.post('/tables', async (req, reply) => reply.status(201).send(await app.tables.create(me(req), req.body)));
  api.put<{ Params: { id: string } }>('/tables/:id', async (req) => app.tables.setColumns(me(req), parse(uuid, req.params.id), req.body));
  api.delete<{ Params: { id: string } }>('/tables/:id', async (req, reply) => {
    await app.tables.remove(me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });
  api.get<{ Params: { id: string }; Querystring: { column?: string; equals?: string; limit?: string } }>('/tables/:id/rows', async (req) =>
    app.tables.portalRows(me(req), parse(uuid, req.params.id), {
      ...(req.query.column ? { column: req.query.column, equals: req.query.equals ?? '' } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    }),
  );
  // ---- Flow tests (recorded answers; no app is called)
  api.get<{ Params: { id: string } }>('/flows/:id/tests', async (req) => app.flowTests.list(me(req), parse(uuid, req.params.id)));
  api.post<{ Params: { id: string } }>('/flows/:id/tests', async (req, reply) => reply.status(201).send(await app.flowTests.save(me(req), parse(uuid, req.params.id), req.body)));
  api.put<{ Params: { id: string; testId: string } }>('/flows/:id/tests/:testId', async (req) =>
    app.flowTests.save(me(req), parse(uuid, req.params.id), req.body, parse(uuid, req.params.testId)),
  );
  api.delete<{ Params: { id: string; testId: string } }>('/flows/:id/tests/:testId', async (req, reply) => {
    await app.flowTests.remove(me(req), parse(uuid, req.params.id), parse(uuid, req.params.testId));
    return reply.status(204).send();
  });
  api.post<{ Params: { id: string } }>('/runs/:id/save-test', async (req, reply) => {
    const body = parse(z.object({ name: z.string() }).strict(), req.body);
    return reply.status(201).send(await app.flowTests.fromRun(me(req), parse(uuid, req.params.id), body.name));
  });
  api.get<{ Params: { id: string } }>('/flow-versions/:id/tests', async (req) => app.flowTests.results(me(req), parse(uuid, req.params.id)));

  api.put<{ Params: { id: string } }>('/tables/:id/rows', async (req) => app.tables.portalPut(me(req), parse(uuid, req.params.id), req.body));
  // Keys can hold any character, so the key travels in the query string.
  api.delete<{ Params: { id: string }; Querystring: { key?: string } }>('/tables/:id/rows', async (req, reply) => {
    await app.tables.portalDelete(me(req), parse(uuid, req.params.id), parse(z.string().min(1), req.query.key));
    return reply.status(204).send();
  });
}
