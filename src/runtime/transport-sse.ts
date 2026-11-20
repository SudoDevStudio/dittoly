import { guardedFetch } from './egress.js';
import { parseSse, TransportError, type SseEvent, type TransportMaker } from './protocols.js';

/** Reading a server-sent event stream for a while. */
export const sse: TransportMaker<'sse'> = (policy, fetchImpl) =>
  async (url, t, opts) => {
    const fetchFn = fetchImpl ?? guardedFetch({ internalHosts: policy.internalHosts, loopbackHosts: policy.loopbackHosts });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.maxMs);
    const events: SseEvent[] = [];
    try {
      const res = await fetchFn(url, { method: 'GET', headers: { accept: 'text/event-stream', ...opts.headers }, redirect: 'manual', signal: controller.signal });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, events };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > opts.maxBytes) throw new TransportError('response_too_large', false);
          const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
          buffer = parsed.rest;
          for (const e of parsed.events) {
            events.push(e);
            if (events.length >= opts.maxEvents) return { status: res.status, events };
          }
        }
      } catch (err) {
        // Reaching the time limit ends the read normally with what arrived.
        if (!controller.signal.aborted) throw err;
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return { status: res.status, events };
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof TransportError)) return { status: 200, events };
      throw err;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
