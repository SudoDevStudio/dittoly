import { useEffect, useState } from 'react';
import { api } from './api';
import { detectMedia, type Media } from './media';
import { Link } from './router';

interface Embeddable {
  hosts: string[];
  /** Sites approved browser modules open. */
  pages: string[];
}

/** The organization's allowed media hosts and browser sites, loaded once per page load. */
let hostsPromise: Promise<Embeddable> | null = null;
function loadHosts(): Promise<Embeddable> {
  hostsPromise ??= api<Partial<Embeddable>>('/settings/media').then(
    (r) => ({ hosts: r.hosts ?? [], pages: r.pages ?? [] }),
    () => ({ hosts: [], pages: [] }),
  );
  return hostsPromise;
}
/** After an admin changes the list. */
export function forgetMediaHosts(): void {
  hostsPromise = null;
}

export function useMediaHosts(): Embeddable | null {
  const [hosts, setHosts] = useState<Embeddable | null>(null);
  useEffect(() => {
    let live = true;
    void loadHosts().then((h) => live && setHosts(h));
    return () => {
      live = false;
    };
  }, []);
  return hosts;
}

function Player({ m }: { m: Media }) {
  switch (m.kind) {
    case 'youtube':
    case 'vimeo':
      return (
        <div className="media-frame video">
          {/* Players get the page's origin as referrer (YouTube refuses to play without one), nothing more. */}
          <iframe
            src={m.src}
            title={m.title}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
      );
    case 'video':
      return <video className="media-video" src={m.src} controls preload="metadata" />;
    case 'audio':
      return <audio className="media-audio" src={m.src} controls preload="metadata" />;
    case 'image':
      return <img className="media-image" src={m.src} alt={m.title} loading="lazy" referrerPolicy="no-referrer" />;
    case 'pdf':
      return (
        <div className="media-frame document">
          <iframe src={m.src} title={m.title} loading="lazy" referrerPolicy="no-referrer" />
        </div>
      );
    case 'live':
      return (
        <div className="media-frame document live">
          {/* The page a browser script ended on, loaded fresh in the viewer's browser. */}
          <iframe src={m.src} title={`Live page: ${m.title}`} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
        </div>
      );
    case 'page':
      return (
        <div className="media-frame document">
          {/* Another site's page: sandboxed, so it cannot navigate this page or open dialogs. */}
          <iframe src={m.src} title={m.title} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation" />
        </div>
      );
  }
}

/** A link, and below it the player, image or page when the link is media from an allowed source. */
export function LinkOrMedia({ url }: { url: string }) {
  const hosts = useMediaHosts();
  const media = hosts ? detectMedia(url, hosts.hosts, hosts.pages) : null;
  const link = (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {url}
    </a>
  );
  if (!media) return link;
  return (
    <div className="media">
      <Player m={media} />
      <div className="media-caption">
        {link}
        {media.kind === 'live' ? (
          <>
            <span className="muted"> · Live page, loaded now in your browser (you may need to sign in to the site). If it stays blank, the site does not allow being shown inside other pages: </span>
            <Link to={`/browser?url=${encodeURIComponent(url)}`}>open it in the Dittoly browser</Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
