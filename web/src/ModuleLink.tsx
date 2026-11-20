import { useEffect, useState } from 'react';
import { api } from './api';
import { ErrorText, Loading } from './components';
import { Link, navigate } from './router';

/**
 * Links to a module by its ref ("github@1.0.4") or name ("github"), wherever one is mentioned: the /module/<ref> page
 * looks up that version (or the newest one of the name) and opens its page.
 */
export function ModuleLink({ refText, children, className }: { refText: string; children?: React.ReactNode; className?: string }) {
  return (
    <Link to={`/module/${encodeURIComponent(refText)}`} className={className} title={`Open the module ${refText}`}>
      {children ?? refText}
    </Link>
  );
}

const REF = /\b([a-z][a-z0-9-]{1,39}@\d+\.\d+\.\d+)\b/g;

/** Text with every module ref in it ("github@1.0.4") as a link to that module. */
export function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<ModuleLink key={m.index} refText={m[1]!} />);
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** /module/<ref>: opens the module version the ref names, or the newest version of the name. */
export function ModuleByRef({ refText }: { refText: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    void api<{ id: string; name: string; version: string; createdAt?: string }[]>('/modules')
      .then((all) => {
        if (stop) return;
        const [name, version] = refText.split('@');
        const exact = version ? all.find((m) => m.name === name && m.version === version) : undefined;
        const newest = all.filter((m) => m.name === name).at(-1);
        const hit = exact ?? newest;
        if (hit) {
          navigate(`/modules/${hit.id}`, { replace: true });
        } else setError(`No module named "${refText}".`);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      stop = true;
    };
  }, [refText]);
  return error ? <ErrorText>{error}</ErrorText> : <Loading />;
}
