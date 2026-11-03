import assert from 'node:assert/strict';
import test from 'node:test';
import { moderateAccountInputs,moderateAccountRequest,moderateAccountResponse,moderationInputs } from '../ai/accountModeration';
import { accountPolicyError } from '../ai/accountPolicy';

test('actual moderation input/output checks block flagged and unavailable results before exposure; text precedes image forwarding',async()=>{
    const previous={key:process.env.KIRA_PUBLIC_MODERATION_API_KEY,base:process.env.KIRA_PUBLIC_MODERATION_BASE_URL};
    process.env.KIRA_PUBLIC_MODERATION_API_KEY='synthetic-moderation-key';process.env.KIRA_PUBLIC_MODERATION_BASE_URL='https://synthetic.example.invalid/v1';
    try{
        const calls:any[]=[];let flagged=false;
        const fetcher=async(url:string,options:any)=>{
            assert.equal(url,'https://synthetic.example.invalid/v1/moderations');assert.equal(options.headers.authorization,'Bearer synthetic-moderation-key');
            calls.push(JSON.parse(options.body));return new Response(JSON.stringify({results:[{flagged,categories:{'sexual/minors':flagged}}]}),{headers:{'content-type':'application/json'}});
        };
        await moderateAccountInputs([{type:'text',text:'Synthetic ordinary question'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}],fetcher);
        assert.equal(calls.length,2);assert.equal(calls[0].input[0].type,'text');assert.equal(calls[1].input[0].type,'image_url');
        flagged=true;calls.length=0;
        await assert.rejects(()=>moderateAccountInputs([{type:'text',text:'Synthetic flagged fixture'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}],fetcher),(e:any)=>e.code==='content_policy_violation');
        assert.equal(calls.length,1,'a flagged accompanying request never forwards its image');
        await assert.rejects(()=>moderateAccountResponse(new Response(JSON.stringify({choices:[{message:{content:'Synthetic flagged output'}}]}),{headers:{'content-type':'application/json'}}),fetcher),(e:any)=>e.code==='content_policy_violation');
        await assert.rejects(()=>moderateAccountInputs([{type:'text',text:'Synthetic'}],async()=>new Response('{}')),(e:any)=>e.code==='moderation_unavailable');
        await assert.rejects(()=>moderateAccountInputs([{type:'text',text:'Synthetic'}],async()=>{throw Error('Synthetic outage');}),(e:any)=>e.code==='moderation_unavailable');
        flagged=false;calls.length=0;
        const form=new FormData();form.set('prompt','Synthetic image edit');form.set('image',new Blob([Buffer.from('synthetic')],{type:'image/png'}),'synthetic.png');
        await moderateAccountRequest(form,fetcher);assert.equal(calls.length,2);
        const extracted=moderationInputs({input:[{type:'input_text',text:'Synthetic prompt'},{type:'input_image',image_url:'data:image/png;base64,c3ludGhldGlj'}],output:[{type:'function_call',arguments:'{"text":"Synthetic tool argument"}'}]});
        assert.equal(extracted.filter(x=>x.type==='text').length,2);assert.equal(extracted.filter(x=>x.type==='image_url').length,1);
        const refusal=await moderateAccountInputs([{type:'text',text:'Synthetic'}],async()=>new Response(JSON.stringify({results:[{flagged:true,categories:{}}]}))).catch(e=>e);
        assert.equal(accountPolicyError({cause:refusal})?.code,'content_policy_violation','SDK wrapping does not turn policy denial into a fallback');
    }finally{
        if(previous.key===undefined)delete process.env.KIRA_PUBLIC_MODERATION_API_KEY;else process.env.KIRA_PUBLIC_MODERATION_API_KEY=previous.key;
        if(previous.base===undefined)delete process.env.KIRA_PUBLIC_MODERATION_BASE_URL;else process.env.KIRA_PUBLIC_MODERATION_BASE_URL=previous.base;
    }
});
