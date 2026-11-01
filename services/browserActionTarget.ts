export class BrowserTargetError extends Error {
    constructor(readonly kind:'invalid'|'ambiguous'|'stale') { super(`browser_target_${kind}`); }
}
/** Validates action schema only. It never guesses the owner's website/task intent. */
export function validateBrowserTarget(target:string):void {
    if(typeof target!=='string'||!target.trim()||target.length>1400||/^(?:hover|click|fill|check|uncheck|select_option|locator|selector|body|html|\*)$/i.test(target.trim()))
        throw new BrowserTargetError('invalid');
}
import type { Locator } from 'playwright';
import { BrowserInterrupted } from './liveBrowserSession';

export async function runBrowserTargetAction<T>(target:string,build:()=>Locator[],action:(locator:Locator)=>Promise<T>):Promise<T> {
    validateBrowserTarget(target);
    let ambiguous=false;
    for(const locator of build()) {
        let selected:Locator|undefined;
        try {
            const count=await locator.count();
            if(count>20){ambiguous=true;continue;}
            const visible:Locator[]=[];
            for(let index=0;index<count;index++)if(await locator.nth(index).isVisible())visible.push(locator.nth(index));
            if(visible.length>1){ambiguous=true;continue;}
            selected=visible[0];
        } catch(error) { if(error instanceof BrowserInterrupted)throw error; continue; }
        if(!selected)continue;
        await selected.scrollIntoViewIfNeeded({timeout:3000});
        // Once an effect starts, propagate its error. It is not a stale-target validation failure.
        return action(selected);
    }
    throw new BrowserTargetError(ambiguous?'ambiguous':'stale');
}
