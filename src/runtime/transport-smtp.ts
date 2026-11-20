import { resolveChecked } from './egress.js';
import { within, type TransportMaker } from './protocols.js';

/** Sending email over SMTP. */
export const smtp: TransportMaker<'smtp'> = (policy) =>
  async (t, tls, login, msg, timeoutMs) => {
    const { address } = await resolveChecked(t.hostname, t.hostKeys, policy);
        const { default: nodemailer } = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: address,
      port: t.port,
      servername: t.hostname,
      secure: tls === 'implicit',
      requireTLS: tls === 'starttls',
      ignoreTLS: tls === 'none',
      tls: { servername: t.hostname, rejectUnauthorized: true },
      ...(login ? { auth: { user: login.username, pass: login.password } } : {}),
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const info = await within(timeoutMs, transport.sendMail({ ...msg, disableFileAccess: true, disableUrlAccess: true }));
      return { accepted: (info.accepted ?? []).map(String), rejected: (info.rejected ?? []).map(String) };
    } finally {
      transport.close();
    }
  };
