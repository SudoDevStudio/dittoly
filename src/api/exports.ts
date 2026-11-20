import type { FastifyInstance, FastifyReply } from 'fastify';
import type { App } from '../app.js';
import { createExport, deleteTheme, listExports, listThemes, paletteBody, planExport, previewExport, reexport, reviewExport, saveTheme, suggestPalette, themeBody } from '../export/service.js';
import { me, parse, uuid } from './http.js';

/** Exported apps: brand themes, preview, page plan and the download. */
export function registerExportRoutes(api: FastifyInstance, app: App): void {
  api.get('/brand-themes', async (req) => listThemes(app.db, me(req)));
  api.post('/brand-themes', async (req, reply) => reply.status(201).send(await saveTheme(app.db, me(req), parse(themeBody, req.body))));
  api.put<{ Params: { id: string } }>('/brand-themes/:id', async (req) => saveTheme(app.db, me(req), parse(themeBody, req.body), parse(uuid, req.params.id)));
  api.delete<{ Params: { id: string } }>('/brand-themes/:id', async (req, reply) => {
    await deleteTheme(app.db, me(req), parse(uuid, req.params.id));
    return reply.status(204).send();
  });
  api.post('/brand-themes/palette', async (req) => suggestPalette(app, me(req), parse(paletteBody, req.body)));

  api.get('/app-exports', async (req) => listExports(app.db, me(req)));
  api.post('/app-exports/preview', async (req) => previewExport(app, me(req), req.body));
  api.post('/app-exports/plan', async (req) => planExport(app, me(req), req.body));
  api.get<{ Params: { id: string } }>('/app-exports/:id/changes', async (req) => reviewExport(app, me(req), parse(uuid, req.params.id)));
  const send = (reply: FastifyReply, out: Awaited<ReturnType<typeof createExport>>) =>
    reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('x-bundle-sha256', out.bundle.sha256)
      .send(out.archive);
  api.post('/app-exports', async (req, reply) => send(reply, await createExport(app, me(req), req.body)));
  api.post<{ Params: { id: string } }>('/app-exports/:id/reexport', async (req, reply) => send(reply, await reexport(app, me(req), parse(uuid, req.params.id))));
}
