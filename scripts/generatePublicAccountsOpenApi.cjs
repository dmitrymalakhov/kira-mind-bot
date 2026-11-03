'use strict';
// The wire types are the schema source. --check is used by the regression suite.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'platform/publicAccounts/contracts.ts');
const program = ts.createProgram([input], { strict: true, target: ts.ScriptTarget.ES2020 });
const checker = program.getTypeChecker();
const source = program.getSourceFile(input);
const exported = new Map();
for (const node of source.statements) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) exported.set(node.name.text, checker.getTypeAtLocation(node));
}
function schema(type, current) {
    const name = type.aliasSymbol?.name || type.symbol?.name;
    if (name && name !== current && exported.has(name)) return { $ref: `#/components/schemas/${name}` };
    if (type.isUnion()) {
        const members = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
        const values = members.map(t => t.isStringLiteral() || t.isNumberLiteral() ? t.value : t.flags & ts.TypeFlags.BooleanLiteral ? t.intrinsicName === 'true' : undefined);
        if (values.every(v => v !== undefined) && new Set(values.map(v => typeof v)).size === 1) return { type: typeof values[0], enum: values };
        return { anyOf: members.map(t => schema(t, current)) };
    }
    if (type.isStringLiteral() || type.isNumberLiteral()) return { type: typeof type.value, const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: type.intrinsicName === 'true' };
    if (type.flags & ts.TypeFlags.StringLike) return { type: 'string' };
    if (type.flags & ts.TypeFlags.NumberLike) return { type: 'number' };
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' };
    if (checker.isArrayType(type)) return { type: 'array', items: schema(checker.getTypeArguments(type)[0], current) };
    if (type.flags & ts.TypeFlags.Object) {
        const properties = {}, required = [];
        for (const property of type.getProperties()) {
            properties[property.name] = schema(checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration || property.declarations[0]), current);
            if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
        }
        return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    }
    throw Error(`Unsupported wire type: ${checker.typeToString(type)}`);
}
const schemas = Object.fromEntries([...exported].map(([name, type]) => [name, schema(type, name)]));
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const version = { type: 'object', properties: { version: { const: 1 } }, required: ['version'], additionalProperties: false };
const ok = { type: 'object', properties: { version: { const: 1 }, ok: { const: true } }, required: ['version','ok'], additionalProperties: false };
const wrap = (key, value) => ({ type: 'object', properties: { version: { const: 1 }, [key]: value }, required: ['version',key], additionalProperties: false });
const array = name => ({ type: 'array', items: ref(name) });
const nativeAuth = { anyOf: [ref('LoginReply'), ref('ReauthenticationReply'), ref('IdentityView')] };
const routes = [
    ['get','/auth/config',null,ref('AuthConfig'),'public'],
    ['post','/auth/challenges',ref('ChallengeInput'),ref('AuthChallenge'),'optional'],
    ...['apple','google','telegram'].map(p => ['post',`/auth/${p}`,ref('ProviderLoginInput'),nativeAuth,'optional']),
    ['post','/auth/password',ref('PasswordLoginInput'),nativeAuth,'optional'],
    ['post','/auth/refresh',ref('RefreshInput'),ref('TokenPair'),'public'],
    ['post','/auth/logout',version,ok],
    ['get','/account',null,{ type:'object', properties:{account:ref('AccountView')},required:['account'] }],
    ['get','/account/identities',null,wrap('identities',array('IdentityView'))],
    ['delete','/account/identities/{identityId}',{ ...version, properties:{...version.properties,reauthenticationToken:{type:'string'}}, required:['version','reauthenticationToken'] },ok],
    ['get','/account/sessions',null,wrap('sessions',array('SessionView'))],
    ['delete','/account/sessions/{sessionId}',version,ok],
    ['get','/account/consents',null,{ type:'object',properties:{version:{const:1},catalog:ref('ConsentCatalog'),acceptedVersion:{type:['string','null']},aiAllowed:{type:'boolean'}},required:['version','catalog','acceptedVersion','aiAllowed'] }],
    ['put','/account/consents',ref('ConsentInput'),{ $ref:'#/paths/~1account~1consents/get/responses/200/content/application~1json/schema' }],
    ['post','/account/activate',ref('ActivationInput'),wrap('account',ref('AccountView')),undefined,202],
    ['get','/account/quota',null,wrap('quota',ref('QuotaView'))],
    ['delete','/account',ref('DeleteAccountInput'),ref('DeletionReply'),undefined,202],
    ['put','/account/push-devices',ref('PushDeviceInput'),wrap('registered',{const:true})],
    ['delete','/account/push-devices/{deviceId}',version,ok],
    ['get','/notifications',null,ref('NotificationPage')],
    ['post','/notifications/{id}/read',version,ok],
    ['post','/account/complaints',ref('ComplaintInput'),{type:'object',properties:{version:{const:1},complaintId:{type:'string',format:'uuid'},status:{const:'received'}},required:['version','complaintId','status']},undefined,202],
];
const paths = {};
for (const [method,url,body,result,access,status = 200] of routes) {
    const parameters = [...url.matchAll(/\{(\w+)\}/g)].map(([,name]) => ({ name,in:'path',required:true,schema:{type:'string',format:'uuid'} }));
    if (body && url !== '/auth/challenges') parameters.push({ name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'} });
    if (url === '/notifications') parameters.push(...[
        {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:20}},
        {name:'cursor',in:'query',schema:{type:'string'}},
    ]);
    paths[url] ||= {};
    paths[url][method] = {
        operationId: `${method}_${url.replace(/[^a-z0-9]+/gi,'_')}`,
        security: access === 'public' ? [] : access === 'optional' ? [{},{bearerAuth:[]}] : [{bearerAuth:[]}],
        ...(parameters.length ? {parameters} : {}),
        ...(body ? {requestBody:{required:true,content:{'application/json':{schema:body}}}} : {}),
        responses: {
            [status]:{description:'Success',content:{'application/json':{schema:result}}},
            ...Object.fromEntries([400,401,403,404,409,410,429,503].map(code => [code,{description:'PublicAccountError (see canonical flow contract)',content:{'application/json':{schema:ref('PublicAccountError')}}}])),
        },
    };
}
paths['/accounts/register']={post:{operationId:'closed_password_registration',security:[],responses:{410:{description:'Password registration is permanently closed',content:{'application/json':{schema:ref('PublicAccountError')}}}}}};
paths['/accounts/login']={post:{operationId:'legacy_password_login',description:'Existing password accounts only. Native clients use proof-protected /auth/password. No signup or implicit AI consent.',security:[],
    requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,properties:{username:{type:'string',pattern:'^[A-Za-z0-9_]{3,40}$'},password:{type:'string',minLength:12,maxLength:256}},required:['username','password']}}}},
    responses:{200:{description:'Existing legacy session,30-day expiry',content:{'application/json':{schema:{$ref:'./accounts.openapi.json#/components/schemas/AuthResponse'}}}},401:{description:'Invalid credentials',content:{'application/json':{schema:ref('PublicAccountError')}}},429:{description:'Persistent abuse limit',content:{'application/json':{schema:ref('PublicAccountError')}}}}}};
