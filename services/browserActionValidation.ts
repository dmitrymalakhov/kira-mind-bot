import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { BrowserTargetError } from './browserActionTarget';

export class BrowserActionValidationError extends BrowserTargetError {
    constructor(readonly reason:'incomplete_evaluation'|'opaque_evaluation_arguments'|'unverifiable_action'|'malformed_action') { super('invalid'); }
}
const EVALUATION_BUDGET=12000;
export function reviewedEvaluation(method:string,args:unknown[]) {
    const index=method==='$eval'||method==='$$eval'?1:0,fn=args[index];
    const source=typeof fn==='function'?Function.prototype.toString.call(fn):typeof fn==='string'?fn:'';
    if(!source||source.length>EVALUATION_BUDGET)throw new BrowserActionValidationError('incomplete_evaluation');
    // Compilation is validation only: the source is never executed in the worker.
    try { new Script(`(${source})`); }catch{throw new BrowserActionValidationError('incomplete_evaluation');}
    // Dynamic parameters cannot be omitted from an effect review. Typed parent actions
    // already carry their exact values; unscoped helper scripts must replan as locators.
    if(args.slice(index+1).some(value=>value!==undefined))throw new BrowserActionValidationError('opaque_evaluation_arguments');
    return {source,sha256:createHash('sha256').update(source).digest('hex'),length:source.length,complete:true as const};
}
