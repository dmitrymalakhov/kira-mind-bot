import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { DataSource } from 'typeorm';
import { tenantName } from '../store';
import { PlatformSecrets } from '../crypto';
import type { TenantCredentials } from '../runtime';
import type { AccountEraser,OwnedDeletionInventory } from './deletion';

interface ExclusiveImport {
    database:string;memoryNamespace:string;memoryBotId:string;runtimeDirectory:string;
    exclusiveDatabase:true;exclusiveMemoryNamespace:true;exclusiveRuntimeDirectory:true;expectedDatabaseOwner:string;
}
/** Trusted operator manifest, not an HTTP body. Shared/unverified imported stores are never guessed. */
export class OwnedAccountEraser implements AccountEraser {
    constructor(private db:DataSource,private secrets:PlatformSecrets,private runtimeRoot:string,private qdrant:QdrantClient,
        private manifestFile?:string){}
    async validate(inventory:OwnedDeletionInventory):Promise<void>{
        const name=tenantName(inventory.accountId);
        if(inventory.version!==1 || path.resolve(inventory.runtimeDirectory)!==path.join(path.resolve(this.runtimeRoot),name)
            || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(inventory.database)
            || !/^[a-z0-9_-]{1,100}$/.test(inventory.memoryNamespace) || !/^[a-z0-9_-]{1,100}$/.test(inventory.memoryBotId)
            || ['postgres','template0','template1',this.db.options.database].includes(inventory.database))throw Error('Deletion ownership mismatch');
        let expectedOwner=name;
        if(inventory.imported){
            const proof=await this.importProof(inventory);
            expectedOwner=proof.expectedDatabaseOwner;
        }else if(inventory.database!==name || inventory.memoryNamespace!==name || inventory.memoryBotId!==name)throw Error('Isolated ownership mismatch');
        for(const other of await this.db.query('SELECT id,secrets FROM kira_accounts WHERE id<>$1 AND secrets IS NOT NULL',[inventory.accountId])){
            const credentials=this.secrets.open<TenantCredentials>(other.secrets,other.id);
            const database=credentials.existingStorage?.database || tenantName(other.id),namespace=credentials.existingStorage?.memoryNamespace || tenantName(other.id);
            if(database===inventory.database || namespace===inventory.memoryNamespace || namespace.startsWith(inventory.memoryNamespace+'_')
                || inventory.memoryNamespace.startsWith(namespace+'_'))throw Error('Shared storage cannot be erased');
        }
        const [database]=await this.db.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[inventory.database]);
        if(database && database.owner!==expectedOwner)throw Error('Database ownership changed');
        try{
            const stat=await fs.lstat(inventory.runtimeDirectory);
            if(stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(inventory.runtimeDirectory)!==path.join(await fs.realpath(this.runtimeRoot),name))throw Error('Runtime directory ownership changed');
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    async eraseVectors(inventory:OwnedDeletionInventory):Promise<void>{
        await this.validate(inventory);
        const prefix=inventory.memoryNamespace+'_memories_',config=inventory.memoryNamespace+'_domain_configs';
        const {collections}=await this.qdrant.getCollections();
        for(const collection of collections){
            if(collection.name===config || collection.name.startsWith(prefix))await this.qdrant.deleteCollection(collection.name);
        }
    }
    async eraseDatabase(inventory:OwnedDeletionInventory):Promise<void>{
        await this.validate(inventory);
        const name=tenantName(inventory.accountId);
        // Validated/generated identifiers only. Never drop a server, volume, shared role or registry.
        await this.db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[inventory.database]);
        await this.db.query(`DROP DATABASE IF EXISTS "${inventory.database}"`);
        if((await this.db.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).length)await this.db.query(`DROP ROLE "${name}"`);
    }
    async eraseFiles(inventory:OwnedDeletionInventory):Promise<void>{
        await this.validate(inventory);
        await fs.rm(inventory.runtimeDirectory,{recursive:true,force:true});
    }
    private async importProof(inventory:OwnedDeletionInventory):Promise<ExclusiveImport>{
        if(!this.manifestFile)throw Error('Imported deletion ownership manifest is required');
        const stat=await fs.lstat(this.manifestFile);
        if(stat.isSymbolicLink() || stat.size>256*1024)throw Error('Invalid deletion ownership manifest');
        const file=JSON.parse(await fs.readFile(this.manifestFile,'utf8'));
        const proof=file?.version===1?file.accounts?.[inventory.accountId] as ExclusiveImport:undefined;
        if(!proof || proof.exclusiveDatabase!==true || proof.exclusiveMemoryNamespace!==true || proof.exclusiveRuntimeDirectory!==true || proof.database!==inventory.database || proof.memoryNamespace!==inventory.memoryNamespace
            || proof.memoryBotId!==inventory.memoryBotId || proof.runtimeDirectory!==inventory.runtimeDirectory
            || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(proof.expectedDatabaseOwner))throw Error('Imported ownership is unverified');
        return proof;
    }
}