for(const provider of ['apple','google']) {
    paths[`/auth/events/${provider}`]={post:{operationId:`provider_security_event_${provider}`,security:[],
        requestBody:{required:true,content:{[provider==='google'?'application/secevent+jwt':'application/json']:{schema:provider==='google'?{type:'string'}:{type:'object',properties:{payload:{type:'string'}},required:['payload'],additionalProperties:false}}}},
        responses:{202:{description:'Signed provider event accepted',content:{'application/json':{schema:wrap('received',{const:true})}}},401:{description:'Invalid provider proof',content:{'application/json':{schema:ref('PublicAccountError')}}}}}};
}
const output = JSON.stringify({openapi:'3.1.0',info:{title:'Kira public accounts',version:'1.0.0',description:'kira.public-accounts.v1; availability is GET /auth/config. See docs/public-accounts-v1.md for receipts, quota and proof semantics.'},servers:[{url:'/api/v1'}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'}},schemas}},null,2)+'\n';
const target = process.env.KIRA_OPENAPI_OUTPUT || path.join(root,'api/public-accounts.openapi.json');
if (process.argv.includes('--check')) {
    if (fs.readFileSync(target,'utf8') !== output) throw Error('Regenerate public accounts OpenAPI from canonical types');
} else fs.writeFileSync(target,output);
