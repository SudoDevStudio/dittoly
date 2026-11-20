/** Portable definitions deliberately exclude approvals, credentials, schedules and run data. */
export interface ChildReference { flowId: string; version: number; name?: string }
export interface FlowFile { format: 'dittoly-flow'; formatVersion: 1; name: string; definition: Record<string, unknown> & { steps: Record<string, unknown>[] }; children: ChildReference[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function readFlowFile(value: unknown): FlowFile {
  if (!object(value)) throw new Error('Choose a Flow JSON object.');
  if (value.format !== undefined && (value.format !== 'dittoly-flow' || value.formatVersion !== 1)) throw new Error('Unsupported Flow export format.');
  const definition = value.definition ?? value;
  if (!object(definition) || !Array.isArray(definition.steps) || !definition.steps.every(object)) throw new Error('The file must contain a Flow definition with a steps array.');
  const children = new Map<string, ChildReference>();
  for (const step of definition.steps) {
    if (step.type !== 'flow') continue;
    if (!Array.isArray(step.runs)) throw new Error('A Super Flow stage must contain child runs.');
    for (const run of step.runs) {
      if (!object(run) || typeof run.flow !== 'string' || !Number.isInteger(run.version) || Number(run.version) < 1) throw new Error('Invalid child Flow reference.');
      const metadata = Array.isArray(value.children) ? value.children.find((c: unknown) => object(c) && c.flowId === run.flow && c.version === run.version) : undefined;
      children.set(`${run.flow}@${run.version}`, { flowId: run.flow, version: Number(run.version), ...(object(metadata) && typeof metadata.name === 'string' ? {name: metadata.name} : {}) });
    }
  }
  return {format: 'dittoly-flow',formatVersion: 1,name: typeof value.name === 'string' ? value.name : '',definition: definition as FlowFile['definition'],children: [...children.values()]};
}

export function remapChildren(file: FlowFile, mapping: Record<string, { flowId: string; version: number }>): FlowFile['definition'] {
  return {...file.definition, steps: file.definition.steps.map(step => step.type !== 'flow' ? step : {...step, runs: (step.runs as Record<string, unknown>[]).map(run => {
    const target = mapping[`${run.flow}@${run.version}`];
    if (!target) throw new Error('Choose an approved destination for every child Flow.');
    return {...run, flow: target.flowId, version: target.version};
  })})};
}
