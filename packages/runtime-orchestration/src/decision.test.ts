import {describe,expect,it} from 'vitest';import{chooseRuntimeMode}from'./decision.js';
describe('chooseRuntimeMode for product workflows',()=>{
  it('composes a delayed product DAG',()=>expect(chooseRuntimeMode({steps:8,hasDependencies:true,runAt:'2026-08-11T02:00:00Z'})).toMatchObject({primary:'workflow-dag',entry:'delayed-job'}));
  it('rejects an unbounded runtime batch',()=>expect(()=>chooseRuntimeMode({steps:1,repeatSameOperation:true})).toThrow(/maxIterations/));
  it('uses direct for an atomic runtime action',()=>expect(chooseRuntimeMode({steps:1}).primary).toBe('direct'));
});
