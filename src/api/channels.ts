import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { me, parse } from './http.js';

/** Linking Telegram and WhatsApp chats from the portal. */
export function registerChannelRoutes(api: FastifyInstance, app: App): void {
  api.get('/chat-channels', async () => ({ telegram: app.telegram !== null, whatsapp: app.whatsapp !== null }));
  api.post('/me/chat-links', async (req) => {
    const { channel } = parse(z.object({ channel: z.enum(['telegram', 'whatsapp']) }).strict(), req.body);
    const { code, expiresAt } = await app.chat.startLink(me(req), channel);
    if (channel === 'telegram') {
      const bot = await app.telegram!.botUsername();
      return { channel, expiresAt, url: `https://t.me/${bot}?start=${code}`, bot, code };
    }
    return { channel, expiresAt, url: app.whatsapp!.chatLink(`link ${code}`), code };
  });
}
