import type { Locator, Page } from 'playwright';
import { BrowserInterrupted } from './liveBrowserSession';
import { BrowserTargetError } from './browserActionTarget';

export interface BrowserTextFieldState { value:string; autocomplete:boolean; expanded:boolean; selectedValue?:string; }
export interface BrowserFieldDescriptor { label:string;type:string;name:string;autocomplete:string; }
export type BrowserSecretFieldKind='login'|'otp'|'payment';
export function browserSecretField(field:BrowserFieldDescriptor):BrowserSecretFieldKind|undefined {
    const text=[field.label,field.type,field.name,field.autocomplete].join(' ');
    if(field.type==='password'||field.autocomplete==='username'||/password|парол/iu.test(text))return 'login';
    if(/sms|смс|одноразов|otp|2fa|two[-\s]?factor|one-time-code|код\s+(?:из|подтверждения|безопасности)/iu.test(text))return 'otp';
    if(/cc-|card\s+number|номер\s+карт|банковск\w*\s+карт|cvv|cvc|expiry|срок\s+действия/iu.test(text))return 'payment';
    return;
}
export async function browserFieldDescriptor(control:Locator):Promise<BrowserFieldDescriptor> {
    return control.evaluate((field:HTMLInputElement)=>({
        label:field.getAttribute('aria-label')||(field.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ').trim()||String(Array.from(field.labels??[]).map(label=>label.textContent??'').join(' '))||field.getAttribute('placeholder')||'',
        type:field.getAttribute('type')||field.tagName.toLowerCase(),name:field.getAttribute('name')||'',autocomplete:field.getAttribute('autocomplete')||'',
    }));
}
export function protectedBrowserField(field:BrowserFieldDescriptor):boolean {
    if(['email','tel','password'].includes(field.type.toLowerCase()))return true;
    const text=[field.label,field.name,field.autocomplete].join(' ');
    return /(?:^|[^\p{L}])(?:name|full[_ -]?name|first[_ -]?name|last[_ -]?name|phone|tel|email|e-mail|contact|participants|players|team|referral|message_source|lead_source)(?=$|[^\p{L}])|(?:имя|фио|фамили|телефон|почт|контакт|название\s+команд|количество\s+участник|откуда\s+узнал)/iu.test(text);
}
export async function browserTextFieldState(control:Locator|any):Promise<BrowserTextFieldState> {
    return control.evaluate((element:HTMLElement)=>{
        const input=element as HTMLInputElement;
        const value=input.value??element.innerText??'';
        return {value,autocomplete:element.getAttribute('role')==='combobox'||Boolean(element.getAttribute('aria-autocomplete')||element.getAttribute('list')||element.getAttribute('aria-haspopup')==='listbox'),
            expanded:element.getAttribute('aria-expanded')==='true',selectedValue:element.getAttribute('data-selected-id')??element.getAttribute('data-selected-value')??undefined};
    });
}
export interface BrowserOptionContext { ownerId?:string;controls:string;label:string;canonicalValue?:string; }
export async function browserOptionContext(option:Locator):Promise<BrowserOptionContext|undefined> {
    return option.evaluate(element=>{
        if(element.getAttribute('role')!=='option')return;
        const list=element.closest('[role="listbox"]'),id=list?.id;if(!id)return;
        const owners=Array.from(document.querySelectorAll<HTMLElement>('[aria-controls],[aria-owns]')).filter(field=>
            [field.getAttribute('aria-controls'),field.getAttribute('aria-owns')].some(value=>value?.split(/\s+/).includes(id)));
        if(owners.length!==1)return;
        return {ownerId:owners[0].id||undefined,controls:id,label:(element.textContent??'').replace(/\s+/g,' ').trim().slice(0,180),
            canonicalValue:element.getAttribute('data-value')??element.getAttribute('data-id')??element.getAttribute('value')??undefined};
    });
}
export async function verifyBrowserOptionSelection(page:Page,context:BrowserOptionContext) {
    // Observe explicit component state, not the mere presence of typed text.
    return page.evaluate(({ownerId,controls,label,canonicalValue})=>{
        const fields=ownerId?[document.getElementById(ownerId)].filter(Boolean):Array.from(document.querySelectorAll<HTMLElement>('[aria-controls],[aria-owns]')).filter(field=>
            [field.getAttribute('aria-controls'),field.getAttribute('aria-owns')].some(value=>value?.split(/\s+/).includes(controls)));
        if(fields.length!==1)return {verified:false};
        const field=fields[0] as HTMLInputElement;
        const selected=field.getAttribute('data-selected-id')??field.getAttribute('data-selected-value')??undefined;
        const linked=ownerId?Array.from(document.querySelectorAll<HTMLInputElement>('[data-selection-for]')).filter(item=>item.getAttribute('data-selection-for')===ownerId).map(item=>item.value):[];
        const comparable=[selected,...linked].filter((value):value is string=>value!==undefined);
        const canonicalMismatch=Boolean(canonicalValue&&comparable.some(value=>value!==canonicalValue));
        const canonical=canonicalValue&&comparable.length&&!canonicalMismatch?canonicalValue:undefined;
        const value=field.value??field.innerText??'';
        const closed=field.getAttribute('aria-expanded')==='false';
        return {verified:!canonicalMismatch&&Boolean(canonical||closed&&value.trim()===label.trim()),value,canonicalValue:canonical,selectedValue:selected,canonicalMismatch};
    },context);
}
/** Native input events only. A query remains a query until a concrete option is selected. */
export async function fillBrowserTextField(control:Locator|any,value:string,sequential=false):Promise<BrowserTextFieldState> {
    try {
        if(sequential) {
            await control.fill('',{timeout:10000});
            if(typeof control.pressSequentially==='function')await control.pressSequentially(value,{delay:20,timeout:10000});
            else await control.type(value,{delay:20,timeout:10000});
        }else await control.fill(value,{timeout:10000});
        const state=await browserTextFieldState(control);
        if(!state.value&&value)throw new BrowserTargetError('stale');
        return state;
    }catch(error){if(error instanceof BrowserInterrupted||error instanceof BrowserTargetError)throw error;throw new BrowserTargetError('stale');}
}
export async function browserAutocompleteSnapshot(page:Page):Promise<string> {
    const data=await page.evaluate(()=>{
        const text=(element:Element|null)=>String((element as HTMLElement|null)?.innerText??element?.textContent??'').replace(/\s+/g,' ').trim().slice(0,160);
        const visible=(element:Element)=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
        return Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-autocomplete],[role="combobox"],input[list],[aria-haspopup="listbox"]')).filter(visible).slice(0,12).map(field=>{
            const label=field.getAttribute('aria-label')||Array.from(field.labels??[]).map(text).join(' ')||field.getAttribute('placeholder')||field.id||field.name;
            const controls=field.getAttribute('aria-controls')||field.getAttribute('aria-owns')||field.getAttribute('list')||'';
            const roots=controls.split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)).filter((list):list is HTMLElement=>Boolean(list)&&visible(list!));
            const options=roots.flatMap(root=>Array.from(root.querySelectorAll('[role="option"],option'))).filter(visible).slice(0,16).map(option=>({label:text(option),id:option.id||undefined,selected:option.getAttribute('aria-selected')==='true',value:option.getAttribute('data-value')??option.getAttribute('data-id')??undefined}));
            const selectedValue=field.getAttribute('data-selected-id')??field.getAttribute('data-selected-value')??undefined;
            return {label,id:field.id||undefined,query:field.value??field.innerText??'',expanded:field.getAttribute('aria-expanded'),controls,association:roots.length?'explicit':'unknown',selectedValue,options};
        });
    });
    return data.length?JSON.stringify(data).slice(0,6000):'';
}
