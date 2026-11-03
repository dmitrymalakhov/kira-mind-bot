import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import { loadJose } from './cryptoModules';

export interface PushDelivery { id: string; eventId: string; token: string; environment: 'sandbox' | 'production' }
export type PushOutcome = 'accepted' | 'unregistered' | 'retry' | 'rejected';
export interface PushTransport { send(delivery: PushDelivery): Promise<PushOutcome> }
export interface ApnsConfig { teamId: string; keyId: string; privateKey: string; topic: string }
export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | undefined {
    const get = (key: string) => env[`KIRA_PUBLIC_APNS_${key}`]?.trim() || '';
    const values = [get('TEAM_ID'),get('KEY_ID'),get('PRIVATE_KEY_FILE'),get('TOPIC')];
    if (values.every(v => !v)) return undefined;
    if (values.some(v => !v)) throw new Error('Incomplete APNs configuration');
    return {teamId:values[0],keyId:values[1],privateKey:fs.readFileSync(values[2],'utf8'),topic:values[3]};
}
export function genericPushPayload(eventId: string): string {
    return JSON.stringify({aps:{alert:{title:'Kira',body:'Новое уведомление Kira'},sound:'default'},eventId});
}
/** Fixed Apple TLS hosts; private key and provider token never cross to workers/devices. */
export class ApplePushTransport implements PushTransport {
    private token?: { value:string; issued:number };
    constructor(private config: ApnsConfig, private now = () => Date.now()) {}
    async send(delivery: PushDelivery): Promise<PushOutcome> {
        const authorization = await this.authorization();
        const host = delivery.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
        return new Promise(resolve => {
            const connection = http2.connect(host);
            let done = false;
            const finish = (outcome:PushOutcome) => { if(done)return;done=true;connection.destroy();resolve(outcome); };
            connection.setTimeout(8000,()=>finish('retry'));
            connection.once('error',()=>finish('retry'));
            const request = connection.request({':method':'POST',':path':`/3/device/${delivery.token}`,
                authorization:`bearer ${authorization}`,'apns-topic':this.config.topic,'apns-push-type':'alert',
                'apns-priority':'10','apns-id':delivery.id,'content-type':'application/json'});
            let status = 0, body = '';
            request.once('response',headers => {status = Number(headers[':status']);});
            request.on('data',chunk=> {body += chunk.toString();if(body.length>4096)finish('retry');});
            request.once('error',()=>finish('retry'));
            request.once('end',()=> {
                if(status===200)return finish('accepted');
                let reason='';try{reason=JSON.parse(body).reason;}catch{}
                if(status===410 || reason==='Unregistered' || reason==='BadDeviceToken' || reason==='DeviceTokenNotForTopic')return finish('unregistered');
                finish(status===429 || status>=500 || !status ? 'retry' : 'rejected');
            });
            request.end(genericPushPayload(delivery.eventId));
        });
    }
    private async authorization():Promise<string> {
        if(this.token && this.now()-this.token.issued<50*60_000)return this.token.value;
        const jose=await loadJose(), key=await jose.importPKCS8(this.config.privateKey,'ES256');
        const value=await new jose.SignJWT({}).setProtectedHeader({alg:'ES256',kid:this.config.keyId})
            .setIssuer(this.config.teamId).setIssuedAt(Math.floor(this.now()/1000)).sign(key);
        this.token={value,issued:this.now()};return value;
    }
}
