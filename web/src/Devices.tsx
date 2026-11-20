import { useEffect, useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, useAction, useLoad, When } from './components';
import { toast } from './toast';
import { Icon, Notice } from './ui';

interface Device { id: string; name: string; member: string; createdAt: string; lastSeenAt: string | null; expiresAt: string }
interface Pairing { url: string; expiresAt: string; qrSvg: string; reachable: boolean; voice: boolean }

/**
 * Connect a phone (and the glasses paired to it): scan a one-time QR code; the phone
 * gets its own session for commands only, which you can revoke here.
 */
export function DevicesCard() {
  const devices = useLoad(() => api<Device[]>('/devices'));
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const act = useAction();

  // While the code is shown: count down, and notice when the phone has connected.
  useEffect(() => {
    if (!pairing) return;
    const known = devices.data?.length ?? 0;
    const tick = setInterval(() => {
      const s = Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setPairing(null);
    }, 1000);
    const poll = setInterval(async () => {
      const list = await api<Device[]>('/devices').catch(() => null);
      if (list && list.length > known) {
        devices.setData(list);
        setPairing(null);
        toast('success', `${list[0]?.name ?? 'Phone'} connected`);
      }
    }, 2500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing]);

  return (
    <Card title={<><Icon name="phone" />Phone, glasses & chat apps</>} actions={<span className="badge tone-info">{devices.data?.length ?? 0} connected</span>}>
      <p className="muted">
        Give commands from your phone, or from Meta glasses paired to it: “run release notes for 2.4”, “what is waiting for me?”, “approve it”.
        Nothing changes until you say yes. The phone can only send commands, never see your credentials or change Flows.
      </p>
      {pairing ? (
        <div className="pairing">
          <div className="qr" role="img" aria-label="QR code to connect a phone" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <div className="pairing-text">
            <p><strong>Scan with your phone's camera.</strong> The code works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
            <p className="muted">Or open this link on the phone: <a href={pairing.url} className="pre-wrap" rel="noreferrer">{pairing.url}</a></p>
            {!pairing.reachable ? (
              <p className="error" role="alert">
                Your phone cannot open <code>{new URL(pairing.url).origin}</code>: Dittoly only listens on this computer. Restart it so it listens on your network with <code>npm start -- --host=0.0.0.0</code> (or set <code>HOST=0.0.0.0</code> in <code>.env</code>), or use a tunnel, then show a new code. The phone must be on the same Wi-Fi.
              </p>
            ) : null}
            {!pairing.voice ? <p className="muted">This address is not https, so the phone cannot use its microphone: commands are typed there (keyboard dictation works). Voice needs Dittoly on https.</p> : null}
            <button type="button" className="ghost" onClick={() => setPairing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="primary" disabled={act.busy} onClick={() => act.run(async () => {
          const p = await post<Pairing>('/devices/pair', { origin: location.origin });
          setLeft(Math.round((new Date(p.expiresAt).getTime() - Date.now()) / 1000));
          setPairing(p);
        })}>
          <Icon name="plus" size={15} />Connect a phone
        </button>
      )}
      <ErrorText>{act.error ?? devices.error}</ErrorText>
      {devices.data?.length ? (
        <ul className="list">
          {devices.data.map((d) => (
            <li key={d.id}>
              <span className="status-dot" />
              <strong>{d.name}</strong>
              <span className="muted">{d.lastSeenAt ? <>used <When at={d.lastSeenAt} /></> : 'not used yet'} · until <When at={d.expiresAt} /></span>
              <button type="button" className="danger" disabled={act.busy} onClick={() => act.run(async () => { await api(`/devices/${d.id}`, { method: 'DELETE' }); devices.reload(); }, `${d.name} disconnected`)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : devices.data ? <Empty>No phone connected.</Empty> : null}
      <ChatLinks onLinked={() => devices.reload()} />
      <Notice>With Meta glasses: pair them with your phone as usual (Bluetooth). Dittoly hears you through the glasses' microphone and answers through their speakers. On Ray-Ban Display glasses, the phone page also fits their small screen.</Notice>
    </Card>
  );
}

interface ChatLink { channel: 'telegram' | 'whatsapp'; url: string; code: string; expiresAt: string }

/** Telegram and WhatsApp, when the server has them: a one-time link opens the chat with the code filled in. */
function ChatLinks({ onLinked }: { onLinked: () => void }) {
  const channels = useLoad(() => api<{ telegram: boolean; whatsapp: boolean }>('/chat-channels'));
  const [link, setLink] = useState<ChatLink | null>(null);
  const act = useAction();
  if (!channels.data || (!channels.data.telegram && !channels.data.whatsapp)) return null;
  const start = (channel: ChatLink['channel']) =>
    act.run(async () => setLink(await post<ChatLink>('/me/chat-links', { channel })));
  return (
    <div className="chat-links">
      <h3>Chat apps</h3>
      <p className="muted">Write the same commands in a private chat with the organization's bot. Questions that change something come with Yes / No buttons.</p>
      <div className="row">
        {channels.data.telegram ? <button type="button" disabled={act.busy} onClick={() => start('telegram')}><Icon name="plus" size={15} />Connect Telegram</button> : null}
        {channels.data.whatsapp ? <button type="button" disabled={act.busy} onClick={() => start('whatsapp')}><Icon name="plus" size={15} />Connect WhatsApp</button> : null}
      </div>
      {link ? (
        <p role="status">
          {link.channel === 'telegram'
            ? <>Open <a href={link.url} target="_blank" rel="noreferrer">this link</a> on the device with Telegram and press <strong>Start</strong>.</>
            : <>Open <a href={link.url} target="_blank" rel="noreferrer">this link</a> on your phone and send the message (<code>link {link.code}</code>).</>}{' '}
          It works once, until <When at={link.expiresAt} />.{' '}
          <button type="button" className="ghost" onClick={() => { setLink(null); onLinked(); }}>Done</button>
        </p>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
