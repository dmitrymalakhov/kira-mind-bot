import { ApiError } from '../api/contracts';
import { authorizeAccountOutbound } from './accountPolicy';

type Input={type:'text';text:string}|{type:'image_url';image_url:{url:string}};
const unavailable=()=>new ApiError(503,'moderation_unavailable','Проверка безопасности временно недоступна.');
const denied=()=>new ApiError(403,'content_policy_violation','Запрос остановлен проверкой безопасности.');

/** Stateless request/output filter. No content, score or moderation body is logged or persisted. */
export async function moderateAccountInputs(inputs:Input[],fetcher:any=require('node-fetch').default || require('node-fetch')):Promise<void>{
    if(!inputs.length)return;
    const key=process.env.KIRA_PUBLIC_MODERATION_API_KEY || process.env.OPENAI_API_KEY;
    if(!key)throw unavailable();
    const base=(process.env.KIRA_PUBLIC_MODERATION_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
    const url=base+'/moderations';
    const urlObject=new URL(url);
    if(urlObject.username || urlObject.password || urlObject.search || urlObject.hash)throw unavailable();
    // Check text first. A suspected prohibited image is not forwarded based on an already flagged accompanying request.
    const text=inputs.filter((i):i is Extract<Input,{type:'text'}>=>i.type==='text');
    const images=inputs.filter(i=>i.type==='image_url');
    const batches:Input[][]=[];
    if(text.length)batches.push(text);
    if(images.length)batches.push(images);
    for(const input of batches){
        if(input.length>100 || JSON.stringify(input).length>24*1024*1024)throw unavailable();
        await authorizeAccountOutbound('openai',url,false);
        let response:any;
        try{response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
            headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model:'omni-moderation-latest',input})});}
        catch{throw unavailable();}
        if(!response.ok)throw unavailable();
        let body:any;
        try{const raw=await response.text();if(raw.length>256*1024)throw unavailable();body=JSON.parse(raw);}catch{throw unavailable();}
        if(!Array.isArray(body.results) || !body.results.length || body.results.some((r:any)=>typeof r.flagged!=='boolean' || !r.categories || typeof r.categories!=='object'))throw unavailable();
        if(body.results.some((r:any)=>r.flagged))throw denied();
    }
}

export function moderationInputs(value:unknown):Input[]{
    const inputs:Input[]=[];
    const visit=(item:any,field='',depth=0)=>{
        if(depth>20)throw unavailable();
        if(typeof item==='string'){
            if(['content','text','input','prompt','query','output_text','transcript','arguments','instructions'].includes(field) && item.trim())inputs.push({type:'text',text:item});
            return;
        }
        if(Array.isArray(item)){for(const part of item)visit(part,field,depth+1);return;}
        if(!item || typeof item!=='object')return;
        if(item.type==='image_url' && typeof item.image_url?.url==='string')inputs.push({type:'image_url',image_url:{url:item.image_url.url}});
        if(item.type==='input_image' && typeof item.image_url==='string')inputs.push({type:'image_url',image_url:{url:item.image_url}});
        if(typeof item.b64_json==='string'){
            const mime=item.b64_json.startsWith('/9j/')?'image/jpeg':item.b64_json.startsWith('UklGR')?'image/webp':'image/png';
            inputs.push({type:'image_url',image_url:{url:`data:${mime};base64,${item.b64_json}`}});
        }
        for(const [key,child]of Object.entries(item))if(!['b64_json','image_url','image','audio','file','inline_data','inlineData'].includes(key))visit(child,key,depth+1);
        if(typeof item.inlineData?.data==='string' && /^image\//.test(item.inlineData.mimeType))inputs.push({type:'image_url',image_url:{url:`data:${item.inlineData.mimeType};base64,${item.inlineData.data}`}});
    };
    visit(value);
    return inputs;
}

export async function moderateAccountRequest(body:unknown,fetcher?:any):Promise<void>{
    if(body && typeof body==='object' && typeof (body as any).entries==='function'){
        const inputs:Input[]=[];
        for(const [name,value]of (body as any).entries()){
            if(typeof value==='string' && ['prompt','text','input'].includes(name))inputs.push({type:'text',text:value});
            else if(value && /^image\/(jpeg|png|webp)$/.test(value.type) && typeof value.arrayBuffer==='function'){
                if(value.size>20*1024*1024)throw unavailable();
                inputs.push({type:'image_url',image_url:{url:`data:${value.type};base64,${Buffer.from(await value.arrayBuffer()).toString('base64')}`}});
            }
        }
        await moderateAccountInputs(inputs,fetcher);return;
    }
    if(typeof body!=='string')return; // Audio is checked through its returned transcript before downstream use.
    let parsed:unknown;try{parsed=JSON.parse(body);}catch{return;}
    await moderateAccountInputs(moderationInputs(parsed),fetcher);
}
export async function moderateAccountResponse(response:any,fetcher?:any):Promise<void>{
    if(!response.ok)return;
    const type=response.headers.get('content-type') || '';
    if(type.includes('text/event-stream'))throw unavailable(); // No unreviewed streaming tokens in the JSON API contract.
    if(type.includes('application/json')){
        const body=await response.clone().json();
        await moderateAccountInputs(moderationInputs(body),fetcher);
    }else if(type.startsWith('text/')){
        const text=await response.clone().text();
        if(text.trim())await moderateAccountInputs([{type:'text',text}],fetcher);
    }
}
