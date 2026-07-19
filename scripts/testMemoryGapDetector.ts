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
        getAllMemories: async () => [],
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
        from: { id: 900000010 },
        session: {},
    } as unknown as BotContext;
}

const contacts = ContactsStore.getInstance();
contacts.saveContact({ id: 1001, firstName: "Лира", lastName: "Примерова", username: "contact_alpha" });
contacts.saveContact({ id: 1002, firstName: "Павел", lastName: "Тестов" });
contacts.saveContact({ id: 1003, firstName: "Леди", lastName: "Тестория" });

const knownLiraMemory = makeSearchResult(
    "[Лира Примерова] Рабочий контакт по PMP и оркестратору.",
    ["contact_username:@contact_alpha"]
);
const pavelTestovMemory = makeSearchResult(
    "[Павел Тестов] вылет в 01:50.",
    ["contact_name:Павел Тестов"]
);
const ladyTestoriaMemory = makeSearchResult(
    "[Леди Тестория] ждёт статус по проекту.",
    ["contact_id:1003"]
);

const vectorService = makeVectorService(
    new Map<string, SearchResult[]>([
        ["contact_username:@contact_alpha", [knownLiraMemory]],
        ["contact_id:1003", [ladyTestoriaMemory]],
    ]),
    new Map<string, SearchResult[]>([
        ["Лира Примерова", [knownLiraMemory]],
        ["@contact_alpha", [knownLiraMemory]],
        ["Павел", [pavelTestovMemory]],
        ["Леди Тестория", [ladyTestoriaMemory]],
    ])
);

const noSearchHits = async (): Promise<SearchResult[]> => [];

async function run(): Promise<void> {
    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Лира Примерова", {
            searchAllDomainsMemories: async () => [],
            vectorService,
        }),
        true
    );

    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Павел", {
            searchAllDomainsMemories: noSearchHits,
            vectorService,
        }),
        false
    );

    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Леди Тестория", {
            searchAllDomainsMemories: async () => [],
            vectorService,
        }),
        true
    );

    assert.equal(
        await isPersonKnownForMemoryGap(makeContext(), "Лира Примерова", {
            searchAllDomainsMemories: async () => [knownLiraMemory],
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
