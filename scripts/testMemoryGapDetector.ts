import assert from "node:assert/strict";
import { ContactsStore } from "../stores/ContactsStore";
import { type SearchResult } from "../services/interfaces/IVectorService";
import { type IDomainVectorService } from "../services/interfaces/IDomainVectorService";
import { isPersonKnownForMemoryGap } from "../utils/memoryGapDetector";
import { type BotContext } from "../types";

function makeSearchResult(content: string, tags: string[], score = 0.9): SearchResult {
    return {
        id: `${content}-${tags.join(",")}`,
        content,
        score,
        timestamp: new Date("2026-06-21T12:00:00.000Z"),
        importance: 0.8,
        tags,
        domain: "work",
    };
}

function makeVectorService(
    memoriesByTag: Map<string, SearchResult[]>,
    searchByQuery: Map<string, SearchResult[]>
): IDomainVectorService {
    return {
        getMemoriesByTag: async (_userId: string, tag: string) => memoriesByTag.get(tag) ?? [],
        searchAllDomains: async (query: string) => searchByQuery.get(query) ?? [],
        createDomain: async () => undefined,
        getDomainConfig: async () => null,
        updateDomainConfig: async () => undefined,
        listDomains: async () => [],
        archiveDomain: async () => undefined,
        mergeDomains: async () => 0,
        searchInDomain: async () => [],
        searchCrossDomain: async () => [],
        getAnchorMemories: async () => [],
        updateMemory: async () => undefined,
        suggestDomains: async () => [],
        getDomainStats: async () => [],
        getDomainTrends: async () => [],
        cleanupInactiveDomains: async () => [],
        initializeCollection: async () => undefined,
        saveMemory: async () => "memory-id",
        searchMemories: async () => [],
        getDomainContext: async () => "",
        updateImportance: async () => undefined,
        updateMemoryAccess: async () => undefined,
        deleteMemory: async () => undefined,
        cleanupOldMemories: async () => 0,
        getMemoryStats: async () => ({ total: 0, domains: {} }),
        getRecentMemories: async () => [],
        getMemoriesForCompression: async () => [],
        addRelationship: async () => undefined,
        getRelatedFacts: async () => [],
        fetchMemoryById: async () => null,
        fetchMemoriesByIds: async () => [],
        getMemoriesBySourceEpisodeId: async () => [],
    };
}

function makeContext(): BotContext {
    return {
        from: { id: 176779906 },
        session: {},
    } as unknown as BotContext;
}

const contacts = ContactsStore.getInstance();
contacts.saveContact({ id: 1001, firstName: "Юрий", lastName: "Никишенко" });
contacts.saveContact({ id: 1002, firstName: "Дмитрий", lastName: "Малахов" });

const knownYuriyMemory = makeSearchResult(
    "[Юрий Никишенко] Рабочий контакт по PMP и оркестратору.",
    ["contact_name:Юрий Никишенко", "contact_alias:Юра Никишенко"]
);
const dmitryMalakhovMemory = makeSearchResult(
    "[Дмитрий Малахов] вылет в 01:50.",
    ["contact_name:Дмитрий Малахов"]
);

const vectorService = makeVectorService(
    new Map<string, SearchResult[]>([
        ["contact:Юрий Никишенко", [knownYuriyMemory]],
        ["contact_name:Юрий Никишенко", [knownYuriyMemory]],
        ["contact_alias:Юра Никишенко", [knownYuriyMemory]],
    ]),
    new Map<string, SearchResult[]>([
        ["Юра Никишенко", [knownYuriyMemory]],
        ["Юрий Никишенко", [knownYuriyMemory]],
        ["Юрий", [knownYuriyMemory]],
        ["Дмитрий", [dmitryMalakhovMemory]],
    ])
);

const noSearchHits = async (): Promise<SearchResult[]> => [];

async function run(): Promise<void> {
    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Юра Никишенко", {
            searchAllDomainsMemories: async () => [],
            vectorService,
        }),
        true
    );

    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Дмитрий", {
            searchAllDomainsMemories: noSearchHits,
            vectorService,
        }),
        false
    );

    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Юрий Никишенко", {
            searchAllDomainsMemories: async () => [knownYuriyMemory],
            vectorService: null,
        }),
        true
    );

    console.log("memoryGapDetector checks passed");
}

run().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
