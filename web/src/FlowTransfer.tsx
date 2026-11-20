import { useRef, useState } from 'react';
import { api, post } from './api';
import { Card, ErrorText, useAction, useLoad } from './components';
import { readFlowFile, remapChildren, type FlowFile } from './flow-transfer';
import { navigate } from './router';
import { teamQuery, useTeams } from './teams';
import { Icon } from './ui';
import type { Runnable } from './pages/RunHub';

/** `name` is undefined until the Flow's name has loaded; the button waits for it. */
export function ExportFlow({ versionId, name }: { versionId: string; name: string | undefined }) {
  const act = useAction();
  return <><button type="button" disabled={act.busy || !name} onClick={() => name && act.run(async () => {
    const review = await api<{definition: FlowFile['definition']; flows?: FlowFile['children']}>(`/flow-versions/${versionId}/review`);
    const file = readFlowFile({name, definition: review.definition, children: review.flows ?? []});
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], {type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = `${name.replace(/[^a-z0-9_-]+/gi, '-').slice(0,80) || 'flow'}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  })}><Icon name="download" size={16}/>Export JSON</button><ErrorText>{act.error}</ErrorText></>;
}

export function ImportFlow({ superOnly = false }: { superOnly?: boolean }) {
  const {current:team} = useTeams();
  const [file,setFile] = useState<FlowFile | null>(null);
  // Destinations are only needed to map a Super Flow's children; load them once such a file is chosen.
  const needsTargets = !!file?.children.length;
  const targets = useLoad(() => needsTargets ? api<Runnable[]>(`/runnable${teamQuery(team)}`) : Promise.resolve([]),[team, needsTargets]);
  const picked = useRef(0);
  const [name,setName] = useState('');
  const [mapping,setMapping] = useState<Record<string,string>>({});
  const [error,setError] = useState('');
  const act = useAction();
  const available = targets.data?.filter(r => !r.blocked) ?? [];
  return <Card title={`Import ${superOnly ? 'a Super Flow' : 'a Flow'} from JSON`}>
    <p className="muted">Creates a new draft in the selected team. Required modules must already be available. Approvals, credentials, endpoints and schedules are configured separately. Super Flow files reference child Flows; they do not include their definitions.</p>
    <label className="field">Flow JSON file<input type="file" accept=".json,application/json" onChange={async e => {
      const target = e.target; const input = target.files?.[0]; setFile(null); setError(''); setMapping({});
      const pick = ++picked.current;
      if (!input) return;
      try {
        if (input.size > 2_000_000) throw new Error('Choose a JSON file smaller than 2 MB.');
        const parsed = readFlowFile(JSON.parse(await input.text()));
        if (superOnly && !parsed.children.length) throw new Error('This file is a regular Flow. Import it from Flow Studio.');
        if (pick !== picked.current) return; // a newer file was chosen meanwhile
        setFile(parsed);setName(parsed.name);
      } catch(err) {
        if (pick !== picked.current) return;
        setError(err instanceof Error ? err.message : 'Could not read this file.');
        target.value = ''; // so choosing the same file again (after fixing it) reads it again
      }
    }}/></label>
    {file ? <form className="form-grid" onSubmit={e => {e.preventDefault();act.run(async () => {
      const destinations = Object.fromEntries(file.children.map(c => {
        const key = `${c.flowId}@${c.version}`;
        const selected = available.find(r => r.versionId === mapping[key]);
        if (!selected) throw new Error('Choose an approved destination for every child Flow.');
        return [key, {flowId:selected.flowId,version:selected.version}];
      }));
      const created = await post<{flowId:string}>('/flows',{name:name.trim(),definition:remapChildren(file,destinations),...(team ? {teamId:team} : {})});
      navigate(`/flows/${created.flowId}`);
    });}}>
      <label className="field">Name<input required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>
      {file.children.map(c => {const key = `${c.flowId}@${c.version}`;return <label className="field" key={key}>Destination for {c.name ?? c.flowId} (v{c.version})<select required value={mapping[key] ?? ''} onChange={e=>setMapping({...mapping,[key]:e.target.value})}><option value="">Choose an approved Flow version</option>{available.map(r=><option key={r.versionId} value={r.versionId}>{r.name} - v{r.version}</option>)}</select></label>;})}
      {file.children.length ? <><ErrorText>{targets.error}</ErrorText><p className="muted">Import and approve missing child Flows first, then map them here. The server validates their input contracts.</p></> : null}
      <div><button className="primary" disabled={act.busy || !name.trim()} type="submit">Import as draft</button></div>
    </form> : null}
    <ErrorText>{error || act.error}</ErrorText>
  </Card>;
}
