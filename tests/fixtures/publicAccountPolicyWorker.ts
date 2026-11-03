import { withAccountAiOperation,accountPolicyError } from '../../ai/accountPolicy';
import { openaiProviderAdapter } from '../../ai/providers/openai';
import { openrouterProviderAdapter } from '../../ai/providers/openrouter';
import { generateOpenAiImage } from '../../services/imageGenerationService';

process.on('message',(raw:unknown)=>{
    const input=raw as {type?:string;id:string;operationId:string;action:string;background?:boolean};
    if(input?.type!=='fixture-call')return;
    void withAccountAiOperation({id:input.operationId,background:Boolean(input.background)},async()=>{
        try{
            if(input.action==='text')await openaiProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic safe request'}]});
            else if(input.action==='embedding')await openaiProviderAdapter.createEmbedding!('synthetic-embedding',{input:'Synthetic memory',outputDimension:4});
            else if(input.action==='image')await generateOpenAiImage('Synthetic landscape',false);
            else if(input.action==='fallback')await openrouterProviderAdapter.createChatCompletion('synthetic-model',{messages:[{role:'user',content:'Synthetic safe request'}]});
            else throw Error('Unknown fixture operation');
            process.send?.({type:'fixture-result',id:input.id,ok:true});
        }catch(error){const safe=accountPolicyError(error);process.send?.({type:'fixture-result',id:input.id,ok:false,code:safe?.code || 'fixture_error'});}
    });
});
process.send?.({type:'fixture-ready'});
