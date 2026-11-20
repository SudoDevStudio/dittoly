import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, useAction, useLoad, When } from './components';
import { Icon } from './ui';

/**
 * A team's data tables: small tables its Flows read and write with table steps, so they can
 * remember things between runs. Team admins create tables and change columns; members edit rows.
 */

type ColumnType = 'text' | 'number' | 'boolean' | 'date';
interface Column { name: string; type: ColumnType }
interface Table { id: string; name: string; description: string | null; keyColumn: string; columns: Column[]; rowCount: number }
type Row = Record<string, unknown> & { updatedAt?: string };

const show = (v: unknown) => (v === null || v === undefined ? '' : v === true ? 'yes' : v === false ? 'no' : String(v));

export function TeamTablesCard({ team, canManage }: { team: { id: string; name: string }; canManage: boolean }) {
  const list = useLoad(() => api<Table[]>(`/teams/${team.id}/tables`), [team.id]);
  const act = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [keyColumn, setKeyColumn] = useState('key');
  const [columns, setColumns] = useState<Column[]>([{ name: 'status', type: 'text' }]);
  const table = list.data?.find((t) => t.id === open) ?? null;
  return (
    <Card title={<><Icon name="layers" />Data tables</>} actions={<span className="badge tone-info">{list.data?.length ?? 0}</span>}>
      <p className="muted">Tables this team's Flows read and write with a table step, to remember things between runs: tickets already handled, a counter, a list people keep. Rows are stored encrypted. Members change rows here; team admins create tables and change columns.</p>
      {list.data?.length ? (
        <ul className="list" aria-label="Data tables">
          {list.data.map((t) => (
            <li key={t.id}>
              <button className="ghost" onClick={() => setOpen(open === t.id ? null : t.id)}><strong>{t.name}</strong></button>
              <span className="muted">key: {t.keyColumn} · {t.columns.map((c) => `${c.name} (${c.type})`).join(', ') || 'no other columns'} · {t.rowCount} row(s)</span>
              {canManage ? <button className="danger" disabled={act.busy} onClick={() => act.run(async () => { await api(`/tables/${t.id}`, { method: 'DELETE' }); if (open === t.id) setOpen(null); list.reload(); }, 'Table removed')}>Remove</button> : null}
            </li>
          ))}
        </ul>
      ) : list.data ? <Empty>No data tables yet.</Empty> : null}
      {table ? <TableRows key={table.id} table={table} onChange={list.reload} /> : null}
      {canManage ? (
        <details>
          <summary>New table</summary>
          <div className="row">
            <div className="field"><label htmlFor="table-name">Table name</label><input id="table-name" placeholder="e.g. Handled tickets" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor="table-key">Key column (tells rows apart)</label><input id="table-key" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value.trim())} /></div>
          </div>
          <fieldset className="field">
            <legend>Other columns</legend>
            {columns.map((c, i) => (
              <div className="row" key={i}>
                <input aria-label={`Column ${i + 1} name`} value={c.name} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)))} />
                <select aria-label={`Column ${i + 1} type`} value={c.type} onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, type: e.target.value as ColumnType } : x)))}>
                  <option value="text">text</option><option value="number">number</option><option value="boolean">yes/no</option><option value="date">date</option>
                </select>
                <button className="ghost" onClick={() => setColumns(columns.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button className="ghost" onClick={() => setColumns([...columns, { name: '', type: 'text' }])}>Add a column</button>
          </fieldset>
          <button className="primary" disabled={act.busy || !name.trim()} onClick={() => act.run(async () => {
            await post('/tables', { teamId: team.id, name: name.trim(), keyColumn, columns: columns.filter((c) => c.name) });
            setName('');
            list.reload();
          }, 'Table created')}>Create table</button>
        </details>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

function TableRows({ table, onChange }: { table: Table; onChange: () => void }) {
  const [filter, setFilter] = useState({ column: '', equals: '' });
  const [applied, setApplied] = useState(filter);
  const rows = useLoad(
    () => api<{ rows: Row[] }>(`/tables/${table.id}/rows${applied.column ? `?column=${encodeURIComponent(applied.column)}&equals=${encodeURIComponent(applied.equals)}` : ''}`),
    [table.id, applied.column, applied.equals],
  );
  const act = useAction();
  const blank = () => Object.fromEntries([[table.keyColumn, ''], ...table.columns.map((c) => [c.name, ''])]) as Record<string, string>;
  const [edit, setEdit] = useState<Record<string, string>>(blank());
  const reload = () => { rows.reload(); onChange(); };
  return (
    <div>
      <div className="row">
        <select aria-label="Filter column" value={filter.column} onChange={(e) => setFilter({ ...filter, column: e.target.value })}>
          <option value="">All rows</option>
          {[table.keyColumn, ...table.columns.map((c) => c.name)].map((c) => <option key={c} value={c}>{c} equals…</option>)}
        </select>
        {filter.column ? <input aria-label="Filter value" value={filter.equals} onChange={(e) => setFilter({ ...filter, equals: e.target.value })} /> : null}
        <button onClick={() => setApplied(filter)}>Show</button>
      </div>
      {rows.data?.rows.length ? (
        <div className="table-wrap">
          <table aria-label={`Rows of ${table.name}`}>
            <thead><tr><th>{table.keyColumn}</th>{table.columns.map((c) => <th key={c.name}>{c.name}</th>)}<th>Changed</th><th /></tr></thead>
            <tbody>
              {rows.data.rows.map((r) => (
                <tr key={String(r[table.keyColumn])}>
                  <td><code>{show(r[table.keyColumn])}</code></td>
                  {table.columns.map((c) => <td key={c.name}>{show(r[c.name])}</td>)}
                  <td className="muted">{r.updatedAt ? <When at={r.updatedAt} /> : null}</td>
                  <td>
                    <button className="ghost" onClick={() => setEdit(Object.fromEntries([[table.keyColumn, show(r[table.keyColumn])], ...table.columns.map((c) => [c.name, show(r[c.name])])]))}>Edit</button>
                    <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/tables/${table.id}/rows?key=${encodeURIComponent(String(r[table.keyColumn]))}`, { method: 'DELETE' }), reload()), 'Row deleted')}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows.data ? <Empty>No rows{applied.column ? ' match' : ' yet'}.</Empty> : null}
      <fieldset className="field">
        <legend>Add or change a row</legend>
        <div className="row">
          {[table.keyColumn, ...table.columns.map((c) => c.name)].map((name) => (
            <div className="field" key={name}><label htmlFor={`row-${name}`}>{name}{name === table.keyColumn ? ' (key)' : ''}</label><input id={`row-${name}`} value={edit[name] ?? ''} onChange={(e) => setEdit({ ...edit, [name]: e.target.value })} /></div>
          ))}
        </div>
        <button className="primary" disabled={act.busy || !edit[table.keyColumn]} onClick={() => act.run(async () => {
          const { [table.keyColumn]: key, ...values } = edit;
          await api(`/tables/${table.id}/rows`, { method: 'PUT', body: { key, values } });
          setEdit(blank());
          reload();
        }, 'Row saved')}>Save row</button>
      </fieldset>
      <ErrorText>{rows.error ?? act.error}</ErrorText>
    </div>
  );
}
