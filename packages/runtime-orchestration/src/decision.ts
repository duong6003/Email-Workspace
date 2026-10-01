/** Product runtime execution only. Coding-agent policies live under .agents/. */
export type RuntimeMode='direct'|'batch-loop'|'delayed-job'|'workflow-dag';
export type WorkShape={steps:number;hasDependencies?:boolean;hasParallelFanout?:boolean;hasConditionalBranch?:boolean;runAt?:string;recurring?:boolean;repeatSameOperation?:boolean;maxIterations?:number};
export function chooseRuntimeMode(input:WorkShape):{primary:RuntimeMode;entry?:RuntimeMode;reason:string}{
  const graph=input.steps>=3&&(input.hasDependencies||input.hasParallelFanout||input.hasConditionalBranch);
  const scheduled=Boolean(input.runAt||input.recurring);
  if(graph&&scheduled)return{primary:'workflow-dag',entry:'delayed-job',reason:'Delay the persisted product workflow entry point'};
  if(graph)return{primary:'workflow-dag',reason:'Product runtime dependencies or fan-out/fan-in require persisted nodes'};
  if(scheduled)return{primary:'delayed-job',reason:'Product runtime execution depends on clock time or recurrence'};
  if(input.repeatSameOperation){if(!input.maxIterations)throw new Error('Bounded batch requires maxIterations');return{primary:'batch-loop',reason:'Uniform runtime batching with an explicit bound'};}
  return{primary:'direct',reason:'Single atomic action'};
}
