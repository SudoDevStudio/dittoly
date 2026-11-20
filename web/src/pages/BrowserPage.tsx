import { useState } from 'react';
import { api, post } from '../api';
import { Card, ErrorText, Loading, Page, useAction, useLoad } from '../components';
import { useMe } from '../context';
import { LiveBrowser } from '../LiveBrowser';
import { navigate } from '../router';

/**
 * A browser on the server that you drive from here: for pages that cannot be
 * shown inside Dittoly, and for screenshots. It opens only the sites approved
 * browser modules declare and the ones an admin adds here, and closes a few
 * minutes after you leave. Run views link here; it is not in the sidebar.
 */

interface Sites { fromModules: string[]; added: string[] }

const isPattern = (h: string) => h.startsWith('*.');

export function BrowserPage({ id }: { id?: string }) {
  const params = new URLSearchParams(location.search);
  const [url, setUrl] = useState(params.get('url') ?? '');
  const act = useAction();
  const sites = useLoad(() => api<Sites>('/browser-sites'));
  const open = (address: string) => act.run(async () => navigate(`/browser/${(await post<{ id: string }>('/live', { url: address })).id}`));
  return (
    <Page title="Dittoly Browser" eyebrow="WORKSPACE / BROWSER" description="A browser on the Dittoly server, shown live. It opens the sites listed below.">
      {id ? (
        <Card>
          <LiveBrowser id={id} kind="page" onClosed={() => navigate('/browser')} />
        </Card>
      ) : (
        <>
          <Card title="Open a page">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                open(url);
              }}
            >
              <input aria-label="Page address" type="url" required placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="primary" type="submit" disabled={act.busy}>
                {act.busy ? 'Opening…' : 'Open'}
              </button>
            </form>
            <ErrorText>{act.error}</ErrorText>
          </Card>
          {sites.data ? <SitesCard sites={sites.data} busy={act.busy} open={open} reload={sites.reload} /> : <Loading />}
        </>
      )}
    </Page>
  );
}

function SitesCard({ sites, busy, open, reload }: { sites: Sites; busy: boolean; open: (url: string) => void; reload: () => void }) {
  const { me } = useMe();
  const admin = me.role === 'admin';
  const all = [...new Set([...sites.fromModules, ...sites.added])].sort();
  return (
    <Card title="Sites it can open">
      {all.length ? (
        <div className="row">
          {all.map((h) =>
            isPattern(h) ? (
              <code key={h} title="Any site under this domain">{h}</code>
            ) : (
              <button key={h} type="button" className="ghost" disabled={busy} onClick={() => open(`https://${h}`)}>
                {h}
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="muted">No site yet. {admin ? 'Add the sites people may open below.' : 'Ask an admin to add the sites you need.'}</p>
      )}
      <p className="muted">
        Sites come from approved browser modules{sites.fromModules.length ? ` (${sites.fromModules.length})` : ''} and from the list an admin keeps here
        {sites.added.length ? ` (${sites.added.length})` : ''}. Pages on other sites, and anything they load from them, are blocked.
      </p>
      {admin ? <AllowedSitesForm added={sites.added} reload={reload} /> : null}
    </Card>
  );
}

/** Admins: the sites people may open here, besides those of approved browser modules. */
function AllowedSitesForm({ added, reload }: { added: string[]; reload: () => void }) {
  const act = useAction();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? added.join('\n');
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          await api('/browser-sites', { method: 'PUT', body: { hosts: value.split(/[\s,]+/).filter(Boolean) } });
          setText(null);
          reload();
        }, 'Allowed sites saved');
      }}
    >
      <div className="field">
        <label htmlFor="browser-sites">Allowed sites (admins)</label>
        <textarea id="browser-sites" rows={4} value={value} placeholder={'example.com\n*.example.com'} onChange={(e) => setText(e.target.value)} />
        <span className="muted">One per line: a host such as <code>status.example.com</code>, or <code>*.example.com</code> for every site under it. Browser modules&apos; scripts still open only the sites their own reviewed manifest declares.</span>
      </div>
      <div>
        <button type="submit" className="primary" disabled={act.busy || text === null}>
          Save sites
        </button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </form>
  );
}
