import { describe, expect, it } from 'vitest';
import { readFlowFile, remapChildren } from '../web/src/flow-transfer.js';

describe('portable Flow definitions', () => {
  it('round trips the definition but excludes execution and approval metadata', () => {
    const file = readFlowFile({name:'Example',definition:{inputs:{type:'object'},steps:[{id:'wait',type:'delay',seconds:1}]},status:'approved',injectionAccepted:[{sink:'write'}],credentials:{github:'secret'}});
    expect(readFlowFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(Object.keys(file).sort()).toEqual(['children','definition','format','formatVersion','name']);
  });
  it('supports existing example wrappers and raw definitions', () => {
    expect(readFlowFile({name:'Example',definition:{steps:[]}}).name).toBe('Example');
    expect(readFlowFile({steps:[]}).definition.steps).toEqual([]);
  });
  it.each([null, [], {steps:'bad'}, {steps:[null]}, {format:'dittoly-flow',formatVersion:2,definition:{steps:[]}}])('rejects invalid or unsupported files: %j', input => {
    expect(()=>readFlowFile(input)).toThrow();
  });
  it('maps pinned child versions in every stage while preserving IDs and inputs', () => {
    const file=readFlowFile({name:'Super',children:[{flowId:'old',version:2,name:'Child'}],definition:{steps:[{id:'first',type:'flow',runs:[{id:'one',flow:'old',version:2,input:{ticket:'{{ inputs.ticket }}'}}]},{id:'second',type:'flow',runs:[{id:'two',flow:'old',version:2,input:{}}]}]}});
    expect(file.children).toEqual([{flowId:'old',version:2,name:'Child'}]);
    expect(()=>remapChildren(file,{})).toThrow('Choose an approved destination');
    const mapped=remapChildren(file,{'old@2':{flowId:'new',version:4}});
    expect(mapped.steps[0]!.runs).toEqual([{id:'one',flow:'new',version:4,input:{ticket:'{{ inputs.ticket }}'}}]);
    expect(mapped.steps[1]!.runs).toEqual([{id:'two',flow:'new',version:4,input:{}}]);
    expect((file.definition.steps[0]!.runs as {flow:string}[])[0]!.flow).toBe('old');
  });
  it('rejects malformed child versions instead of importing silently', () => {
    expect(()=>readFlowFile({steps:[{type:'flow',runs:[{flow:'old',version:0}]}]})).toThrow('Invalid child Flow reference');
  });
});
