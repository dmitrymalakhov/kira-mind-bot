import { chromium, Browser, BrowserContext, Frame, Locator, Page } from 'playwright';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { isIP } from 'net';
import * as os from 'os';
import * as path from 'path';
import { InlineKeyboard, InputFile } from 'grammy';
import type { BotContext, MessageHistory } from '../types';
import type { ProcessingResult, MessageClassification } from '../orchestrator';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { devLog, parseLLMJson } from '../utils';
import { fetchAgentMemoryContext, buildMemoryContextBlock } from '../utils/agentMemoryContext';
import { BrowserSessionStore } from '../services/BrowserSessionStore';
import { BrowserCredentialService } from '../services/BrowserCredentialService';
import { looksLikeBrowserTaskCancellation } from '../utils/browserTaskCancellation';

const MAX_ITERATIONS = 35;
const MAX_MEMORY_LOOKUPS = 6;
const MAX_CONSECUTIVE_ACTION_FAILURES = 4;
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const SCREENSHOT_INTERVAL = 6;
const PENDING_BROWSER_TTL_MS = 15 * 60 * 1000;
const LAST_BROWSER_TASK_TTL_MS = 45 * 60 * 1000;
const BROWSER_SITE_PATTERNS_FILE = path.join(__dirname, '..', 'data', 'browser-site-patterns.json');
const BROWSER_PROFILE_ROOT_DIR = path.join(__dirname, '..', 'data', 'browser-profiles');
const BROWSER_TRAJECTORY_DIR = path.join(__dirname, '..', 'data', 'browser-trajectories');
const BROWSER_TRAJECTORY_MAX_BYTES = 768 * 1024;
const BROWSER_TRAJECTORY_EVENT_MAX_BYTES = 16 * 1024;
const BROWSER_TRAJECTORY_MAX_FILES = 80;
const BROWSER_DIALOG_ARM_TTL_MS = 5 * 60 * 1000;
const BROWSER_DIALOG_RECENT_MS = 10 * 60 * 1000;
const BROWSER_CONTINUATION_RE = /^Продолжи задачу в браузере через Playwright\.|browserSessionId:/i;
const INTERACTIVE_ELEMENT_SELECTOR = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[contenteditable="true"]',
    '[aria-label]',
    '[data-testid]',
    '[data-test]',
].join(',');
const VISIBLE_INTERACTIVE_ELEMENT_SELECTOR = [
    'a',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[contenteditable="true"]',
    '[aria-label]',
    '[data-testid]',
    '[data-test]',
].map((selector) => `${selector}:visible`).join(',');
const CLICKABLE_CONTROL_SELECTOR = [
    'a[href]',
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[aria-label]',
    '[title]',
    '[data-testid]',
    '[data-test]',
    '[onclick]',
    '[tabindex]',
].join(',');

type BrowserActionKind =
    | 'navigate'
    | 'click'
    | 'fill'
    | 'fill_credential'
    | 'type'
    | 'press_key'
    | 'select_option'
    | 'check'
    | 'uncheck'
    | 'hover'
    | 'scroll'
    | 'find_on_page'
    | 'site_search'
    | 'select_date'
    | 'switch_tab'
    | 'close_tab'
    | 'dismiss_overlays'
    | 'save_page_pdf'
    | 'save_screenshot'
    | 'wait'
    | 'go_back'
    | 'memory_lookup'
    | 'note'
    | 'ask_user'
    | 'done'
    | 'fail';

interface BrowserAction {
    action: BrowserActionKind;
    /** URL (navigate); текст (fill/type); login/password (fill_credential); клавиша; значение option; up/down (scroll) */
    value?: string;
    /** ref=e1 (ARIA snapshot), domref=k1 (DOM snapshot), CSS, text=..., role=button[name="..."], label=..., placeholder=..., testid=..., frame=N >> ... или видимый текст */
    selector?: string;
    /** Объяснение действия — показываем пользователю как прогресс */
    comment?: string;
    /** Итоговое описание, причина fail или вопрос для ask_user */
    summary?: string;
    /** Варианты ответа для ask_user, если на странице есть явный выбор */
    choices?: Array<string | { label?: string; value?: string; answer?: string; message?: string }>;
}

interface BrowserUserChoice {
    label: string;
    answer: string;
}

interface TaskTextTarget {
    name: string;
    dateText?: string;
}

interface ContextualClickCandidate {
    controlIndex: number;
    label: string;
    context: string;
    matchedHints: string[];
    score: number;
}

type ContextualClickResult =
    | { status: 'none'; reason?: string }
    | { status: 'clicked'; label: string }
    | { status: 'ambiguous'; question: string; choices: BrowserUserChoice[] }
    | { status: 'failed'; reason: string };

type RawClickGuardResult =
    | { status: 'none'; reason?: string }
    | { status: 'blocked'; question?: string; choices?: BrowserUserChoice[]; note: string }
    | { status: 'failed'; reason: string };

interface VisualClickCandidate {
    controlIndex: number;
    label: string;
    role: string;
    selector: string;
    selectors: string[];
    visual: string;
    bbox: string;
    center: string;
    context: string;
    nearbyText: string;
    position: string;
    zIndex: number;
    modalLike: boolean;
    score: number;
}

type VisualLayoutClickResult =
    | { status: 'none'; reason?: string }
    | { status: 'clicked'; label: string; controlIndex: number; reason: string }
    | { status: 'failed'; reason: string };

interface PageFindResult {
    query: string;
    text: string;
    tag: string;
    role: string;
    bbox: string;
    score: number;
}

interface BrowserEvidenceItem {
    type: 'observation' | 'action' | 'network' | 'download' | 'success' | 'data';
    text: string;
    url: string;
    createdAt: string;
}

interface BrowserVisibleListingItem {
    key: string;
    title: string;
    details: string;
    url?: string;
    dateText?: string;
    dateMs?: number;
    source: string;
    firstSeenAt: string;
}

interface BrowserNetworkSnippet {
    method: string;
    status: number;
    url: string;
    contentType: string;
    body: string;
    createdAt: string;
}

interface BrowserTrajectoryRecorder {
    filePath: string;
    seq: number;
    acceptedBytes: number;
    droppedEvents: number;
    droppedBytes: number;
    stopped: boolean;
}

type BrowserPagePhase =
    | 'unknown'
    | 'listing'
    | 'detail_page'
    | 'booking_form'
    | 'confirmation_modal'
    | 'success'
    | 'validation_error'
    | 'blocked'
    | 'stuck';

interface BrowserTaskLedger {
    goal?: string;
    target?: string;
    date?: string;
    formData?: Record<string, string>;
    filled?: string[];
    pending?: string[];
    confirmations?: string[];
    lastEvidence?: string[];
}

interface BrowserTaskContract {
    goal: string;
    objectiveType: string;
    domain: string;
    inferredMeaning: string[];
    hardCriteria: string[];
    softPreferences: string[];
    negativeCriteria: string[];
    searchQueries: string[];
    searchTerms: string[];
    evidenceNeeded: string[];
    verificationSteps: string[];
    successDefinition: string;
    unknowns: string[];
    confidence: number;
}

interface BrowserTaskPlanStep {
    id: string;
    label: string;
    status: 'pending' | 'in_progress' | 'done' | 'blocked';
    evidence?: string;
}

interface PageUnderstanding {
    phase: BrowserPagePhase;
    whatIsHappening: string;
    blockingElement?: string;
    primaryVisibleAction?: string;
    successEvidence?: string | null;
    missingData?: string[];
    nextExpectedPhase?: string;
    confidence: number;
    evidence: string[];
    ledger?: BrowserTaskLedger;
    taskPlan?: BrowserTaskPlanStep[];
}

interface ActionOutcomeUnderstanding {
    changed: boolean;
    progress: string;
    sameLoopRisk: boolean;
    nextExpectedPhase?: string;
    evidence: string[];
    confidence: number;
}

type DecisionCriticVerdict = 'allow' | 'block' | 'ask_user';

interface DecisionCriticResult {
    verdict: DecisionCriticVerdict;
    confidence: number;
    risk: 'low' | 'medium' | 'high';
    reason: string;
    question?: string;
}

interface CompletionReviewResult {
    complete: boolean;
    confidence: number;
    reason: string;
    missingCriteria: string[];
    unsupportedClaims: string[];
    nextStep?: string;
}

interface BrowserSitePattern {
    domain: string;
    flow: string;
    updatedAt: string;
    successEvidence?: string[];
    modalPatterns?: Array<{ question: string; buttons: string[]; preferredButton?: string }>;
    notes?: string[];
}

interface TaskScopedActionIntent {
    labels: string[];
    keywords: string[];
    description: string;
    highImpact: boolean;
}

interface TaskScopedActionCandidate {
    controlIndex: number;
    controlLabel: string;
    context: string;
    matchedHints: string[];
    matchedAction: string;
    score: number;
}

type TaskScopedActionResult =
    | { status: 'none'; reason?: string }
    | { status: 'clicked'; label: string; controlLabel: string }
    | { status: 'ambiguous'; question: string; choices: BrowserUserChoice[] }
    | { status: 'failed'; reason: string };

interface ActionRecord {
    step: number;
    label: string;
    url: string;
    comment: string;
    result: 'ok' | 'failed';
    error?: string;
}

type BrowserActionLoopDetectorKind = 'generic_repeat' | 'ping_pong' | 'same_page_no_progress';

type BrowserActionLoopDetectionResult =
    | { stuck: false }
    | {
        stuck: true;
        level: 'warning' | 'critical';
        detector: BrowserActionLoopDetectorKind;
        count: number;
        message: string;
        recovery: string;
        warningKey: string;
    };

type BrowserStuckRecoveryKind =
    | 'dismiss_overlays'
    | 'find_on_page'
    | 'scroll_down'
    | 'go_back'
    | 'site_search'
    | 'wait';

interface BrowserStuckRecoveryPlan {
    kind: BrowserStuckRecoveryKind;
    action: BrowserAction;
    reason: string;
    query?: string;
}

interface CredentialMaterial {
    source: 'saved' | 'memory' | 'user';
    domain?: string;
    login?: string;
    password?: string;
}

interface PageObservation {
    screenshotB64: string;
    pageState: string;
    blockerSignals: string;
    a11yText: string;
    interactiveText: string;
    structureText: string;
    semanticMapText: string;
    structuredDataText: string;
    scrollDiagnosticsText: string;
    filterControlsText: string;
    productCardsText: string;
    tableText: string;
    affordanceGraphText: string;
    formBrainText: string;
    formText: string;
    modalText: string;
    frameText: string;
    tabsText: string;
    visualMapText: string;
    pageText: string;
    selectOptions: string;
    runtimeSignals: string;
}

interface BrowserDownload {
    filename: string;
    filePath: string;
    url: string;
}

interface BrowserDialogRecord {
    type: string;
    message: string;
    defaultValue?: string;
    handled: 'accepted_alert' | 'dismissed_for_safety' | 'accepted_by_user' | 'dismissed_by_user' | 'failed';
    createdAt: string;
    promptedAt?: string;
}

interface ArmedBrowserDialogResponse {
    accept: boolean;
    promptText?: string;
    messageHint?: string;
    expiresAt: number;
}

interface BrowserRunState {
    id: string;
    userId: number;
    chatId?: number;
    browser: Browser;
    browserCtx: BrowserContext;
    persistentProfile: boolean;
    profileDir?: string;
    page: Page;
    originalTask: string;
    memoryContext?: string;
    recentUserContext?: string;
    memoryCredentials: CredentialMaterial | null;
    credentialCandidates: CredentialMaterial[];
    activeCredentials: CredentialMaterial | null;
    history: ActionRecord[];
    notes: string[];
    memoryLookupQueries: string[];
    pageEvents: string[];
    networkSnippets: BrowserNetworkSnippet[];
    evidenceStash: BrowserEvidenceItem[];
    visibleListingItems: BrowserVisibleListingItem[];
    formAutofillAttempts: string[];
    loopCheckpointSignatures: string[];
    downloads: BrowserDownload[];
    dialogs: BrowserDialogRecord[];
    armedDialogResponse?: ArmedBrowserDialogResponse;
    trajectory?: BrowserTrajectoryRecorder;
    lastComment: string;
    lastUserAnswer: string;
    lastScreenshotDomain: string;
    lastCredentialDomain: string;
    sessionSavedForDomain: string;
    followUpOriginDomain: string;
    iterationCount: number;
    consecutiveActionFailures: number;
    highImpactConfirmed: boolean;
    taskContract?: BrowserTaskContract;
    taskContractSource?: string;
    pageUnderstanding?: PageUnderstanding;
    taskLedger?: BrowserTaskLedger;
    taskPlan?: BrowserTaskPlanStep[];
    lastActionOutcome?: ActionOutcomeUnderstanding;
    lastUnderstandingUrl: string;
    lastUnderstandingIteration: number;
    pendingBookingMemorySnapshot?: string;
    confirmedBookingMemorySnapshot?: string;
    rejectedBookingMemorySnapshots: string[];
    cancelRequested: boolean;
    cancelAcknowledged: boolean;
    expiresAt: number;
    timeout?: NodeJS.Timeout;
}

const pausedBrowserSessions = new Map<string, BrowserRunState>();
const activeBrowserSessions = new Map<string, BrowserRunState>();
const browserAgentLanes = new Map<string, Promise<void>>();
const observedPages = new WeakSet<Page>();
const VALID_BROWSER_ACTIONS = new Set<string>([
    'navigate',
    'click',
    'fill',
    'fill_credential',
    'type',
    'press_key',
    'select_option',
    'check',
    'uncheck',
    'hover',
    'scroll',
    'find_on_page',
    'site_search',
    'select_date',
    'switch_tab',
    'close_tab',
    'dismiss_overlays',
    'save_page_pdf',
    'save_screenshot',
    'wait',
    'go_back',
    'memory_lookup',
    'note',
    'ask_user',
    'done',
    'fail',
]);
const BROWSER_ACTION_ALIASES: Record<string, BrowserActionKind> = {
    open: 'navigate',
    go: 'navigate',
    goto: 'navigate',
    visit: 'navigate',
    browse: 'navigate',
    tap: 'click',
    press: 'press_key',
    key: 'press_key',
    input: 'fill',
    set_value: 'fill',
    set: 'fill',
    choose: 'select_option',
    select: 'select_option',
    option: 'select_option',
    search: 'find_on_page',
    find: 'find_on_page',
    page_search: 'find_on_page',
    search_page: 'find_on_page',
    search_site: 'site_search',
    site_find: 'site_search',
    screenshot: 'save_screenshot',
    capture: 'save_screenshot',
    pdf: 'save_page_pdf',
    back: 'go_back',
    previous: 'go_back',
    stop: 'fail',
    complete: 'done',
    finish: 'done',
    success: 'done',
};

// ─── Accessibility tree ───────────────────────────────────────────────────────

function formatA11yNode(node: any, depth: number, lines: string[]): void {
    if (depth > 7) return;
    const role: string = node.role ?? 'unknown';

    if (['none', 'presentation', 'generic'].includes(role) && !node.children?.length) return;

    const name = node.name ? ` "${String(node.name).slice(0, 90)}"` : '';
    const val = (node.value !== undefined && node.value !== '')
        ? ` =${String(node.value).slice(0, 60)}` : '';
    const level = node.level ? `(${node.level})` : '';
    const flags = [
        node.checked === true ? 'checked' : node.checked === false ? 'unchecked' : '',
        node.required ? 'required' : '',
        node.disabled ? 'disabled' : '',
    ].filter(Boolean).join(',');
    const flagStr = flags ? ` [${flags}]` : '';
    const indent = '  '.repeat(Math.min(depth, 6));

    lines.push(`${indent}[${role}${level}]${name}${val}${flagStr}`);
    for (const child of node.children ?? []) {
        formatA11yNode(child, depth + 1, lines);
    }
}

async function getAccessibilityText(page: Page): Promise<string> {
    try {
        const aiSnapshot = typeof (page as any).ariaSnapshot === 'function'
            ? await (page as any).ariaSnapshot({ mode: 'ai', depth: 8, timeout: 5000 }).catch(() => '')
            : '';
        if (aiSnapshot) {
            return limitText(`AI aria snapshot. Use selector ref=eN from [ref=eN] when acting on these nodes:\n${aiSnapshot}`, 7000);
        }

        const snapshot = await (page as any).accessibility.snapshot({ interestingOnly: true });
        if (!snapshot) return '';
        const lines: string[] = [];
        formatA11yNode(snapshot, 0, lines);
        return limitText(lines.join('\n'), 5000);
    } catch {
        return '';
    }
}

/** Список всех <select> опций на странице — помогает агенту видеть выборы. */
async function getSelectOptions(page: Page): Promise<string> {
    try {
        const selects = await page.$$eval('select', (els) =>
            els.map((el: any) => ({
                id: el.id || el.name || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '?',
                opts: Array.from((el as HTMLSelectElement).options)
                    .map((o: HTMLOptionElement) => o.text.trim())
                    .filter(Boolean)
                    .slice(0, 30),
            }))
        );
        const relevant = selects.filter((s) => s.opts.length > 0);
        if (!relevant.length) return '';
        return relevant.map((s) => `  ${s.id}: [${s.opts.join(' | ')}]`).join('\n');
    } catch {
        return '';
    }
}

async function getVisiblePageText(page: Page): Promise<string> {
    try {
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        return limitText(cleanWhitespace(text), 2500);
    } catch {
        return '';
    }
}

async function getPageStateText(page: Page): Promise<string> {
    try {
        const state = await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            const activeLabel = active
                ? [
                    active.tagName.toLowerCase(),
                    active.getAttribute('type') || '',
                    active.getAttribute('aria-label') || '',
                    active.getAttribute('placeholder') || '',
                    active.id ? `#${active.id}` : '',
                    active.getAttribute('name') ? `[name=${active.getAttribute('name')}]` : '',
                ].filter(Boolean).join(' ')
                : '';
            return {
                readyState: document.readyState,
                activeElement: activeLabel,
                scrollY: Math.round(window.scrollY),
                viewport: `${window.innerWidth}x${window.innerHeight}`,
                bodyHeight: Math.round(document.body?.scrollHeight ?? 0),
            };
        });
        return `ready=${state.readyState}; viewport=${state.viewport}; scrollY=${state.scrollY}/${state.bodyHeight}; active=${state.activeElement || '(нет)'}`;
    } catch {
        return '';
    }
}

async function getHumanVerificationDiagnosticsText(page: Page): Promise<string> {
    try {
        const signals = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisibleInViewport = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el as HTMLElement);
                return (
                    rect.width >= 8 &&
                    rect.height >= 8 &&
                    rect.bottom > 0 &&
                    rect.right > 0 &&
                    rect.top < window.innerHeight &&
                    rect.left < window.innerWidth &&
                    style.visibility !== 'hidden' &&
                    style.display !== 'none' &&
                    Number(style.opacity || '1') > 0.05
                );
            };
            const textOf = (el: Element) =>
                compact((el as HTMLElement).innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
            const bodyText = compact(document.body?.innerText || '');
            const visibleTextPattern =
                /(я\s+не\s+(?:робот|бот)|подтвердите,\s*что\s+вы\s+не\s+(?:робот|бот)|подтвердите,\s*что\s+вы\s+человек|captcha|recaptcha|hcaptcha|turnstile|verify\s+(?:you\s+are|that\s+you\s+are)\s+(?:human|not\s+a\s+robot)|i'?m\s+not\s+a\s+robot|are\s+you\s+human|human\s+verification|checking\s+your\s+browser|cloudflare\s+challenge|security\s+check)/iu;
            const signals: string[] = [];
            const visibleTextMatch = bodyText.match(visibleTextPattern)?.[0];
            if (visibleTextMatch) signals.push(`visible_text="${visibleTextMatch.slice(0, 140)}"`);

            const widgetSelector = [
                'iframe[src*="recaptcha"]',
                'iframe[src*="hcaptcha"]',
                'iframe[src*="challenges.cloudflare"]',
                'iframe[src*="turnstile"]',
                '.g-recaptcha',
                '.h-captcha',
                '.cf-turnstile',
                '[data-sitekey]',
            ].join(',');
            Array.from(document.querySelectorAll(widgetSelector))
                .filter(isVisibleInViewport)
                .slice(0, 4)
                .forEach((el) => {
                    const rect = el.getBoundingClientRect();
                    const tag = el.tagName.toLowerCase();
                    const label = textOf(el) || compact(el.getAttribute('src') || el.getAttribute('class') || el.getAttribute('id'));
                    signals.push(`visible_widget=${tag} "${label.slice(0, 160)}" bbox=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
                });

            Array.from(document.querySelectorAll('button,input,[role="button"],[role="checkbox"],label'))
                .filter(isVisibleInViewport)
                .map(textOf)
                .filter((text) => visibleTextPattern.test(text))
                .slice(0, 4)
                .forEach((text) => signals.push(`visible_control="${text.slice(0, 160)}"`));

            return Array.from(new Set(signals)).slice(0, 8);
        });
        if (!signals.length) return '';
        return ['human_verification:', ...signals.map((signal) => `  - ${signal}`)].join('\n');
    } catch (e) {
        devLog('browserAgent: human verification diagnostics failed:', e);
        return '';
    }
}

async function getScrollDiagnosticsText(page: Page): Promise<string> {
    try {
        const info = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const textOf = (el: Element) => compact((el as HTMLElement).innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
            const y = Math.max(0, Math.round(window.scrollY));
            const viewportHeight = Math.max(1, Math.round(window.innerHeight));
            const bodyHeight = Math.max(viewportHeight, Math.round(document.body?.scrollHeight ?? document.documentElement?.scrollHeight ?? viewportHeight));
            const maxY = Math.max(0, bodyHeight - viewportHeight);
            const progress = maxY > 0 ? Math.round((y / maxY) * 100) : 100;
            const currentBandTop = y;
            const currentBandBottom = y + viewportHeight;
            const belowBandBottom = y + viewportHeight * 2.4;
            const headingSelector = 'h1,h2,h3,h4,[role="heading"],section[aria-label],article[aria-label],[data-testid],[data-test]';
            const importantBelow = Array.from(document.querySelectorAll(headingSelector))
                .filter(isVisible)
                .map((el) => {
                    const rect = el.getBoundingClientRect();
                    const absTop = Math.round(rect.top + window.scrollY);
                    const text = textOf(el);
                    return {
                        text,
                        top: absTop,
                        tag: el.tagName.toLowerCase(),
                    };
                })
                .filter((item) => item.text && item.top > currentBandBottom + 40 && item.top < belowBandBottom)
                .filter((item, index, arr) => arr.findIndex((other) => other.text === item.text) === index)
                .slice(0, 10);
            const visibleHeadings = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))
                .filter(isVisible)
                .map((el) => {
                    const rect = el.getBoundingClientRect();
                    return { text: textOf(el), top: Math.round(rect.top + window.scrollY) };
                })
                .filter((item) => item.text && item.top >= currentBandTop - 120 && item.top <= currentBandBottom + 80)
                .filter((item, index, arr) => arr.findIndex((other) => other.text === item.text) === index)
                .slice(0, 8);
            return {
                y,
                viewportHeight,
                bodyHeight,
                maxY,
                progress,
                canScrollUp: y > 20,
                canScrollDown: y + viewportHeight < bodyHeight - 20,
                visibleHeadings,
                importantBelow,
            };
        });
        const lines = [
            `  position=${info.y}/${info.bodyHeight} viewport=${info.viewportHeight} progress=${info.progress}% canScrollUp=${info.canScrollUp} canScrollDown=${info.canScrollDown}`,
            info.visibleHeadings.length ? `  visible-headings=[${info.visibleHeadings.map((item) => item.text.slice(0, 100)).join(' | ')}]` : '',
            info.importantBelow.length ? `  below-next-screen=[${info.importantBelow.map((item) => `${item.text.slice(0, 100)} @${item.top}`).join(' | ')}]` : '',
        ].filter(Boolean);
        return lines.join('\n');
    } catch (e) {
        devLog('browserAgent: scroll diagnostics failed:', e);
        return '';
    }
}

async function getFilterControlsText(page: Page): Promise<string> {
    try {
        const groups = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const cssEscape = (value: string) => {
                const css = (window as any).CSS;
                if (css?.escape) return css.escape(value);
                return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
            };
            const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const textOf = (el: Element) => {
                const input = el as HTMLInputElement;
                const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
                return compact(labelText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || input.value || (el as HTMLElement).innerText || el.textContent || el.getAttribute('name') || el.getAttribute('id'));
            };
            const selectorFor = (el: Element, label: string) => {
                const tag = el.tagName.toLowerCase();
                const id = compact(el.getAttribute('id'));
                const name = compact(el.getAttribute('name'));
                const testId = compact(el.getAttribute('data-testid'));
                const dataTest = compact(el.getAttribute('data-test'));
                const aria = compact(el.getAttribute('aria-label'));
                const selectors: string[] = [];
                if (testId) selectors.push(`testid=${testId}`);
                if (dataTest) selectors.push(`css=${tag}[data-test="${attrEscape(dataTest)}"]`);
                if (id) selectors.push(`css=#${cssEscape(id)}`);
                if (name) selectors.push(`css=${tag}[name="${attrEscape(name)}"]`);
                if (aria) selectors.push(`css=${tag}[aria-label="${attrEscape(aria)}"]`);
                if (label) selectors.push(`text=${label.slice(0, 90)}`);
                return selectors.filter((value, index, arr) => arr.indexOf(value) === index).slice(0, 4);
            };
            const looksFilterSurface = (text: string, el: Element) => {
                const surface = `${text} ${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('data-testid') || ''}`.toLocaleLowerCase('ru-RU');
                return /(фильтр|подбор|сорт|цена|стоим|цвет|размер|бренд|категор|тип|материал|состав|стиль|сезон|налич|дата|время|город|район|адрес|рейтинг|отзыв|filter|facet|sort|price|color|size|brand|category|type|material|style|season|availability|date|time|location|rating|review)/iu.test(surface);
            };
            const optionLikeText = (root: Element) =>
                Array.from(root.querySelectorAll('button,a,label,input[type="checkbox"],input[type="radio"],[role="option"],[role="menuitem"],[role="checkbox"],[role="radio"]'))
                    .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                    .map(textOf)
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 18);
            const roots = Array.from(document.querySelectorAll([
                'aside',
                'form',
                '[role="search"]',
                '[role="listbox"]',
                '[role="menu"]',
                '[class*="filter" i]',
                '[id*="filter" i]',
                '[class*="facet" i]',
                '[id*="facet" i]',
                '[class*="sort" i]',
                '[id*="sort" i]',
                '[data-testid*="filter" i]',
                '[data-testid*="sort" i]',
                'select',
            ].join(',')))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                .slice(0, 24);
            const groups = roots.map((root, index) => {
                const label = compact(root.getAttribute('aria-label') || root.getAttribute('data-testid') || root.getAttribute('id') || root.querySelector('h1,h2,h3,h4,[role="heading"],legend,label')?.textContent || textOf(root).slice(0, 90));
                const options = root.tagName.toLowerCase() === 'select'
                    ? Array.from((root as HTMLSelectElement).options).map((option) => compact(option.text || option.value)).filter(Boolean).slice(0, 30)
                    : optionLikeText(root);
                const controls = Array.from(root.querySelectorAll('button,a,input,select,[role="button"],[role="combobox"]'))
                    .filter((el, controlIndex, arr) => arr.indexOf(el) === controlIndex && isVisible(el))
                    .map((el) => {
                        const labelText = textOf(el);
                        return {
                            role: el.getAttribute('role') || el.tagName.toLowerCase(),
                            label: labelText.slice(0, 90),
                            selectors: selectorFor(el, labelText),
                        };
                    })
                    .filter((control) => control.label || control.selectors.length)
                    .slice(0, 12);
                return {
                    index: index + 1,
                    label,
                    options,
                    controls,
                    relevant: looksFilterSurface(label, root) || options.length >= 2 || root.tagName.toLowerCase() === 'select',
                };
            }).filter((group) => group.relevant && (group.label || group.options.length || group.controls.length));
            return groups.slice(0, 16);
        });
        if (!groups.length) return '';
        const lines = groups.map((group) => {
            const options = group.options.length ? ` options=[${group.options.map((item) => item.slice(0, 70)).join(' | ')}]` : '';
            const controls = group.controls.length
                ? ` controls=[${group.controls.map((control) => `${control.role}:${control.label || control.selectors[0] || '?'}`).join(' | ')}]`
                : '';
            const selectorHints = group.controls.flatMap((control) => control.selectors).slice(0, 8);
            return `  filter#${group.index} "${group.label.slice(0, 120)}"${options}${controls}${selectorHints.length ? ` selectors=[${selectorHints.join(' | ')}]` : ''}`;
        });
        return limitText(lines.join('\n'), 8500);
    } catch (e) {
        devLog('browserAgent: filter controls failed:', e);
        return '';
    }
}

async function getInteractiveElementsText(page: Page): Promise<string> {
    try {
        const elements = await page.$$eval(
            INTERACTIVE_ELEMENT_SELECTOR,
            (nodes) => {
                const cssEscape = (value: string) => {
                    const css = (window as any).CSS;
                    if (css?.escape) return css.escape(value);
                    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
                };
                const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const compact = (value: string | null | undefined) =>
                    String(value ?? '').replace(/\s+/g, ' ').trim();
                const isVisible = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const textOf = (el: Element) => {
                    const input = el as HTMLInputElement;
                    const labelText = Array.from(input.labels ?? []).map((l) => compact(l.innerText)).join(' ');
                    const aria = compact(el.getAttribute('aria-label'));
                    const placeholder = compact(el.getAttribute('placeholder'));
                    const title = compact(el.getAttribute('title'));
                    const text = compact((el as HTMLElement).innerText || el.textContent);
                    const value = input.type === 'submit' || input.type === 'button' ? compact(input.value) : '';
                    const imageAlt = Array.from(el.querySelectorAll('img'))
                        .map((img) => compact(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('src')?.split('/').pop()))
                        .filter(Boolean)
                        .join(' ');
                    const svgTitle = Array.from(el.querySelectorAll('svg title'))
                        .map((node) => compact(node.textContent))
                        .filter(Boolean)
                        .join(' ');
                    return compact(labelText || aria || placeholder || title || value || text || imageAlt || svgTitle);
                };
                const roleOf = (el: Element) => {
                    const explicit = el.getAttribute('role');
                    if (explicit) return explicit;
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'a') return 'link';
                    if (tag === 'button') return 'button';
                    if (tag === 'select') return 'select';
                    if (tag === 'textarea') return 'textbox';
                    if (tag === 'input') {
                        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
                        if (type === 'checkbox') return 'checkbox';
                        if (type === 'radio') return 'radio';
                        if (['submit', 'button', 'reset'].includes(type)) return 'button';
                        return 'textbox';
                    }
                    return tag;
                };
                const selectorFor = (el: Element, label: string, role: string) => {
                    const tag = el.tagName.toLowerCase();
                    const selectors: string[] = [];
                    const id = compact(el.getAttribute('id'));
                    const testId = compact(el.getAttribute('data-testid'));
                    const dataTest = compact(el.getAttribute('data-test'));
                    const name = compact(el.getAttribute('name'));
                    const aria = compact(el.getAttribute('aria-label'));
                    const placeholder = compact(el.getAttribute('placeholder'));
                    const autocomplete = compact(el.getAttribute('autocomplete'));
                    const type = compact(el.getAttribute('type'));

                    if (testId) selectors.push(`testid=${testId}`);
                    if (dataTest) selectors.push(`css=${tag}[data-test="${attrEscape(dataTest)}"]`);
                    if (id) selectors.push(`css=#${cssEscape(id)}`);
                    if (name) selectors.push(`css=${tag}[name="${attrEscape(name)}"]`);
                    if (aria) selectors.push(`css=${tag}[aria-label="${attrEscape(aria)}"]`);
                    if (placeholder) selectors.push(`placeholder=${placeholder}`);
                    if (label && ['textbox', 'select'].includes(role)) selectors.push(`label=${label.slice(0, 90)}`);
                    if (autocomplete) selectors.push(`css=${tag}[autocomplete="${attrEscape(autocomplete)}"]`);
                    if (type && name) selectors.push(`css=${tag}[type="${attrEscape(type)}"][name="${attrEscape(name)}"]`);
                    if (label && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'].includes(role)) {
                        selectors.push(`role=${role}[name="${attrEscape(label.slice(0, 80))}"]`);
                    }
                    if (label) selectors.push(`text=${label.slice(0, 90)}`);
                    return selectors;
                };

                return nodes
                    .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                    .slice(0, 120)
                    .map((el, index) => {
                        const ref = `k${index + 1}`;
                        el.setAttribute('data-kira-browser-ref', ref);
                        const role = roleOf(el);
                        const label = textOf(el);
                        const contextOf = () => {
                            let parent = el.parentElement;
                            for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
                                const text = compact(parent.innerText || parent.textContent);
                                if (!text || text === label || text.length < 8) continue;
                                const interactiveCount = parent.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').length;
                                if (interactiveCount <= 8 || text.length <= 420) {
                                    return text.slice(0, 260);
                                }
                            }
                            return '';
                        };
                        const tag = el.tagName.toLowerCase();
                        const input = el as HTMLInputElement;
                        const type = tag === 'input' ? input.type : '';
                        const robustSelectors = selectorFor(el, label, role).slice(0, 4);
                        const indexSelector = `index=${index + 1}`;
                        const refSelector = `domref=${ref}`;
                        const selectors = [refSelector, ...robustSelectors];
                        const rect = el.getBoundingClientRect();
                        const href = tag === 'a' ? compact((el as HTMLAnchorElement).href) : '';
                        const flags = [
                            input.required ? 'required' : '',
                            input.disabled ? 'disabled' : '',
                            input.checked ? 'checked' : '',
                        ].filter(Boolean);
                        return {
                            index: index + 1,
                            role,
                            tag,
                            type,
                            label,
                            selector: selectors[0] ?? '',
                            alt: [...selectors.slice(1), indexSelector].slice(0, 5),
                            href,
                            context: contextOf(),
                            flags,
                            area: Math.round(rect.width * rect.height),
                        };
                    })
                    .filter((el) => el.label || el.selector || ['textbox', 'select', 'checkbox', 'radio'].includes(el.role));
            }
        );

        if (!elements.length) return '';
        const lines = elements
            .slice(0, 70)
            .map((el) => {
                const type = el.type ? `/${el.type}` : '';
                const label = el.label ? ` "${el.label.slice(0, 90)}"` : '';
                const flags = el.flags.length ? ` [${el.flags.join(',')}]` : '';
                const href = el.href ? ` href=${el.href.slice(0, 120)}` : '';
                const context = el.context ? ` context="${el.context.slice(0, 180)}"` : '';
                const alt = el.alt.length ? ` alt: ${el.alt.join(' | ')}` : '';
                return `  #${el.index} ${el.role}${type}${label}${flags}${href}${context} -> ${el.selector}${alt}`;
            });
        return limitText(lines.join('\n'), 7000);
    } catch (e) {
        devLog('browserAgent: interactive snapshot failed:', e);
        return '';
    }
}

async function getVisualControlMapText(page: Page): Promise<string> {
    try {
        const controls = await page.evaluate((clickableSelector) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const cssEscape = (value: string) => {
                const css = (window as any).CSS;
                if (css?.escape) return css.escape(value);
                return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
            };
            const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const unique = (values: string[]) => {
                const result: string[] = [];
                for (const value of values.map(compact).filter(Boolean)) {
                    const key = value.toLocaleLowerCase('ru-RU');
                    if (!result.some((existing) => existing.toLocaleLowerCase('ru-RU') === key)) result.push(value);
                }
                return result;
            };
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const roleOf = (el: Element) => {
                const explicit = compact(el.getAttribute('role'));
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'a') return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
                return tag;
            };
            const codeHintsOf = (el: Element) => {
                const href = el instanceof HTMLAnchorElement ? el.href : '';
                const raw = [
                    el.id,
                    el.getAttribute('class'),
                    el.getAttribute('data-testid'),
                    el.getAttribute('data-test'),
                    el.getAttribute('name'),
                    el.getAttribute('aria-controls'),
                    href ? href.split('/').pop() : '',
                ].filter(Boolean).join(' ');
                return unique(
                    raw
                        .replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, '')
                        .split(/[^a-zа-яё0-9#№]+/iu)
                        .filter((part) => part.length >= 3 && part.length <= 40)
                ).slice(0, 8);
            };
            const visualHintsOf = (el: Element) => {
                const imgHints = Array.from(el.matches('img') ? [el as HTMLImageElement] : el.querySelectorAll('img'))
                    .map((img) => [
                        img.getAttribute('alt'),
                        img.getAttribute('title'),
                        img.getAttribute('aria-label'),
                        img.getAttribute('src')?.split('/').pop()?.replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, ''),
                    ].filter(Boolean).join(' '))
                    .filter(Boolean);
                const svgHints = Array.from(el.querySelectorAll('svg, svg *'))
                    .flatMap((node) => [
                        (node as Element).getAttribute('aria-label'),
                        (node as Element).getAttribute('title'),
                        compact((node as Element).querySelector('title')?.textContent),
                        (node as Element).getAttribute('href'),
                        (node as Element).getAttribute('xlink:href'),
                        (node as Element).getAttribute('class'),
                    ])
                    .filter((value): value is string => Boolean(value));
                const style = window.getComputedStyle(el);
                const background = style.backgroundImage && style.backgroundImage !== 'none'
                    ? style.backgroundImage.replace(/^url\(["']?|["']?\)$/giu, '').split('/').pop()?.replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, '')
                    : '';
                return unique([...imgHints, ...svgHints, background || '', ...codeHintsOf(el)]).slice(0, 12);
            };
            const textOf = (el: Element) => {
                const input = el as HTMLInputElement;
                const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
                const aria = compact(el.getAttribute('aria-label'));
                const title = compact(el.getAttribute('title'));
                const text = compact((el as HTMLElement).innerText || el.textContent);
                const value = ['submit', 'button', 'reset'].includes((input.type || '').toLowerCase()) ? compact(input.value) : '';
                return compact(labelText || aria || title || value || text || visualHintsOf(el).join(' '));
            };
            const selectorFor = (el: Element, label: string, role: string) => {
                const tag = el.tagName.toLowerCase();
                const selectors: string[] = [];
                const id = compact(el.getAttribute('id'));
                const testId = compact(el.getAttribute('data-testid'));
                const dataTest = compact(el.getAttribute('data-test'));
                const name = compact(el.getAttribute('name'));
                const aria = compact(el.getAttribute('aria-label'));
                const title = compact(el.getAttribute('title'));
                const hrefAttr = el instanceof HTMLAnchorElement ? compact(el.getAttribute('href')) : '';
                const href = el instanceof HTMLAnchorElement ? compact(hrefAttr || el.href) : '';
                if (testId) selectors.push(`testid=${testId}`);
                if (dataTest) selectors.push(`css=${tag}[data-test="${attrEscape(dataTest)}"]`);
                if (id) selectors.push(`css=#${cssEscape(id)}`);
                if (name) selectors.push(`css=${tag}[name="${attrEscape(name)}"]`);
                if (aria) selectors.push(`css=${tag}[aria-label="${attrEscape(aria)}"]`);
                if (title) selectors.push(`css=${tag}[title="${attrEscape(title)}"]`);
                if (href) selectors.push(`css=a[href="${attrEscape(href)}"]`);
                if (hrefAttr && hrefAttr !== href) selectors.push(`css=a[href="${attrEscape(hrefAttr)}"]`);
                if (label && ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'].includes(role)) {
                    selectors.push(`role=${role}[name="${attrEscape(label.slice(0, 80))}"]`);
                }
                if (label && !/^(img|svg|icon|button|link)$/iu.test(label)) selectors.push(`text=${label.slice(0, 90)}`);
                return unique(selectors).slice(0, 5);
            };
            const isActionable = (el: Element) => {
                const tag = el.tagName.toLowerCase();
                const type = ((el as HTMLInputElement).type || '').toLowerCase();
                const role = roleOf(el).toLowerCase();
                const style = window.getComputedStyle(el);
                if (tag === 'a' || tag === 'button') return true;
                if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return true;
                if (['button', 'link', 'menuitem', 'tab'].includes(role)) return true;
                if (el.getAttribute('onclick')) return true;
                if (style.cursor === 'pointer' && (textOf(el) || visualHintsOf(el).length)) return true;
                return false;
            };
            const contextFor = (el: Element) => {
                let parent = el.parentElement;
                for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
                    const text = compact(parent.innerText || parent.textContent);
                    const rect = parent.getBoundingClientRect();
                    const controls = parent.querySelectorAll(clickableSelector).length;
                    if (text && text.length >= 4 && text.length <= 900 && controls <= 10 && rect.width <= window.innerWidth * 1.05) {
                        return text;
                    }
                }
                return '';
            };
            const nearbyTextFor = (el: Element) => unique([
                compact((el.previousElementSibling as HTMLElement | null)?.innerText || el.previousElementSibling?.textContent),
                compact((el.nextElementSibling as HTMLElement | null)?.innerText || el.nextElementSibling?.textContent),
                compact(el.closest('label')?.textContent),
                compact(el.closest('li,article,section,tr,[role="row"],[class*="card" i],[class*="item" i]')?.querySelector('h1,h2,h3,h4,[role="heading"],strong,b')?.textContent),
            ]).join(' | ');

            return Array.from(document.querySelectorAll(clickableSelector))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el) && isActionable(el))
                .slice(0, 120)
                .map((el, index) => {
                    const rect = el.getBoundingClientRect();
                    const role = roleOf(el);
                    const label = textOf(el);
                    const selectors = selectorFor(el, label, role);
                    const visual = unique(visualHintsOf(el)).join(' | ');
                    const nearbyText = nearbyTextFor(el);
                    return {
                        index: index + 1,
                        role,
                        label,
                        visual,
                        selector: `visual=${index + 1}`,
                        altSelectors: selectors,
                        bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                        center: `${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)}`,
                        nearbyText: nearbyText.slice(0, 180),
                        context: contextFor(el).slice(0, 260),
                    };
                })
                .filter((item) => item.label || item.visual || item.altSelectors.length || item.context);
        }, CLICKABLE_CONTROL_SELECTOR);

        if (!controls.length) return '';
        const lines = controls.slice(0, 70).map((control) => {
            const label = control.label ? ` "${control.label.slice(0, 90)}"` : '';
            const visual = control.visual ? ` visual="${control.visual.slice(0, 140)}"` : '';
            const nearby = control.nearbyText ? ` nearby="${control.nearbyText}"` : '';
            const context = control.context ? ` context="${control.context.slice(0, 180)}"` : '';
            const alt = control.altSelectors.length ? ` alt: ${control.altSelectors.join(' | ')}` : '';
            return `  visual#${control.index} ${control.role}${label}${visual} bbox=${control.bbox} center=${control.center}${nearby}${context} -> ${control.selector}${alt}`;
        });
        return limitText(lines.join('\n'), 9000);
    } catch (e) {
        devLog('browserAgent: visual control map failed:', e);
        return '';
    }
}

async function getStructuredPageText(page: Page): Promise<string> {
    try {
        const blocks = await page.evaluate((interactiveSelector) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const textLinesOf = (el: Element) =>
                String((el as HTMLElement).innerText || el.textContent || '')
                    .split(/\n+/u)
                    .map(compact)
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 28);
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const textOf = (el: Element) => {
                const input = el as HTMLInputElement;
                return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
            };
            const semanticWeight = (el: HTMLElement) => {
                const tag = el.tagName.toLowerCase();
                const role = compact(el.getAttribute('role')).toLowerCase();
                const className = compact(typeof el.className === 'string' ? el.className : '');
                let score = 0;
                if (/^(article|section|li|tr|tbody|ul|ol|main)$/iu.test(tag)) score += 18;
                if (/^(article|listitem|row|gridcell|group|region)$/iu.test(role)) score += 18;
                if (/(^|[-_\s])(card|item|tile|row|result|product|event|game|quest|quiz|slot|listing|offer|entry)([-_\s]|$)/iu.test(className)) score += 28;
                if (el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],strong,b')) score += 14;
                return score;
            };
            const dateLikeLine = (line: string) =>
                /\b\d{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/iu.test(line) ||
                /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/u.test(line);
            const weakTitleLine = (line: string) => {
                const normalized = compact(line).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
                if (!normalized) return true;
                if (/^(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|обычный|тематический|онлайн|online)$/iu.test(normalized)) return true;
                if (/^(?:расписани[ея]|каталог|список|ближайш|главная|меню|навигаци[яи])\b/iu.test(normalized)) return true;
                if (/^(?:перейти|подробнее|открыть|выбрать|записаться|купить|book|buy|details|select|open)$/iu.test(normalized)) return true;
                if (/^(?:сложность|адрес|место|стоимость|цена|начало|окончание|время)\b/iu.test(normalized)) return true;
                return dateLikeLine(normalized) && normalized.length <= 28;
            };
            const titleOf = (root: HTMLElement, fullText: string, actionLabels: string[]) => {
                const titleCandidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],strong,b'))
                    .map((el) => compact((el as HTMLElement).innerText || el.textContent))
                    .filter((text) => text && text.length <= 140 && !actionLabels.includes(text) && !weakTitleLine(text));
                if (titleCandidates.length) return titleCandidates[0];

                const lines = textLinesOf(root)
                    .filter(Boolean)
                    .filter((line) => line.length <= 160 && !actionLabels.includes(line));
                return lines.find((line) => !weakTitleLine(line)) || lines[0] || fullText.slice(0, 120);
            };
            const hasListingSignal = (text: string) =>
                /\b\d{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/iu.test(text) ||
                /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/u.test(text) ||
                /\b([01]?\d|2[0-3])[:.][0-5]\d\b/u.test(text) ||
                /(?:\b\d[\d\s\u00a0]{0,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)|(?:₽|руб\.?|₸|\$|€)\s*\d[\d\s\u00a0]{0,9})/iu.test(text) ||
                /(?:адрес|ул\.|улиц|просп|шоссе|площад|зал|аудитор|онлайн|online|venue|location|address)/iu.test(text);
            const rootTooBroad = (root: HTMLElement, text: string) => {
                const rect = root.getBoundingClientRect();
                const interactiveCount = root.querySelectorAll(interactiveSelector).length;
                return root === document.body ||
                    text.length > 2800 ||
                    interactiveCount > 18 ||
                    rect.width > window.innerWidth * 1.12 ||
                    rect.height > window.innerHeight * 3.2;
            };

            const controls = Array.from(document.querySelectorAll(interactiveSelector))
                .filter((el) => isVisible(el) && textOf(el)) as HTMLElement[];
            const candidates: Array<{
                key: string;
                text: string;
                title: string;
                actions: string[];
                hrefs: string[];
                score: number;
                top: number;
            }> = [];

            for (const control of controls.slice(0, 140)) {
                const label = textOf(control);
                let parent = control.parentElement;
                let best: HTMLElement | null = null;
                let bestScore = Number.NEGATIVE_INFINITY;

                for (let depth = 0; parent && depth < 9; depth += 1, parent = parent.parentElement) {
                    const text = textLinesOf(parent).join(' | ') || compact(parent.innerText || parent.textContent);
                    if (!text || text === label || text.length < 16) continue;

                    const interactiveCount = parent.querySelectorAll(interactiveSelector).length;
                    if (rootTooBroad(parent, text)) continue;

                    const score =
                        semanticWeight(parent) +
                        Math.max(0, 36 - depth * 5) +
                        Math.max(0, 18 - Math.floor(text.length / 180)) -
                        Math.max(0, interactiveCount - 1) * 2;

                    if (score > bestScore) {
                        best = parent;
                        bestScore = score;
                    }
                }

                if (!best) continue;
                const lines = textLinesOf(best);
                const text = lines.join(' | ') || compact(best.innerText || best.textContent);
                const actions = Array.from(best.querySelectorAll(interactiveSelector))
                    .filter((el) => isVisible(el))
                    .map((el) => textOf(el))
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 8);
                if (!actions.length) continue;

                const hrefs = Array.from(best.querySelectorAll('a[href]'))
                    .map((el) => compact((el as HTMLAnchorElement).href))
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 4);
                const rect = best.getBoundingClientRect();
                const title = titleOf(best, text, actions);
                const key = `${title}|${actions.join('|')}|${Math.round(rect.top / 25)}`;
                candidates.push({
                    key,
                    text: text.slice(0, 900),
                    title: title.slice(0, 160),
                    actions,
                    hrefs,
                    score: bestScore,
                    top: Math.round(rect.top + window.scrollY),
                });
            }

            const genericRoots = Array.from(document.querySelectorAll([
                'article',
                'li',
                'tr',
                '[role="article"]',
                '[role="listitem"]',
                '[role="row"]',
                '[role="gridcell"]',
                '[role="group"]',
                '[class*="card" i]',
                '[class*="item" i]',
                '[class*="tile" i]',
                '[class*="event" i]',
                '[class*="game" i]',
                '[class*="quest" i]',
                '[class*="quiz" i]',
                '[class*="slot" i]',
                '[class*="listing" i]',
                '[class*="schedule" i]',
                '[class*="offer" i]',
                '[class*="entry" i]',
            ].join(','))).filter((el, index, arr): el is HTMLElement =>
                arr.indexOf(el) === index && el instanceof HTMLElement && isVisible(el)
            );
            const dateRichRoots = Array.from(document.querySelectorAll('body *'))
                .filter((el, index, arr): el is HTMLElement => {
                    if (arr.indexOf(el) !== index || !(el instanceof HTMLElement) || !isVisible(el)) return false;
                    const text = textLinesOf(el).join(' | ');
                    return text.length >= 16 && text.length <= 1800 && hasListingSignal(text);
                })
                .slice(0, 500);

            for (const root of [...new Set([...genericRoots, ...dateRichRoots])]) {
                const lines = textLinesOf(root);
                const text = lines.join(' | ') || compact(root.innerText || root.textContent);
                if (!text || text.length < 16 || rootTooBroad(root, text)) continue;

                const actions = Array.from(root.querySelectorAll(interactiveSelector))
                    .filter((el) => isVisible(el))
                    .map((el) => textOf(el))
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 8);
                const hrefs = Array.from(root.querySelectorAll('a[href]'))
                    .map((el) => compact((el as HTMLAnchorElement).href))
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 4);
                if (!actions.length && !hrefs.length && !hasListingSignal(text)) continue;

                const rect = root.getBoundingClientRect();
                const title = titleOf(root, text, actions);
                const key = `${title}|${actions.join('|')}|${Math.round(rect.top / 25)}|generic`;
                candidates.push({
                    key,
                    text: text.slice(0, 900),
                    title: title.slice(0, 160),
                    actions,
                    hrefs,
                    score: semanticWeight(root) + (hasListingSignal(text) ? 48 : 0) + Math.max(0, 18 - Math.floor(text.length / 180)),
                    top: Math.round(rect.top + window.scrollY),
                });
            }

            const seen = new Set<string>();
            return candidates
                .sort((a, b) => a.top - b.top || b.score - a.score)
                .filter((block) => {
                    const normalized = `${block.title}|${block.actions.join('|')}|${block.text.slice(0, 220)}`;
                    if (seen.has(normalized)) return false;
                    seen.add(normalized);
                    return true;
                })
                .slice(0, 24);
        }, INTERACTIVE_ELEMENT_SELECTOR);

        if (!blocks.length) return '';
        const lines = blocks.map((block, index) => {
            const actions = block.actions.map((action) => `"${action.slice(0, 80)}"`).join(', ');
            const hrefs = block.hrefs.length ? ` hrefs=[${block.hrefs.map((href) => href.slice(0, 110)).join(' | ')}]` : '';
            return [
                `  block#${index + 1} title="${block.title}" actions=[${actions}]${hrefs}`,
                `    text=${block.text.slice(0, 650)}`,
            ].join('\n');
        });
        return limitText(lines.join('\n'), 8500);
    } catch (e) {
        devLog('browserAgent: structured page snapshot failed:', e);
        return '';
    }
}

async function getSemanticPageMapText(page: Page): Promise<string> {
    try {
        const landmarks = await page.evaluate((interactiveSelector) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const roleOf = (el: Element) => {
                const explicit = compact(el.getAttribute('role'));
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'nav') return 'navigation';
                if (tag === 'main') return 'main';
                if (tag === 'header') return 'banner';
                if (tag === 'footer') return 'contentinfo';
                if (tag === 'form') return 'form';
                if (tag === 'aside') return 'complementary';
                if (tag === 'article') return 'article';
                if (tag === 'section') return 'section';
                return tag;
            };
            const labelOf = (el: Element) => {
                const heading = compact(el.querySelector('h1,h2,h3,h4,[role="heading"]')?.textContent);
                const aria = compact(el.getAttribute('aria-label'));
                const labelledBy = compact(el.getAttribute('aria-labelledby'))
                    .split(/\s+/u)
                    .map((id) => compact(document.getElementById(id)?.textContent))
                    .filter(Boolean)
                    .join(' ');
                const id = compact(el.getAttribute('id'));
                const cls = compact(el.getAttribute('class'));
                return compact(heading || aria || labelledBy || id || cls || roleOf(el));
            };
            const actionText = (el: Element) => {
                const input = el as HTMLInputElement;
                const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
                const value = ['button', 'submit', 'reset'].includes((input.type || '').toLowerCase()) ? compact(input.value) : '';
                return compact(labelText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || value || (el as HTMLElement).innerText || el.textContent);
            };
            const actionRole = (el: Element) => {
                const tag = el.tagName.toLowerCase();
                const explicit = compact(el.getAttribute('role'));
                if (explicit) return explicit;
                if (tag === 'a') return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
                return tag;
            };
            const actionsIn = (root: Element) =>
                Array.from(root.querySelectorAll(interactiveSelector))
                    .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                    .map((el) => ({
                        role: actionRole(el),
                        label: actionText(el).slice(0, 90),
                        href: el instanceof HTMLAnchorElement ? compact(el.href) : '',
                    }))
                    .filter((item) => item.label || item.href)
                    .filter((item, index, arr) => arr.findIndex((other) => other.role === item.role && other.label === item.label && other.href === item.href) === index)
                    .slice(0, 10);
            const textSample = (el: Element) => compact((el as HTMLElement).innerText || el.textContent).slice(0, 360);
            const roots = Array.from(document.querySelectorAll([
                'header',
                'nav',
                'main',
                'aside',
                'footer',
                'form',
                '[role="banner"]',
                '[role="navigation"]',
                '[role="main"]',
                '[role="search"]',
                '[role="dialog"]',
                '[role="form"]',
                '[aria-modal="true"]',
                'section',
                'article',
            ].join(',')))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                .filter((el) => {
                    const role = roleOf(el);
                    const text = textSample(el);
                    const actions = el.querySelectorAll(interactiveSelector).length;
                    if (['banner', 'navigation', 'main', 'search', 'dialog', 'form', 'contentinfo', 'complementary'].includes(role)) return true;
                    return actions > 0 && text.length >= 8 && text.length <= 1800;
                })
                .slice(0, 22);

            return roots.map((root, index) => {
                const rect = root.getBoundingClientRect();
                const actions = actionsIn(root);
                const inputs = Array.from(root.querySelectorAll('input,textarea,select'))
                    .filter(isVisible)
                    .map((el) => actionText(el).slice(0, 80))
                    .filter(Boolean)
                    .slice(0, 8);
                const links = actions
                    .filter((action) => action.href)
                    .map((action) => `${action.label || action.role} -> ${action.href}`)
                    .slice(0, 5);
                return {
                    index: index + 1,
                    role: roleOf(root),
                    label: labelOf(root).slice(0, 120),
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                    actions,
                    inputs,
                    links,
                    text: textSample(root),
                };
            });
        }, INTERACTIVE_ELEMENT_SELECTOR);

        if (!landmarks.length) return '';
        const lines = landmarks.map((item) => {
            const actions = item.actions.length
                ? ` actions=[${item.actions.map((action) => `${action.role}:${action.label || action.href.slice(0, 70)}`).join(' | ')}]`
                : '';
            const inputs = item.inputs.length ? ` fields=[${item.inputs.join(' | ')}]` : '';
            const links = item.links.length ? ` links=[${item.links.map((link) => link.slice(0, 120)).join(' | ')}]` : '';
            return [
                `  area#${item.index} role=${item.role} label="${item.label}" bbox=${item.bbox}${actions}${inputs}${links}`,
                item.text ? `    text=${item.text}` : '',
            ].filter(Boolean).join('\n');
        });
        return limitText(lines.join('\n'), 8500);
    } catch (e) {
        devLog('browserAgent: semantic page map failed:', e);
        return '';
    }
}

async function getStructuredDataText(page: Page): Promise<string> {
    try {
        const data = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const absolutize = (value: string | null | undefined) => {
                const raw = compact(value);
                if (!raw) return '';
                try {
                    return new URL(raw, window.location.href).href;
                } catch {
                    return raw;
                }
            };
            const metaContent = (selector: string) => compact(document.querySelector<HTMLMetaElement>(selector)?.content);
            const meta = {
                title: compact(document.title),
                description: metaContent('meta[name="description"]'),
                ogTitle: metaContent('meta[property="og:title"]'),
                ogDescription: metaContent('meta[property="og:description"]'),
                ogType: metaContent('meta[property="og:type"]'),
                ogUrl: absolutize(metaContent('meta[property="og:url"]')),
                canonical: absolutize(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href),
            };
            const flattenJsonLd = (value: unknown): any[] => {
                if (!value) return [];
                if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
                if (typeof value !== 'object') return [];
                const obj = value as Record<string, any>;
                return [
                    obj,
                    ...flattenJsonLd(obj['@graph']),
                    ...flattenJsonLd(obj.itemListElement),
                ];
            };
            const simplify = (obj: Record<string, any>) => {
                const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
                const address = typeof obj.address === 'object' && obj.address
                    ? [obj.address.streetAddress, obj.address.addressLocality, obj.address.addressRegion, obj.address.addressCountry].map(compact).filter(Boolean).join(', ')
                    : compact(obj.address);
                return {
                    type: compact(Array.isArray(obj['@type']) ? obj['@type'].join(',') : obj['@type']),
                    name: compact(obj.name || obj.headline || obj.title),
                    url: absolutize(obj.url || obj.mainEntityOfPage?.['@id'] || obj['@id']),
                    description: compact(obj.description).slice(0, 260),
                    price: compact(offer?.price || offer?.lowPrice || obj.price),
                    currency: compact(offer?.priceCurrency || obj.priceCurrency),
                    availability: compact(offer?.availability),
                    startDate: compact(obj.startDate || obj.datePublished || obj.dateModified),
                    endDate: compact(obj.endDate),
                    address,
                };
            };
            const jsonLd = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))
                .slice(0, 12)
                .flatMap((script) => {
                    try {
                        return flattenJsonLd(JSON.parse(script.textContent || 'null'));
                    } catch {
                        return [];
                    }
                })
                .map(simplify)
                .filter((item) => item.type || item.name || item.url || item.description)
                .filter((item, index, arr) => arr.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index)
                .slice(0, 18);
            const importantLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
                .map((link) => ({
                    text: compact(link.innerText || link.textContent || link.getAttribute('aria-label') || link.getAttribute('title')).slice(0, 90),
                    href: absolutize(link.getAttribute('href')),
                }))
                .filter((link) => link.href && /(download|pdf|ics|calendar|checkout|cart|order|booking|reserve|product|item|event|ticket|отчет|отчёт|документ|квитанц)/iu.test(`${link.text} ${link.href}`))
                .filter((link, index, arr) => arr.findIndex((other) => other.text === link.text && other.href === link.href) === index)
                .slice(0, 12);
            return { meta, jsonLd, importantLinks };
        });

        const lines: string[] = [];
        const metaParts = [
            data.meta.title ? `title="${data.meta.title.slice(0, 160)}"` : '',
            data.meta.description ? `description="${data.meta.description.slice(0, 220)}"` : '',
            data.meta.ogType ? `ogType=${data.meta.ogType}` : '',
            data.meta.ogUrl ? `ogUrl=${data.meta.ogUrl.slice(0, 220)}` : '',
            data.meta.canonical ? `canonical=${data.meta.canonical.slice(0, 220)}` : '',
        ].filter(Boolean);
        if (metaParts.length) lines.push(`  meta ${metaParts.join(' ')}`);
        for (const item of data.jsonLd) {
            const parts = [
                item.type ? `type=${item.type}` : '',
                item.name ? `name="${item.name.slice(0, 160)}"` : '',
                item.price ? `price="${item.price}${item.currency ? ` ${item.currency}` : ''}"` : '',
                item.availability ? `availability="${item.availability.slice(0, 80)}"` : '',
                item.startDate ? `start="${item.startDate.slice(0, 80)}"` : '',
                item.endDate ? `end="${item.endDate.slice(0, 80)}"` : '',
                item.address ? `address="${item.address.slice(0, 180)}"` : '',
                item.url ? `url=${item.url.slice(0, 220)}` : '',
            ].filter(Boolean);
            if (parts.length) lines.push(`  jsonld ${parts.join(' ')}`);
            if (item.description) lines.push(`    description=${item.description}`);
        }
        for (const link of data.importantLinks) {
            lines.push(`  important-link "${link.text || '(без текста)'}" -> ${link.href.slice(0, 220)}`);
        }
        return limitText(lines.join('\n'), 7000);
    } catch (e) {
        devLog('browserAgent: structured data extraction failed:', e);
        return '';
    }
}

async function getProductCardsText(page: Page): Promise<string> {
    try {
        const products = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const classText = (el: Element) =>
                compact(`${el.getAttribute('class') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-test') || ''}`);
            const looksProductHref = (href: string) => {
                try {
                    const url = new URL(href, window.location.href);
                    const path = url.pathname.toLowerCase();
                    return /(?:^|\/)(?:p|product|products|item)(?:\/|$)/iu.test(path) ||
                        /\/p\//iu.test(path);
                } catch {
                    return false;
                }
            };
            const hasPrice = (text: string) =>
                /(?:\b\d[\d\s\u00a0]{1,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)|(?:₽|руб\.?|₸|\$|€)\s*\d)/iu.test(text);
            const lineLooksMeta = (line: string) =>
                !line ||
                hasPrice(line) ||
                /^(?:-\d+%|\d+(?:[.,]\d+)?|\(\d+\)|до\s+конца|доставка|новинка|скидка|распродажа|premium|favorite|избранное|one size|размер|xs|s|m|l|xl)$/iu.test(line);
            const priceLineOf = (lines: string[], text: string) => {
                const line = lines.find((item) => hasPrice(item));
                if (line) return line.slice(0, 120);
                const match = text.match(/\b\d[\d\s\u00a0]{1,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)/iu);
                return match?.[0] ? compact(match[0]).slice(0, 120) : '';
            };

            const anchors = Array.from(document.querySelectorAll('a[href]'))
                .filter((el, index, arr) => arr.indexOf(el) === index)
                .filter((el) => isVisible(el) || looksProductHref((el as HTMLAnchorElement).href)) as HTMLAnchorElement[];

            const candidates: Array<{
                href: string;
                brand: string;
                name: string;
                price: string;
                imageHint: string;
                text: string;
                top: number;
                score: number;
            }> = [];

            for (const anchor of anchors.slice(0, 260)) {
                const href = compact(anchor.href || anchor.getAttribute('href'));
                if (!href || !looksProductHref(href)) continue;

                let parent: HTMLElement | null = anchor;
                let best: HTMLElement | null = null;
                let bestScore = Number.NEGATIVE_INFINITY;
                for (let depth = 0; parent && depth < 9; depth += 1, parent = parent.parentElement) {
                    const text = compact(parent.innerText || parent.textContent);
                    if (!text || text.length < 8 || text.length > 1400) continue;

                    const rect = parent.getBoundingClientRect();
                    const linkCount = parent.querySelectorAll('a[href]').length;
                    const tooBroad =
                        parent === document.body ||
                        rect.width > window.innerWidth * 1.25 ||
                        rect.height > window.innerHeight * 2.6 ||
                        linkCount > 16;
                    if (tooBroad) continue;

                    const productClass = /(product|catalog|sku|card|tile|goods|item|x-product|products-list|grid)/iu.test(classText(parent));
                    const score =
                        (productClass ? 42 : 0) +
                        (hasPrice(text) ? 36 : 0) +
                        Math.max(0, 34 - depth * 5) +
                        Math.max(0, 14 - linkCount) -
                        Math.max(0, Math.floor(text.length / 220) - 1) * 4;
                    if (score > bestScore) {
                        best = parent;
                        bestScore = score;
                    }
                }

                const root = best || anchor;
                const text = compact(root.innerText || root.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title'));
                const lines = text
                    .split(/\n+/u)
                    .map((line) => compact(line))
                    .filter(Boolean);
                const titleLines = lines
                    .filter((line) => !lineLooksMeta(line))
                    .filter((line, index, arr) => arr.indexOf(line) === index)
                    .slice(0, 3);
                const imageHint = Array.from(root.querySelectorAll('img, picture source'))
                    .flatMap((node) => [
                        node.getAttribute('alt'),
                        node.getAttribute('title'),
                        node.getAttribute('aria-label'),
                        node.getAttribute('src'),
                        node.getAttribute('srcset'),
                        node.getAttribute('data-src'),
                    ])
                    .map((value) => compact(value?.split(/[,\s]+/u)[0]?.split('/').pop()?.replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, '') || value))
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 8)
                    .join(' | ');
                const rect = root.getBoundingClientRect();
                candidates.push({
                    href,
                    brand: titleLines[0] || compact(anchor.getAttribute('aria-label') || anchor.getAttribute('title') || ''),
                    name: titleLines.slice(1).join(' ').slice(0, 160),
                    price: priceLineOf(lines, text),
                    imageHint: imageHint.slice(0, 260),
                    text: text.slice(0, 700),
                    top: Math.round(rect.top + window.scrollY),
                    score: bestScore,
                });
            }

            const seen = new Set<string>();
            return candidates
                .sort((a, b) => a.top - b.top || b.score - a.score)
                .filter((item) => {
                    if (seen.has(item.href)) return false;
                    seen.add(item.href);
                    return true;
                })
                .slice(0, 24);
        });

        if (!products.length) return '';
        const lines = products.map((product, index) => {
            const parts = [
                `product#${index + 1}`,
                product.brand ? `brand="${product.brand.slice(0, 90)}"` : '',
                product.name ? `name="${product.name.slice(0, 140)}"` : '',
                product.price ? `price="${product.price.slice(0, 80)}"` : '',
                product.imageHint ? `image="${product.imageHint.slice(0, 140)}"` : '',
                `href=${product.href.slice(0, 220)}`,
            ].filter(Boolean);
            return [
                `  ${parts.join(' ')}`,
                product.text ? `    text=${product.text.slice(0, 520)}` : '',
            ].filter(Boolean).join('\n');
        });
        return limitText(lines.join('\n'), 9000);
    } catch (e) {
        devLog('browserAgent: product card snapshot failed:', e);
        return '';
    }
}

async function getTableDiagnosticsText(page: Page): Promise<string> {
    try {
        const tables = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const textOf = (el: Element) => {
                const input = el as HTMLInputElement;
                return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
            };
            const roleOf = (el: Element) => {
                const explicit = compact(el.getAttribute('role'));
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'a') return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
                return tag;
            };
            const controlsIn = (root: Element) =>
                Array.from(root.querySelectorAll('a,button,[role="button"],[role="link"],[role="menuitem"],input[type="button"],input[type="submit"]'))
                    .filter(isVisible)
                    .map((el) => ({ role: roleOf(el), label: textOf(el).slice(0, 80) }))
                    .filter((item) => item.label)
                    .filter((item, index, arr) => arr.findIndex((other) => other.role === item.role && other.label === item.label) === index)
                    .slice(0, 8);
            const headerTexts = (root: Element) => {
                const explicit = Array.from(root.querySelectorAll('th,[role="columnheader"]'))
                    .filter(isVisible)
                    .map(textOf)
                    .filter(Boolean)
                    .slice(0, 16);
                if (explicit.length) return explicit;
                const firstRow = Array.from(root.querySelectorAll('tr,[role="row"]')).find(isVisible);
                if (!firstRow) return [];
                return Array.from(firstRow.querySelectorAll('th,td,[role="cell"],[role="gridcell"],[role="columnheader"]'))
                    .filter(isVisible)
                    .map(textOf)
                    .filter(Boolean)
                    .slice(0, 16);
            };
            const cellTexts = (row: Element) =>
                Array.from(row.querySelectorAll('td,th,[role="cell"],[role="gridcell"],[role="columnheader"]'))
                    .filter(isVisible)
                    .map(textOf)
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 16);
            const rowRoots = (root: Element) => Array.from(root.querySelectorAll('tr,[role="row"]'))
                .filter((row, index, arr) => arr.indexOf(row) === index && isVisible(row));

            const roots = Array.from(document.querySelectorAll('table,[role="table"],[role="grid"],[role="treegrid"]'))
                .filter((root, index, arr) => arr.indexOf(root) === index && isVisible(root))
                .slice(0, 8);
            return roots.map((root, tableIndex) => {
                const headers = headerTexts(root);
                const rows = rowRoots(root)
                    .map((row) => {
                        const cells = cellTexts(row);
                        const actions = controlsIn(row);
                        const text = compact((row as HTMLElement).innerText || row.textContent);
                        return { cells, actions, text: text.slice(0, 700) };
                    })
                    .filter((row) => row.cells.length || row.actions.length || row.text)
                    .slice(0, 18);
                const caption = compact(root.querySelector('caption')?.textContent || root.getAttribute('aria-label') || root.getAttribute('id') || '');
                return {
                    index: tableIndex + 1,
                    caption,
                    headers,
                    rows,
                };
            }).filter((table) => table.rows.length);
        });

        if (!tables.length) return '';
        const lines: string[] = [];
        for (const table of tables) {
            const caption = table.caption ? ` "${table.caption.slice(0, 120)}"` : '';
            const headers = table.headers.length ? ` headers=[${table.headers.map((h) => h.slice(0, 70)).join(' | ')}]` : '';
            lines.push(`  table#${table.index}${caption}${headers}`);
            table.rows.forEach((row, rowIndex) => {
                const cells = row.cells.length ? ` cells=[${row.cells.map((cell, cellIndex) => {
                    const header = table.headers[cellIndex] ? `${table.headers[cellIndex].slice(0, 32)}: ` : '';
                    return `${header}${cell.slice(0, 80)}`;
                }).join(' | ')}]` : '';
                const actions = row.actions.length ? ` actions=[${row.actions.map((action) => `${action.role} "${action.label}"`).join(', ')}]` : '';
                const fallback = !cells && row.text ? ` text="${row.text.slice(0, 220)}"` : '';
                lines.push(`    row#${rowIndex + 1}${cells}${actions}${fallback}`);
            });
        }
        return limitText(lines.join('\n'), 9000);
    } catch (e) {
        devLog('browserAgent: table diagnostics failed:', e);
        return '';
    }
}

async function getFormDiagnosticsText(page: Page): Promise<string> {
    try {
        const forms = await page.$$eval('form, [role="form"], main, body', (roots) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const labelFor = (el: Element) => {
                const input = el as HTMLInputElement;
                const id = compact(el.getAttribute('id'));
                const byLabels = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
                if (byLabels) return byLabels;
                const ariaLabel = compact(el.getAttribute('aria-label'));
                if (ariaLabel) return ariaLabel;
                const ariaLabelledBy = compact(el.getAttribute('aria-labelledby'));
                if (ariaLabelledBy) {
                    return ariaLabelledBy
                        .split(/\s+/)
                        .map((ref) => compact(document.getElementById(ref)?.innerText))
                        .filter(Boolean)
                        .join(' ');
                }
                if (id) {
                    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                    const labelText = compact((label as HTMLElement | null)?.innerText);
                    if (labelText) return labelText;
                }
                const parentPlaceholder = compact(
                    input.parentElement?.querySelector('.placeholder')?.textContent ||
                    input.parentElement?.querySelector('label')?.textContent ||
                    ''
                );
                if (parentPlaceholder) return parentPlaceholder;
                return compact(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type') || el.tagName);
            };
            const describeField = (el: Element) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
                const tag = el.tagName.toLowerCase();
                const type = tag === 'input' ? (input as HTMLInputElement).type : tag;
                const value = type === 'password'
                    ? '[скрыто]'
                    : compact((input as HTMLInputElement).value || (input as HTMLSelectElement).selectedOptions?.[0]?.text || '');
                const required = (input as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';
                const disabled = (input as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true';
                const validity = 'validationMessage' in input ? compact((input as HTMLInputElement).validationMessage) : '';
                const invalid = el.getAttribute('aria-invalid') === 'true' || Boolean(validity);
                return {
                    label: labelFor(el),
                    type,
                    value: value ? value.slice(0, 80) : '',
                    required,
                    disabled,
                    invalid,
                    validity,
                };
            };
            const errorTexts = (root: Element) =>
                Array.from(root.querySelectorAll('[role="alert"], .error, .errors, .invalid-feedback, .field-error, [aria-live="assertive"]'))
                    .filter(isVisible)
                    .map((el) => compact((el as HTMLElement).innerText || el.textContent))
                    .filter(Boolean)
                    .slice(0, 8);

            const concreteRoots = roots.filter((root) => root.matches('form, [role="form"]') && isVisible(root));
            const candidateRoots = concreteRoots.length ? concreteRoots : roots.filter(isVisible);

            return candidateRoots
                .slice(0, 4)
                .map((root, index) => {
                    const fields = Array.from(root.querySelectorAll('input, textarea, select'))
                        .filter(isVisible)
                        .slice(0, 40)
                        .map(describeField);
                    const errors = errorTexts(root);
                    return {
                        index: index + 1,
                        label: compact(root.getAttribute('aria-label') || (root as HTMLElement).innerText?.slice(0, 80)),
                        fields,
                        errors,
                    };
                })
                .filter((form) => form.fields.length || form.errors.length);
        });

        if (!forms.length) return '';
        const lines: string[] = [];
        for (const form of forms) {
            lines.push(`  form#${form.index}${form.label ? ` "${form.label.slice(0, 80)}"` : ''}`);
            for (const field of form.fields.slice(0, 25)) {
                const flags = [
                    field.required ? 'required' : '',
                    field.disabled ? 'disabled' : '',
                    field.invalid ? 'invalid' : '',
                ].filter(Boolean);
                const value = field.value ? ` value="${field.value}"` : '';
                const validity = field.validity ? ` validation="${field.validity}"` : '';
                lines.push(`    - ${field.label || '(без label)'} [${field.type}]${flags.length ? ` [${flags.join(',')}]` : ''}${value}${validity}`);
            }
            for (const error of form.errors) {
                lines.push(`    error: ${error.slice(0, 180)}`);
            }
        }
        return limitText(lines.join('\n'), 6000);
    } catch (e) {
        devLog('browserAgent: form diagnostics failed:', e);
        return '';
    }
}

async function getFormBrainText(page: Page): Promise<string> {
    try {
        const diagnostics = await page.evaluate(() => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const cssEscape = (value: string) => {
                const css = (window as any).CSS;
                if (css?.escape) return css.escape(value);
                return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
            };
            const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const labelFor = (el: Element) => {
                const input = el as HTMLInputElement;
                const labels = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
                if (labels) return labels;
                const aria = compact(el.getAttribute('aria-label'));
                if (aria) return aria;
                const labelledBy = compact(el.getAttribute('aria-labelledby'))
                    .split(/\s+/u)
                    .map((id) => compact(document.getElementById(id)?.textContent))
                    .filter(Boolean)
                    .join(' ');
                if (labelledBy) return labelledBy;
                const id = compact(el.getAttribute('id'));
                if (id) {
                    const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
                    const labelText = compact((label as HTMLElement | null)?.innerText);
                    if (labelText) return labelText;
                }
                const nearby = compact(
                    el.closest('label')?.textContent ||
                    el.parentElement?.querySelector('label,.label,[class*="label" i],[class*="placeholder" i]')?.textContent ||
                    ''
                );
                return nearby || compact(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('type') || el.tagName);
            };
            const selectorFor = (el: Element) => {
                const tag = el.tagName.toLowerCase();
                const id = compact(el.getAttribute('id'));
                const name = compact(el.getAttribute('name'));
                const placeholder = compact(el.getAttribute('placeholder'));
                const aria = compact(el.getAttribute('aria-label'));
                const testId = compact(el.getAttribute('data-testid'));
                const dataTest = compact(el.getAttribute('data-test'));
                const selectors: string[] = [];
                if (testId) selectors.push(`testid=${testId}`);
                if (dataTest) selectors.push(`css=${tag}[data-test="${attrEscape(dataTest)}"]`);
                if (id) selectors.push(`css=#${cssEscape(id)}`);
                if (name) selectors.push(`css=${tag}[name="${attrEscape(name)}"]`);
                if (placeholder) selectors.push(`placeholder=${placeholder}`);
                if (aria) selectors.push(`label=${aria}`);
                const label = labelFor(el);
                if (label) selectors.push(`label=${label.slice(0, 90)}`);
                return selectors.filter((value, index, arr) => arr.indexOf(value) === index).slice(0, 5);
            };
            const inferKind = (el: Element, label: string) => {
                const input = el as HTMLInputElement;
                const surface = `${label} ${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('placeholder') || ''} ${input.type || ''}`.toLocaleLowerCase('ru-RU');
                if ((input.type || '').toLowerCase() === 'password' || /парол|password|pass/.test(surface)) return 'password';
                if ((input.type || '').toLowerCase() === 'email' || /email|e-mail|почт/.test(surface)) return 'email';
                if ((input.type || '').toLowerCase() === 'tel' || /телефон|phone|mobile|whatsapp|telegram/.test(surface)) return 'phone';
                if ((input.type || '').toLowerCase() === 'date' || /дата|date|birthday|birth|calendar/.test(surface)) return 'date';
                if ((input.type || '').toLowerCase() === 'time' || /время|time/.test(surface)) return 'time';
                if ((input.type || '').toLowerCase() === 'number' || /колич|участник|guests|people|qty|quantity|amount|count/.test(surface)) return 'number';
                if (/имя|фио|name|first|last|surname/.test(surface)) return 'name';
                if (/компан|организац|team|company|organization|org/.test(surface)) return 'organization';
                if (/адрес|address|city|город|street|улиц/.test(surface)) return 'address';
                if (/коммент|comment|message|сообщен|note|remarks/.test(surface)) return 'comment';
                if (/поиск|search|query|найти/.test(surface)) return 'search';
                if (el.tagName.toLowerCase() === 'select') return 'select';
                if (el.tagName.toLowerCase() === 'textarea') return 'textarea';
                return 'text';
            };
            const fields = Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                .map((el, index) => {
                    const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
                    const tag = el.tagName.toLowerCase();
                    const type = tag === 'input' ? ((input as HTMLInputElement).type || 'text').toLowerCase() : tag;
                    const label = labelFor(el);
                    const value = type === 'password'
                        ? '[скрыто]'
                        : compact((input as HTMLInputElement).value || (input as HTMLSelectElement).selectedOptions?.[0]?.text || el.textContent || '');
                    const required = (input as HTMLInputElement).required || el.getAttribute('aria-required') === 'true';
                    const disabled = (input as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true';
                    const readonly = (input as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true';
                    const validity = 'validationMessage' in input ? compact((input as HTMLInputElement).validationMessage) : '';
                    const listId = compact(el.getAttribute('list'));
                    const options = tag === 'select'
                        ? Array.from((input as HTMLSelectElement).options).map((option) => compact(option.text || option.value)).filter(Boolean).slice(0, 12)
                        : listId
                            ? Array.from(document.querySelectorAll<HTMLOptionElement>(`datalist#${cssEscape(listId)} option`))
                                .map((option) => compact(option.label || option.value))
                                .filter(Boolean)
                                .slice(0, 8)
                            : [];
                    const rect = (el as HTMLElement).getBoundingClientRect();
                    return {
                        index: index + 1,
                        label,
                        kind: inferKind(el, label),
                        type,
                        value: value.slice(0, 120),
                        required,
                        missing: required && !value,
                        disabled,
                        readonly,
                        invalid: el.getAttribute('aria-invalid') === 'true' || Boolean(validity),
                        validity: validity.slice(0, 160),
                        selectors: selectorFor(el),
                        options,
                        bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                    };
                })
                .slice(0, 45);
            const submitActions = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]'))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                .map((el) => {
                    const input = el as HTMLInputElement;
                    return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
                })
                .filter((text) => /(отправ|submit|send|save|сохран|запис|зарегистр|book|reserve|confirm|подтверд|next|далее|continue|продолж)/iu.test(text))
                .filter((text, index, arr) => arr.indexOf(text) === index)
                .slice(0, 10);
            return { fields, submitActions };
        });

        if (!diagnostics.fields.length && !diagnostics.submitActions.length) return '';
        const lines: string[] = [];
        for (const field of diagnostics.fields) {
            const flags = [
                field.required ? 'required' : '',
                field.missing ? 'missing' : '',
                field.invalid ? 'invalid' : '',
                field.disabled ? 'disabled' : '',
                field.readonly ? 'readonly' : '',
            ].filter(Boolean);
            const selectors = field.selectors.length ? ` selectors=[${field.selectors.join(' | ')}]` : '';
            const value = field.value ? ` value="${field.value}"` : '';
            const options = field.options.length ? ` options=[${field.options.join(' | ')}]` : '';
            const validity = field.validity ? ` validation="${field.validity}"` : '';
            lines.push(`  field#${field.index} kind=${field.kind} label="${field.label || '(без label)'}" type=${field.type} bbox=${field.bbox}${flags.length ? ` flags=[${flags.join(',')}]` : ''}${value}${options}${validity}${selectors}`);
        }
        if (diagnostics.submitActions.length) {
            lines.push(`  submit-actions=[${diagnostics.submitActions.join(' | ')}]`);
        }
        return limitText(lines.join('\n'), 7500);
    } catch (e) {
        devLog('browserAgent: form brain failed:', e);
        return '';
    }
}

async function getModalDiagnosticsText(page: Page): Promise<string> {
    try {
        const modalSelector = [
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog',
            '.modal',
            '[class*="modal" i]',
            '[id*="modal" i]',
            '.popup',
            '[class*="popup" i]',
            '[id*="popup" i]',
            '.overlay',
            '[class*="overlay" i]',
            '[id*="overlay" i]',
            '[class*="dialog" i]',
            '[id*="dialog" i]',
            '[class*="confirm" i]',
            '[id*="confirm" i]',
            '[class*="cookie" i]',
            '[id*="cookie" i]',
            '[class*="consent" i]',
            '[id*="consent" i]',
        ].join(',');
        const interactiveSelector = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
        const modals = await page.evaluate(
            (args: { modalSelector: string; interactiveSelector: string }) => {
                const { modalSelector, interactiveSelector } = args;
                const compact = (value: string | null | undefined) =>
                    String(value ?? '').replace(/\s+/g, ' ').trim();
                const isVisible = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const textOf = (el: Element) => {
                    const input = el as HTMLInputElement;
                    return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
                };
	                const buttonTexts = (root: Element) =>
	                    Array.from(root.querySelectorAll(interactiveSelector))
	                        .filter(isVisible)
	                        .map(textOf)
	                        .filter(Boolean)
	                        .filter((value, index, arr) => arr.indexOf(value) === index)
	                        .slice(0, 10);
	                const navigationLabel = (value: string) =>
	                    /^(главная|расписание|рейтинг|франшиза|корпоративы|сертификаты|квиз\s*дома|детский\s+день\s+рождения|москва|санкт-петербург|онлайн|online|faq|контакты|вакансии)$/iu.test(value);
	                const hasDecisionIntent = (text: string, buttons: string[]) => {
	                    const surface = compact([text, ...buttons].join(' ')).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
	                    return /[?？]/u.test(text) ||
	                        /(подтверд|confirm|сможете|можете|продолжить|continue|отказ|cancel|бронир|booking|заявк|отправ|соглас|cookie|куки|закрыть|да|нет|ok|ок)/iu.test(surface);
	                };
	                const looksLikeNavigationRoot = (el: Element, text: string, buttons: string[]) => {
	                    const tag = el.tagName.toLowerCase();
	                    const role = compact(el.getAttribute('role')).toLowerCase();
	                    const classAndId = compact(`${el.getAttribute('id') || ''} ${(el as HTMLElement).className?.toString?.() || ''}`).toLowerCase();
	                    const navButtonCount = buttons.filter(navigationLabel).length;
	                    const navTextHits = ['главная', 'расписание', 'рейтинг', 'франшиза', 'корпоративы', 'сертификаты', 'квиз дома', 'детский день рождения']
	                        .filter((term) => text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').includes(term))
	                        .length;
	                    return tag === 'nav' ||
	                        tag === 'header' ||
	                        role === 'navigation' ||
	                        /(nav|navbar|navigation|main-menu|top-menu|topmenu|header|menu)/iu.test(classAndId) ||
	                        (buttons.length >= 3 && navButtonCount >= Math.min(buttons.length, 4)) ||
	                        navTextHits >= 4;
	                };
	                const looksLikePromoRoot = (text: string, buttons: string[]) => {
	                    const surface = compact([text, ...buttons].join(' ')).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
	                    const buyButtons = buttons.filter((button) => /^(купить|shop|перейти|смотреть|подробнее)$/iu.test(compact(button))).length;
	                    const promoHits = ['для образов', 'внимание к каждой детали', 'расслабленные силуэты', 'всё для отдыха', 'свобода движения', 'аксессуары', 'коллекция', 'премиум']
	                        .filter((term) => surface.includes(term))
	                        .length;
	                    return buttons.length >= 2 &&
	                        buyButtons >= Math.min(buttons.length, 4) &&
	                        promoHits >= 2 &&
	                        !/[?？]/u.test(text) &&
	                        !/(cookie|куки|consent|соглас|подтверд|confirm|отказ|cancel|заявк|брон|оплат|payment|checkout)/iu.test(surface);
	                };
	                const modalScore = (el: Element, knownModalRoot: boolean) => {
	                    const rect = el.getBoundingClientRect();
	                    const style = window.getComputedStyle(el);
	                    const classAndId = compact(`${el.getAttribute('id') || ''} ${(el as HTMLElement).className?.toString?.() || ''}`);
	                    const tag = el.tagName.toLowerCase();
	                    const role = compact(el.getAttribute('role')).toLowerCase();
	                    const text = compact((el as HTMLElement).innerText || el.textContent);
	                    const buttons = buttonTexts(el);
	                    const lowerButtons = buttons.map((button) => button.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'));
	                    const decisionIntent = hasDecisionIntent(text, buttons);
	                    const explicitlyModal = role === 'dialog' || el.getAttribute('aria-modal') === 'true' || tag === 'dialog';
	                    const technicalModal = /(cookie|consent|куки|newsletter|notification|уведомлен)/iu.test(`${classAndId} ${text}`) &&
	                        (style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute');

	                    if (!buttons.length || text.length < 8 || text.length > 1400) return -1000;
	                    if (rect.width < 80 || rect.height < 40) return -1000;
	                    if (rect.width > window.innerWidth * 0.96 && rect.height > window.innerHeight * 0.96) return -1000;
	                    if (looksLikePromoRoot(text, buttons)) return -1000;
	                    if (knownModalRoot && !explicitlyModal && !technicalModal && !decisionIntent) return -1000;
	                    if (!knownModalRoot && looksLikeNavigationRoot(el, text, buttons) && !decisionIntent) return -1000;
	                    if (!knownModalRoot && buttons.length > 6 && !decisionIntent) return -1000;

	                    let score = knownModalRoot ? 50 : 0;
	                    if (/(modal|popup|dialog|overlay|confirm|alert|swal|fancybox)/iu.test(classAndId)) score += 32;
	                    if (style.position === 'fixed' || style.position === 'sticky') score += 28;
	                    if (style.position === 'absolute') score += 14;
	                    const zIndex = Number.parseInt(style.zIndex || '0', 10);
	                    if (Number.isFinite(zIndex) && zIndex >= 10) score += 16;
	                    if (Number.isFinite(zIndex) && zIndex >= 100) score += 12;
	                    if (decisionIntent) score += 22;
	                    if (lowerButtons.some((button) => /^(да|yes|ok|ок|подтвердить|continue|продолжить)$/iu.test(button))) score += 16;
	                    if (lowerButtons.some((button) => /^(нет|no|cancel|отмена|закрыть)$/iu.test(button))) score += 12;
                    if (buttons.length >= 2 && buttons.length <= 6) score += 12;
                    if (rect.top >= -20 && rect.left >= -20 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 8;
                    return score;
                };

                const explicitRoots = Array.from(document.querySelectorAll(modalSelector)).filter(isVisible);
                const candidates = Array.from(document.querySelectorAll('body *'))
                    .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                    .filter((el) => buttonTexts(el).length > 0);
                const scored = [...explicitRoots, ...candidates]
                    .filter((el, index, arr) => arr.indexOf(el) === index)
                    .map((el) => {
                        const knownModalRoot = explicitRoots.includes(el);
                        return { el, score: modalScore(el, knownModalRoot) };
                    })
                    .filter((item) => item.score >= 42)
                    .sort((a, b) => b.score - a.score);

                const picked: Element[] = [];
                for (const { el } of scored) {
                    if (picked.some((existing) => existing.contains(el) || el.contains(existing))) continue;
                    picked.push(el);
                    if (picked.length >= 8) break;
                }

                return picked
                    .map((el, index) => ({
                        index: index + 1,
                        role: el.getAttribute('role') || el.tagName.toLowerCase(),
                        label: compact(el.getAttribute('aria-label') || el.getAttribute('id') || (el as HTMLElement).className?.toString?.()),
                        text: compact((el as HTMLElement).innerText || el.textContent).slice(0, 500),
                        buttons: buttonTexts(el),
                    }))
                    .filter((modal) => modal.text || modal.buttons.length);
            },
            { modalSelector, interactiveSelector }
        ) as Array<{ index: number; role: string; label: string; text: string; buttons: string[] }>;

        if (!modals.length) return '';
        return limitText(modals.map((modal) => {
            const label = modal.label ? ` "${modal.label.slice(0, 80)}"` : '';
            const buttons = modal.buttons.length ? ` buttons=[${modal.buttons.join(' | ')}]` : '';
            return `  modal#${modal.index} ${modal.role}${label}${buttons}\n    ${modal.text}`;
        }).join('\n'), 5000);
    } catch (e) {
        devLog('browserAgent: modal diagnostics failed:', e);
        return '';
    }
}

async function getFrameDiagnosticsText(page: Page): Promise<string> {
    const frames = page.frames().filter((frame) => frame !== page.mainFrame()).slice(0, 8);
    if (!frames.length) return '';

    const lines: string[] = [];
    for (const [index, frame] of frames.entries()) {
        try {
            const frameInfo = await frame.evaluate((interactiveSelector) => {
                const compact = (value: string | null | undefined) =>
                    String(value ?? '').replace(/\s+/g, ' ').trim();
                const cssEscape = (value: string) => {
                    const css = (window as any).CSS;
                    if (css?.escape) return css.escape(value);
                    return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
                };
                const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const isVisible = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const textOf = (el: Element) => {
                    const input = el as HTMLInputElement;
                    const labelText = Array.from(input.labels ?? []).map((l) => compact(l.innerText)).join(' ');
                    const aria = compact(el.getAttribute('aria-label'));
                    const placeholder = compact(el.getAttribute('placeholder'));
                    const title = compact(el.getAttribute('title'));
                    const text = compact((el as HTMLElement).innerText || el.textContent);
                    const value = input.type === 'submit' || input.type === 'button' ? compact(input.value) : '';
                    return compact(labelText || aria || placeholder || title || value || text);
                };
                const roleOf = (el: Element) => {
                    const explicit = el.getAttribute('role');
                    if (explicit) return explicit;
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'a') return 'link';
                    if (tag === 'button') return 'button';
                    if (tag === 'select') return 'select';
                    if (tag === 'textarea') return 'textbox';
                    if (tag === 'input') {
                        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
                        if (type === 'checkbox') return 'checkbox';
                        if (type === 'radio') return 'radio';
                        if (['submit', 'button', 'reset'].includes(type)) return 'button';
                        return 'textbox';
                    }
                    return tag;
                };
                const selectorFor = (el: Element, label: string, role: string) => {
                    const tag = el.tagName.toLowerCase();
                    const id = compact(el.getAttribute('id'));
                    const testId = compact(el.getAttribute('data-testid'));
                    const dataTest = compact(el.getAttribute('data-test'));
                    const name = compact(el.getAttribute('name'));
                    const aria = compact(el.getAttribute('aria-label'));
                    const placeholder = compact(el.getAttribute('placeholder'));
                    if (testId) return `testid=${testId}`;
                    if (dataTest) return `css=${tag}[data-test="${attrEscape(dataTest)}"]`;
                    if (id) return `css=#${cssEscape(id)}`;
                    if (name) return `css=${tag}[name="${attrEscape(name)}"]`;
                    if (aria) return `css=${tag}[aria-label="${attrEscape(aria)}"]`;
                    if (placeholder) return `placeholder=${placeholder}`;
                    if (label && ['textbox', 'select'].includes(role)) return `label=${label.slice(0, 90)}`;
                    if (label && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'].includes(role)) {
                        return `role=${role}[name="${attrEscape(label.slice(0, 80))}"]`;
                    }
                    return label ? `text=${label.slice(0, 90)}` : '';
                };
                const elements = Array.from(document.querySelectorAll(interactiveSelector))
                    .filter((el, elementIndex, arr) => arr.indexOf(el) === elementIndex && isVisible(el))
                    .slice(0, 35)
                    .map((el, elementIndex) => {
                        const role = roleOf(el);
                        const label = textOf(el);
                        const tag = el.tagName.toLowerCase();
                        const input = el as HTMLInputElement;
                        const type = tag === 'input' ? input.type : '';
                        const selector = selectorFor(el, label, role) || `index=${elementIndex + 1}`;
                        const flags = [
                            input.required ? 'required' : '',
                            input.disabled ? 'disabled' : '',
                            input.checked ? 'checked' : '',
                        ].filter(Boolean);
                        return { index: elementIndex + 1, role, type, label, selector, flags };
                    })
                    .filter((el) => el.label || el.selector || ['textbox', 'select', 'checkbox', 'radio'].includes(el.role));
                return {
                    text: document.body?.innerText ?? '',
                    elements,
                };
            }, INTERACTIVE_ELEMENT_SELECTOR).catch(() => ({ text: '', elements: [] as Array<{ index: number; role: string; type: string; label: string; selector: string; flags: string[] }> }));

            const compactText = cleanWhitespace(String(frameInfo.text || ''));
            const lowerUrl = frame.url().toLowerCase();
            const interesting =
                compactText ||
                frameInfo.elements.length > 0 ||
                /checkout|payment|auth|login|otp|sms|2fa|widget|frame/.test(lowerUrl);
            if (!interesting) continue;

            lines.push(`  frame#${index + 1} url=${frame.url().slice(0, 180)}`);
            if (compactText) lines.push(`    text=${compactText.slice(0, 700)}`);
            for (const el of frameInfo.elements.slice(0, 18)) {
                const type = el.type ? `/${el.type}` : '';
                const label = el.label ? ` "${el.label.slice(0, 80)}"` : '';
                const flags = el.flags.length ? ` [${el.flags.join(',')}]` : '';
                lines.push(`    #${el.index} ${el.role}${type}${label}${flags} -> frame=${index + 1} >> ${el.selector}`);
            }
        } catch (e) {
            devLog('browserAgent: frame diagnostics failed:', e);
        }
    }

    return limitText(lines.join('\n'), 4500);
}

async function getTabsDiagnosticsText(page: Page): Promise<string> {
    try {
        const pages = page.context().pages().filter((item) => !item.isClosed()).slice(0, 12);
        if (pages.length <= 1) return '';
        const rows = await Promise.all(pages.map(async (item, index) => {
            const title = await item.title().catch(() => '');
            const marker = item === page ? '*' : ' ';
            return `  ${marker} tab#${index + 1} title="${cleanWhitespace(title).slice(0, 120)}" url=${safeLogUrl(item.url())}`;
        }));
        return rows.join('\n');
    } catch {
        return '';
    }
}

async function getAffordanceGraphText(page: Page): Promise<string> {
    try {
        const nodes = await page.evaluate((interactiveSelector) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const isVisible = (el: Element) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const textOf = (el: Element) => {
                const input = el as HTMLInputElement;
                const labelText = Array.from(input.labels ?? []).map((l) => compact(l.innerText)).join(' ');
                return compact(labelText || (el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'));
            };
            const roleOf = (el: Element) => {
                const explicit = compact(el.getAttribute('role'));
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'a') return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'select') return 'select';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'input') {
                    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
                    if (['submit', 'button', 'reset'].includes(type)) return 'button';
                    if (['checkbox', 'radio'].includes(type)) return type;
                    return 'textbox';
                }
                return tag;
            };
            const classifyRoot = (el: HTMLElement) => {
                const tag = el.tagName.toLowerCase();
                const role = compact(el.getAttribute('role')).toLowerCase();
                const classAndId = compact(`${el.id || ''} ${el.className?.toString?.() || ''}`).toLowerCase();
                const text = compact(el.innerText || el.textContent);
                const style = window.getComputedStyle(el);
                if (role === 'dialog' || el.getAttribute('aria-modal') === 'true' || tag === 'dialog' || /(modal|popup|dialog|overlay|confirm|alert|swal|fancybox)/iu.test(classAndId)) return 'modal';
                if (tag === 'form' || role === 'form' || /(form|lead|booking|register|signup|application|заяв|брон|регист)/iu.test(classAndId)) return 'form';
                if (/^(article|li|tr)$/iu.test(tag) || /^(article|listitem|row|gridcell|group|region)$/iu.test(role) || /(card|item|tile|row|result|product|event|game|quest|quiz|slot|listing|offer|entry)/iu.test(classAndId)) return 'card';
                if ((style.position === 'fixed' || style.position === 'absolute') && /(?:\?|подтверд|confirm|сможете|можете|отказ|cancel|бронир|booking)/iu.test(text)) return 'modal';
                return 'section';
            };
            const titleOf = (root: HTMLElement, rootText: string, actions: string[]) => {
                const heading = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],strong,b'))
                    .map((el) => compact((el as HTMLElement).innerText || el.textContent))
                    .find((text) => text && text.length <= 140 && !actions.includes(text));
                if (heading) return heading;
                return rootText
                    .split(/\n+/u)
                    .map((line) => compact(line))
                    .find((line) => line && line.length <= 140 && !actions.includes(line)) || rootText.slice(0, 120);
            };
            const visibleControls = Array.from(document.querySelectorAll(interactiveSelector))
                .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el)) as HTMLElement[];
            const candidateRoots = new Set<HTMLElement>();

            for (const control of visibleControls.slice(0, 160)) {
                let parent = control.parentElement;
                for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
                    const text = compact(parent.innerText || parent.textContent);
                    if (!text || text.length < 6 || text.length > 2400) continue;
                    const controls = visibleControls.filter((el) => parent!.contains(el));
                    if (!controls.length || controls.length > 16) continue;
                    const rect = parent.getBoundingClientRect();
                    if (parent === document.body || rect.width > window.innerWidth * 1.08 || rect.height > window.innerHeight * 3.0) continue;
                    const type = classifyRoot(parent);
                    if (type !== 'section' || controls.length >= 2 || text.length <= 900) {
                        candidateRoots.add(parent);
                        break;
                    }
                }
            }

            Array.from(document.querySelectorAll('form,[role="dialog"],[aria-modal="true"],dialog,[class*="modal" i],[class*="popup" i],[class*="confirm" i]'))
                .filter((el): el is HTMLElement => el instanceof HTMLElement && isVisible(el))
                .forEach((el) => candidateRoots.add(el));

            const scored = Array.from(candidateRoots).map((root) => {
                const text = compact(root.innerText || root.textContent);
                const actions = visibleControls
                    .filter((control) => root.contains(control))
                    .map((control) => ({ label: textOf(control), role: roleOf(control) }))
                    .filter((action) => action.label)
                    .filter((action, index, arr) => arr.findIndex((other) => other.label === action.label && other.role === action.role) === index)
                    .slice(0, 10);
                const fields = Array.from(root.querySelectorAll('input,textarea,select'))
                    .filter((field) => isVisible(field))
                    .map((field) => {
                        const input = field as HTMLInputElement;
                        const label = textOf(field);
                        const required = input.required || field.getAttribute('aria-required') === 'true';
                        return `${label || field.tagName.toLowerCase()}${required ? ' *' : ''}`;
                    })
                    .filter(Boolean)
                    .filter((value, index, arr) => arr.indexOf(value) === index)
                    .slice(0, 10);
                const type = classifyRoot(root);
                const rect = root.getBoundingClientRect();
                const title = titleOf(root, text, actions.map((action) => action.label));
                let score = 0;
                if (type === 'modal') score += 100;
                if (type === 'form') score += 80;
                if (type === 'card') score += 55;
                score += Math.min(35, actions.length * 7);
                score += Math.min(25, fields.length * 6);
                if (/(запис|регист|брон|отправ|подтверд|checkout|booking|reserve|register|submit)/iu.test(text)) score += 28;
                if (rect.top >= -20 && rect.left >= -20 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 10;
                return {
                    type,
                    title: title.slice(0, 160),
                    text: text.slice(0, 850),
                    actions,
                    fields,
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                    score,
                };
            }).filter((node) => node.actions.length || node.fields.length);

            const seen = new Set<string>();
            return scored
                .sort((a, b) => b.score - a.score)
                .filter((node) => {
                    const key = `${node.type}|${node.title}|${node.actions.map((action) => action.label).join('|')}|${node.fields.join('|')}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(0, 18);
        }, INTERACTIVE_ELEMENT_SELECTOR);

        if (!nodes.length) return '';
        const lines = nodes.map((node, index) => {
            const actions = node.actions.map((action) => `${action.role} "${action.label.slice(0, 80)}"`).join(', ');
            const fields = node.fields.length ? ` fields=[${node.fields.join(' | ')}]` : '';
            return [
                `  node#${index + 1} type=${node.type} title="${node.title}" bbox=${node.bbox}${fields}`,
                `    actions=[${actions}]`,
                `    text=${node.text.slice(0, 650)}`,
            ].join('\n');
        });
        return limitText(lines.join('\n'), 9000);
    } catch (e) {
        devLog('browserAgent: affordance graph failed:', e);
        return '';
    }
}

function collectBlockerSignals(parts: string[]): string {
    const text = parts.filter(Boolean).join('\n').toLowerCase();
    const signals: string[] = [];

    const hasHumanVerificationEvidence =
        /human_verification:/i.test(text) ||
        /(я\s+не\s+(?:робот|бот)|подтвердите,\s*что\s+вы\s+не\s+(?:робот|бот)|подтвердите,\s*что\s+вы\s+человек|verify\s+(?:you\s+are|that\s+you\s+are)\s+(?:human|not\s+a\s+robot)|i'?m\s+not\s+a\s+robot|are\s+you\s+human|human\s+verification|checking\s+your\s+browser|cloudflare\s+challenge|security\s+check)/iu.test(text);
    if (hasHumanVerificationEvidence) {
        signals.push('captcha/anti-bot challenge visible');
    }

    const checks: Array<[RegExp, string]> = [
        [/(sms|смс|otp|2fa|two[-\s]?factor|одноразов[а-я\s]{0,40}(?:код|парол)|(?:введите|укажите|enter|input)[^.\n]{0,80}(?:код|code)[^.\n]{0,80}(?:sms|смс|подтвержд|безопасн|2fa|otp)|код\s+(?:из\s+(?:sms|смс)|безопасности))/i, 'one-time code or 2FA required'],
        [/(банковск\w*\s+карт|данн[ыеых]+\s+карт|номер\s+карт|card\s+number|cvv|cvc|payment\s+form|checkout|pay\s+now)/i, 'payment/card flow visible'],
        [/(паспорт|passport|снилс|snils|инн|inn|document\s+number|номер\s+документа)/i, 'identity document data requested'],
        [/(камера|микрофон|camera|microphone|allow\s+(?:camera|microphone)|camera\s+permission|microphone\s+permission|разрешите\s+доступ)/i, 'camera or microphone permission required'],
        [/(ошибка|error|invalid|required|обязательн|неверн|failed|try\s+again)/i, 'form validation or page error visible'],
        [/(войдите|sign\s+in|log\s+in|авторизац|login|password|пароль)/i, 'authentication flow visible'],
    ];

    for (const [pattern, label] of checks) {
        if (pattern.test(text) && !signals.includes(label)) signals.push(label);
    }

    return signals.length ? signals.map((signal) => `  - ${signal}`).join('\n') : '';
}

async function getPageObservation(page: Page, pageEvents: string[] = []): Promise<PageObservation> {
    const [screenshotBuf, pageState, scrollDiagnosticsText, filterControlsText, a11yText, interactiveText, structureText, semanticMapText, structuredDataText, productCardsText, tableText, affordanceGraphText, formText, formBrainText, modalText, humanVerificationText, frameText, tabsText, visualMapText, pageText, selectOptions] = await Promise.all([
        takeJpeg(page).catch((err) => {
            browserLog('observation_screenshot_failed', {
                url: safeLogUrl(page.url()),
                reason: safeErrorMessage(err),
            });
            return fallbackScreenshotBuffer();
        }),
        getPageStateText(page),
        getScrollDiagnosticsText(page),
        getFilterControlsText(page),
        getAccessibilityText(page),
        getInteractiveElementsText(page),
        getStructuredPageText(page),
        getSemanticPageMapText(page),
        getStructuredDataText(page),
        getProductCardsText(page),
        getTableDiagnosticsText(page),
        getAffordanceGraphText(page),
        getFormDiagnosticsText(page),
        getFormBrainText(page),
        getModalDiagnosticsText(page),
        getHumanVerificationDiagnosticsText(page),
        getFrameDiagnosticsText(page),
        getTabsDiagnosticsText(page),
        getVisualControlMapText(page),
        getVisiblePageText(page),
        getSelectOptions(page),
    ]);

    const blockerSignals = collectBlockerSignals([
        pageState,
        scrollDiagnosticsText,
        filterControlsText,
        a11yText,
        interactiveText,
        structureText,
        semanticMapText,
        productCardsText,
        affordanceGraphText,
        formBrainText,
        formText,
        modalText,
        humanVerificationText,
        frameText,
        visualMapText,
        pageText,
    ]);

    return {
        screenshotB64: screenshotBuf.toString('base64'),
        pageState,
        blockerSignals,
        scrollDiagnosticsText,
        filterControlsText,
        a11yText,
        interactiveText,
        structureText,
        semanticMapText,
        structuredDataText,
        productCardsText,
        tableText,
        affordanceGraphText,
        formBrainText,
        formText,
        modalText,
        frameText,
        tabsText,
        visualMapText,
        pageText,
        selectOptions,
        runtimeSignals: limitText(pageEvents.slice(-12).join('\n'), 2500),
    };
}

// ─── Скриншоты ────────────────────────────────────────────────────────────────

const FALLBACK_JPEG_B64 =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ar//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

function fallbackScreenshotBuffer(): Buffer {
    return Buffer.from(FALLBACK_JPEG_B64, 'base64');
}

async function takeJpeg(page: Page): Promise<Buffer> {
    try {
        return await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false, timeout: 8_000 });
    } catch (err) {
        browserLog('screenshot_primary_failed', {
            url: safeLogUrl(page.url()),
            reason: safeErrorMessage(err),
        });
    }

    let session: any = null;
    try {
        session = await page.context().newCDPSession(page);
        const viewport = page.viewportSize() || { width: 1280, height: 720 };
        const result = await session.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 65,
            fromSurface: true,
            clip: {
                x: 0,
                y: 0,
                width: Math.max(1, viewport.width),
                height: Math.max(1, viewport.height),
                scale: 1,
            },
        });
        if (result.data) return Buffer.from(result.data, 'base64');
    } catch (err) {
        browserLog('screenshot_cdp_failed', {
            url: safeLogUrl(page.url()),
            reason: safeErrorMessage(err),
        });
    } finally {
        if (session) await session.detach().catch(() => {});
    }

    return fallbackScreenshotBuffer();
}

async function sendScreenshot(ctx: BotContext, page: Page, caption?: string): Promise<void> {
    try {
        const buf = await takeJpeg(page);
        await ctx.replyWithPhoto(new InputFile(buf, 'screen.jpg'), { caption });
    } catch (e) {
        devLog('browserAgent: screenshot send failed:', e);
    }
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
    'co.uk', 'com.au', 'com.br', 'com.tr', 'com.ua', 'com.cn', 'com.hk',
    'co.jp', 'co.kr', 'co.nz', 'co.za', 'com.mx', 'com.sg', 'com.tw',
    'net.au', 'org.uk', 'org.au',
]);

function normalizeDomainName(domain: string): string {
    return domain
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split(':')[0]
        .trim();
}

function rootDomain(domain: string): string {
    const normalized = normalizeDomainName(domain);
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) return normalized;

    const suffix2 = parts.slice(-2).join('.');
    if (SECOND_LEVEL_PUBLIC_SUFFIXES.has(suffix2) && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
}

function domainAliases(domain: string): string[] {
    const normalized = normalizeDomainName(domain);
    if (!normalized) return [];
    return [...new Set([normalized, rootDomain(normalized)])];
}

function loadBrowserSitePatterns(): BrowserSitePattern[] {
    try {
        if (!fs.existsSync(BROWSER_SITE_PATTERNS_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(BROWSER_SITE_PATTERNS_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed as BrowserSitePattern[] : [];
    } catch (err) {
        devLog('browserAgent: failed to load site patterns:', err);
        return [];
    }
}

function saveBrowserSitePatterns(patterns: BrowserSitePattern[]): void {
    try {
        fs.mkdirSync(path.dirname(BROWSER_SITE_PATTERNS_FILE), { recursive: true });
        fs.writeFileSync(BROWSER_SITE_PATTERNS_FILE, JSON.stringify(patterns.slice(0, 120), null, 2), 'utf8');
    } catch (err) {
        devLog('browserAgent: failed to save site patterns:', err);
    }
}

function browserSitePatternsSummary(domain: string): string {
    const root = rootDomain(domain);
    if (!root) return '(нет доменного паттерна)';
    const patterns = loadBrowserSitePatterns()
        .filter((pattern) => pattern.domain === root || domainsCompatible(pattern.domain, root))
        .slice(0, 4);
    if (!patterns.length) return '(нет доменного паттерна)';
    return patterns.map((pattern, index) => {
        const modals = pattern.modalPatterns?.length
            ? pattern.modalPatterns.map((modal) => `modal="${modal.question}" buttons=[${modal.buttons.join(', ')}] preferred=${modal.preferredButton || '-'}`).join(' ; ')
            : '';
        return [
            `${index + 1}. domain=${pattern.domain} flow=${pattern.flow} updated=${pattern.updatedAt}`,
            pattern.successEvidence?.length ? `success=${pattern.successEvidence.join(' | ')}` : '',
            modals,
            pattern.notes?.length ? `notes=${pattern.notes.join(' | ')}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n');
}

function domainsCompatible(candidateDomain: string | undefined, currentDomain: string): boolean {
    if (!candidateDomain || !currentDomain) return !candidateDomain;
    const candidateAliases = domainAliases(candidateDomain);
    const currentAliases = domainAliases(currentDomain);
    return candidateAliases.some((candidate) => currentAliases.includes(candidate));
}

function extractDomainsFromText(text: string): string[] {
    const domains = new Set<string>();
    const urlMatches = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
    for (const rawUrl of urlMatches) {
        const domain = extractDomain(rawUrl);
        if (domain) domains.add(domain);
    }

    const siteMatches = text.match(
        /(?:для|на сайте?|site|сайт[еa]?|домен|domain|url|аккаунт\s+на)\s*:?\s*(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,})/gi
    ) ?? [];
    for (const match of siteMatches) {
        const domainMatch = match.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,})/i);
        if (domainMatch?.[1]) domains.add(normalizeDomainName(domainMatch[1]));
    }

    return [...domains].slice(0, 6);
}

function cleanWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(text: string): string {
    return cleanWhitespace(text)
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/g, 'е');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function limitText(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n...[обрезано]`;
}

function redactSecrets(text: string): string {
    return text
        .replace(/((?:пароль|password|pass|пасс)\s*[:=]\s*)([^\s,;\n]+)/gi, '$1[скрыто]')
        .replace(/((?:token|api[_ -]?key|secret)\s*[:=]\s*)([^\s,;\n]+)/gi, '$1[скрыто]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[скрыто]');
}

function redactUserDataForPattern(text: string): string {
    return redactSecrets(text)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
        .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]');
}

function safeFileName(filename: string): string {
    const base = path.basename(filename || 'download.bin').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/g, '_').slice(0, 120);
    return base || 'download.bin';
}

function safeErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    return redactSecrets(raw).slice(0, 240);
}

function envFlag(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name]?.trim();
    if (raw === undefined || raw === '') return defaultValue;
    return !/^(0|false|off|no|нет)$/iu.test(raw);
}

function browserHeadlessMode(): boolean {
    return envFlag('BROWSER_HEADLESS', true);
}

function persistentBrowserProfileEnabled(): boolean {
    return envFlag('BROWSER_PERSISTENT_PROFILE', true);
}

function privateBrowserNetworkAllowed(): boolean {
    return envFlag('BROWSER_ALLOW_PRIVATE_NETWORK', false) || envFlag('BROWSER_ALLOW_LOCALHOST', false);
}

function browserProfileRootDir(): string {
    const configured = process.env.BROWSER_PROFILE_DIR?.trim();
    return configured ? path.resolve(configured) : BROWSER_PROFILE_ROOT_DIR;
}

function browserProfileDirForRun(userId: number, chatId?: number): string {
    const key = `${userId || 'anonymous'}_${chatId ?? 'direct'}`.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
    return path.join(browserProfileRootDir(), key || 'default');
}

function isPrivateOrLocalHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

    const ipKind = isIP(normalized);
    if (ipKind === 6) {
        return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
    }
    if (ipKind !== 4) return false;

    const octets = normalized.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function normalizeBrowserNavigationUrl(rawValue: string): string {
    const raw = rawValue.trim();
    if (!raw) throw new Error('URL для перехода пустой.');
    const withScheme = /^[a-z][a-z0-9+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        throw new Error(`Некорректный URL: ${raw.slice(0, 160)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Навигация заблокирована: протокол ${parsed.protocol} не поддерживается.`);
    }
    if (!privateBrowserNetworkAllowed() && isPrivateOrLocalHostname(parsed.hostname)) {
        throw new Error('Навигация в localhost/private network заблокирована. Если это доверенная задача, включи BROWSER_ALLOW_PRIVATE_NETWORK=1.');
    }
    return parsed.toString();
}

async function gotoBrowserPage(page: Page, rawUrl: string): Promise<void> {
    const url = normalizeBrowserNavigationUrl(rawUrl);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

function browserFinalUrlBlockReason(rawUrl: string): string | null {
    if (!rawUrl || rawUrl === 'about:blank') return null;
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!privateBrowserNetworkAllowed() && isPrivateOrLocalHostname(parsed.hostname)) {
        return 'вкладка перешла в localhost/private network, а BROWSER_ALLOW_PRIVATE_NETWORK не включён';
    }
    return null;
}

async function recoverFromBlockedBrowserNavigation(state: BrowserRunState, trigger: string): Promise<void> {
    await adoptLatestPage(state).catch(() => {});
    const activePage = state.page;
    const reason = browserFinalUrlBlockReason(activePage.url());
    if (!reason) return;

    browserLog('post_action_navigation_blocked', {
        trigger,
        reason,
        url: safeLogUrl(activePage.url()),
        pages: state.browserCtx.pages().length,
    });
    pushPageEvent(state, `[security] blocked post-action navigation after ${trigger}: ${reason}`);

    const pages = state.browserCtx.pages().filter((candidate) => !candidate.isClosed());
    if (pages.length > 1) {
        await activePage.close().catch(() => {});
        const replacement = pages.find((candidate) => candidate !== activePage && !candidate.isClosed()) ?? pages[0];
        if (replacement && !replacement.isClosed()) {
            installBrowserPageDefaults(replacement);
            state.page = replacement;
            attachPageObserversToPage(state, replacement);
        }
    } else {
        await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    }

    throw new Error(`Навигация после действия заблокирована: ${reason}.`);
}

function isBrowserInfrastructureError(err: unknown): boolean {
    const message = safeErrorMessage(err).toLowerCase();
    return /(target\s+(?:page|context|browser).*closed|page.*closed|browser.*closed|browser.*disconnected|connection\s+closed|protocol\s+error|session\s+closed|execution\s+context.*destroyed)/iu.test(message);
}

function classifyBrowserActionFailure(err: unknown, decision: BrowserAction): { kind: string; recovery: string } {
    const message = safeErrorMessage(err).toLowerCase();
    if (isBrowserInfrastructureError(err)) {
        return {
            kind: 'browser_infrastructure',
            recovery: 'восстановить живую вкладку и повторить безопасное действие один раз; если браузер отключён, остановиться с понятной ошибкой',
        };
    }
    if (/timeout|timed\s*out|waiting\s+for|waitforselector/iu.test(message)) {
        return {
            kind: 'timeout_or_not_ready',
            recovery: 'не повторять тот же локатор вслепую; попробовать wait/scroll/find_on_page, другой selector из карты или закрыть overlay',
        };
    }
    if (/strict mode violation|resolved to \d+ elements|more than one|multiple elements/iu.test(message)) {
        return {
            kind: 'ambiguous_locator',
            recovery: 'сузить selector через context/href/role/name или выбрать элемент внутри нужного блока',
        };
    }
    if (/not visible|hidden|outside of the viewport|element is not visible|intercepts pointer events|not receive pointer events/iu.test(message)) {
        return {
            kind: 'visibility_or_overlay',
            recovery: 'использовать dismiss_overlays, scroll/find_on_page или visual selector вместо повторного клика по скрытому элементу',
        };
    }
    if (/element.*detached|not attached|stale|execution context was destroyed|navigation/iu.test(message)) {
        return {
            kind: 'stale_after_navigation',
            recovery: 'обновить наблюдение страницы, затем выбрать selector заново из текущей карты элементов',
        };
    }
    if (decision.action === 'fill' || decision.action === 'fill_credential' || decision.action === 'select_option') {
        return {
            kind: 'form_control_failure',
            recovery: 'проверить Form brain/select options, не выдумывать значение и при отсутствии данных задать один конкретный ask_user',
        };
    }
    return {
        kind: 'action_failed',
        recovery: 'сменить стратегию вместо повторения того же действия',
    };
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLlmError(err: any): boolean {
    const status = Number(err?.status ?? err?.code ?? err?.response?.status ?? 0);
    const message = safeErrorMessage(err);
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(status) ||
        /(server had an error|temporar|timeout|timed?\s*out|rate\s*limit|overloaded|econnreset|socket|5\d\d|429)/iu.test(message);
}

async function sendProgress(ctx: BotContext, text: string): Promise<void> {
    try {
        await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
        await ctx.reply(text);
    } catch {}
}

function extractCredentialDomain(chunk: string): string | undefined {
    const explicit = extractDomainsFromText(chunk)[0];
    if (explicit) return explicit;

    // Последний шанс для строк формата "example.com login ... password ...".
    // Email-адреса не считаем доменом сайта.
    const looseMatches = chunk.match(/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}/gi) ?? [];
    const candidate = looseMatches.find((value) => !chunk.includes(`@${value}`));
    return candidate ? normalizeDomainName(candidate) : undefined;
}

function extractCredentialCandidatesFromText(text: string | undefined, source: CredentialMaterial['source']): CredentialMaterial[] {
    if (!text?.trim()) return [];

    const chunks = [
        ...text.split(/\n{1,}|[;•]/g),
        text.slice(0, 3000),
    ]
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0 && /(логин|login|email|почта|e-mail|пароль|password|pass|пасс)/i.test(chunk));

    const result: CredentialMaterial[] = [];
    for (const chunk of chunks) {
        const loginMatch = chunk.match(/(?:логин|login|email|почта|e-mail)\s*[:=]?\s*([^\s,;|"']+)/i);
        const passwordMatch = chunk.match(/(?:пароль|password|pass|пасс)\s*[:=]?\s*([^\s,;|"']+)/i);
        if (!loginMatch && !passwordMatch) continue;

        result.push({
            source,
            domain: extractCredentialDomain(chunk),
            login: loginMatch?.[1],
            password: passwordMatch?.[1],
        });
    }

    const seen = new Set<string>();
    return result.filter((item) => {
        const key = `${item.source}:${item.domain ?? '*'}:${item.login ?? '*'}:${Boolean(item.password)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function extractCredentialsFromMemory(memoryContext?: string, domain?: string): CredentialMaterial | null {
    return chooseCredentialCandidate(extractCredentialCandidatesFromText(memoryContext, 'memory'), domain);
}

function extractCredentialsFromUserText(text?: string, domain?: string): CredentialMaterial | null {
    return chooseCredentialCandidate(extractCredentialCandidatesFromText(text, 'user'), domain);
}

function chooseCredentialCandidate(candidates: CredentialMaterial[], domain?: string): CredentialMaterial | null {
    if (!candidates.length) return null;
    if (domain) {
        const exact = candidates.find((candidate) => domainsCompatible(candidate.domain, domain));
        if (exact) return exact;
    }
    return candidates.find((candidate) => !candidate.domain) ?? candidates[0];
}

function resolveCredentialsForDomain(
    userId: number,
    domain: string,
    candidates: CredentialMaterial[],
    fallback: CredentialMaterial | null
): CredentialMaterial | null {
    const storedCreds = domain ? BrowserCredentialService.get(userId, domain) : null;
    if (storedCreds) {
        return { source: 'saved', domain, login: storedCreds.login, password: storedCreds.password };
    }
    return chooseCredentialCandidate(candidates, domain) ?? fallback;
}

function getCredentialHint(credentials: CredentialMaterial | null, domain: string): string {
    if (!credentials) {
        return 'Учётных данных для текущего сайта нет. Если сайт требует логин, пароль, 2FA, captcha или одноразовый код — используй ask_user.';
    }

    const fields = [
        credentials.login ? `login доступен (${credentials.login})` : '',
        credentials.password ? 'password доступен' : '',
    ].filter(Boolean).join(', ');
    const source =
        credentials.source === 'saved' ? 'локального хранилища браузера' :
        credentials.source === 'user' ? 'последнего ответа пользователя' :
        'долговременной памяти';
    const domainPart = credentials.domain || domain ? ` для ${credentials.domain || domain}` : '';

    return `Есть учётные данные из ${source}${domainPart}: ${fields || 'частично'}. Для ввода используй action="fill_credential" и value="login" или "password"; не проси эти данные у пользователя повторно.`;
}

function credentialValue(credentials: CredentialMaterial | null, value?: string): string {
    if (!credentials) return '';
    const key = (value ?? '').toLowerCase();
    if (key.includes('pass') || key.includes('парол')) return credentials.password ?? '';
    return credentials.login ?? '';
}

function sanitizeDecisionForLog(decision: BrowserAction): BrowserAction {
    const copy: BrowserAction = { ...decision };
    if (copy.value && ['fill', 'type', 'fill_credential'].includes(copy.action)) {
        copy.value = isSensitiveSelector(copy.selector) || copy.action === 'fill_credential'
            ? '[скрыто]'
            : limitText(redactSecrets(copy.value), 80);
    }
    if (copy.summary) copy.summary = redactSecrets(copy.summary);
    if (copy.comment) copy.comment = redactSecrets(copy.comment);
    return copy;
}

function formatDecisionForLog(decision: BrowserAction): string {
    const safe = sanitizeDecisionForLog(decision);
    const parts = [
        `[BROWSER] action: ${safe.action}`,
        safe.selector ? `selector=${redactSecrets(safe.selector).slice(0, 180)}` : '',
        safe.value ? `value=${redactSecrets(safe.value).slice(0, 160)}` : '',
        safe.comment ? `comment=${redactSecrets(safe.comment).slice(0, 220)}` : '',
        safe.summary ? `summary=${redactSecrets(safe.summary).slice(0, 220)}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
}

function safeLogUrl(rawUrl?: string): string {
    const value = redactSecrets(rawUrl || '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        for (const key of [...parsed.searchParams.keys()]) {
            if (/(token|key|secret|auth|session|password|pass|code)/iu.test(key)) {
                parsed.searchParams.set(key, '[скрыто]');
            }
        }
        return parsed.toString().slice(0, 240);
    } catch {
        return value.slice(0, 240);
    }
}

function safeLogValue(key: string, value: unknown): string {
    if (/(token|secret|password|pass|credential|api[_-]?key|authorization|cookie)/iu.test(key)) {
        return '[скрыто]';
    }
    const raw = typeof value === 'string'
        ? value
        : value === undefined || value === null
            ? ''
            : JSON.stringify(value);
    return redactSecrets(raw).replace(/\s+/g, ' ').slice(0, 420);
}

function browserLog(event: string, data: Record<string, unknown> = {}): void {
    const fields = Object.entries(data)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${safeLogValue(key, value)}`);
    console.log(`[BROWSER] ${event}${fields.length ? ` | ${fields.join(' | ')}` : ''}`);
}

function browserTrajectoryEnabled(): boolean {
    return !/^(0|false|off|no)$/iu.test(String(process.env.BROWSER_TRAJECTORY ?? '1').trim());
}

function safeJsonStringify(value: unknown): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

function limitTrajectoryValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === 'string') {
        return redactSecrets(value).slice(0, 4000);
    }
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    if (depth >= 5) return '[depth-limit]';
    seen.add(value);
    if (Array.isArray(value)) {
        const limited = value.slice(0, 40).map((item) => limitTrajectoryValue(item, depth + 1, seen));
        if (value.length > 40) limited.push(`[array-truncated:${value.length}]`);
        seen.delete(value);
        return limited;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, raw] of entries.slice(0, 50)) {
        if (/(token|secret|password|pass|credential|authorization|cookie|api[_-]?key)/iu.test(key)) {
            output[key] = '[скрыто]';
        } else {
            output[key] = limitTrajectoryValue(raw, depth + 1, seen);
        }
    }
    if (entries.length > 50) output._truncated = `object-keys:${entries.length}`;
    seen.delete(value);
    return output;
}

function sanitizeTrajectoryPayload(data: Record<string, unknown>): Record<string, unknown> {
    return limitTrajectoryValue(data) as Record<string, unknown>;
}

function cleanupBrowserTrajectoryFiles(): void {
    try {
        if (!fs.existsSync(BROWSER_TRAJECTORY_DIR)) return;
        const files = fs.readdirSync(BROWSER_TRAJECTORY_DIR)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => {
                const filePath = path.join(BROWSER_TRAJECTORY_DIR, name);
                const stat = fs.statSync(filePath);
                return { filePath, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const file of files.slice(BROWSER_TRAJECTORY_MAX_FILES)) {
            fs.unlink(file.filePath, () => {});
        }
    } catch (err) {
        devLog('browserAgent: trajectory cleanup failed:', safeErrorMessage(err));
    }
}

function createBrowserTrajectoryRecorder(state: BrowserRunState): BrowserTrajectoryRecorder | undefined {
    if (!browserTrajectoryEnabled()) return undefined;
    try {
        fs.mkdirSync(BROWSER_TRAJECTORY_DIR, { recursive: true });
        cleanupBrowserTrajectoryFiles();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(BROWSER_TRAJECTORY_DIR, `${stamp}_${state.id}.jsonl`);
        fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
        return {
            filePath,
            seq: 0,
            acceptedBytes: 0,
            droppedEvents: 0,
            droppedBytes: 0,
            stopped: false,
        };
    } catch (err) {
        devLog('browserAgent: trajectory create failed:', safeErrorMessage(err));
        return undefined;
    }
}

function recordBrowserTrajectoryEvent(
    state: BrowserRunState | undefined,
    type: string,
    data: Record<string, unknown> = {}
): void {
    const recorder = state?.trajectory;
    if (!recorder) return;
    if (recorder.stopped) {
        recorder.droppedEvents += 1;
        return;
    }

    const nextSeq = recorder.seq + 1;
    const event = {
        traceSchema: 'kira-browser-trajectory',
        schemaVersion: 1,
        traceId: state.id,
        source: 'browserAgent',
        type,
        ts: new Date().toISOString(),
        seq: nextSeq,
        sessionId: state.id,
        userId: state.userId,
        chatId: state.chatId,
        url: state.page?.isClosed() ? undefined : safeLogUrl(state.page.url()),
        data: sanitizeTrajectoryPayload(data),
    };
    let line = safeJsonStringify(event);
    if (!line) return;
    let bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (bytes > BROWSER_TRAJECTORY_EVENT_MAX_BYTES) {
        line = safeJsonStringify({
            ...event,
            data: {
                truncated: true,
                reason: 'browser-trajectory-event-size-limit',
                originalBytes: bytes,
                limitBytes: BROWSER_TRAJECTORY_EVENT_MAX_BYTES,
            },
        });
        if (!line) return;
        bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    }
    if (recorder.acceptedBytes + bytes > BROWSER_TRAJECTORY_MAX_BYTES) {
        recorder.stopped = true;
        recorder.droppedEvents += 1;
        recorder.droppedBytes += bytes;
        return;
    }

    try {
        fs.appendFileSync(recorder.filePath, `${line}\n`, 'utf8');
        recorder.seq = nextSeq;
        recorder.acceptedBytes += bytes;
    } catch (err) {
        recorder.stopped = true;
        devLog('browserAgent: trajectory write failed:', safeErrorMessage(err));
    }
}

function finishBrowserTrajectory(state: BrowserRunState, reason: string): void {
    const recorder = state.trajectory;
    if (!recorder) return;
    if (recorder.droppedEvents > 0) {
        const wasStopped = recorder.stopped;
        recorder.stopped = false;
        recordBrowserTrajectoryEvent(state, 'trace.truncated', {
            reason: 'browser-trajectory-size-limit',
            closeReason: reason,
            droppedEvents: recorder.droppedEvents,
            droppedBytes: recorder.droppedBytes,
            limitBytes: BROWSER_TRAJECTORY_MAX_BYTES,
        });
        recorder.stopped = wasStopped;
    }
    browserLog('trajectory_saved', {
        sessionId: state.id,
        file: recorder.filePath,
        bytes: recorder.acceptedBytes,
        events: recorder.seq,
    });
}

function countSnapshotRows(text: string | undefined | null, marker: RegExp): number {
    return (String(text ?? '').match(marker) || []).length;
}

function summarizeCandidate(candidate?: { label?: string; controlLabel?: string; context?: string; matchedHints?: string[]; score?: number; reason?: string }): Record<string, unknown> | undefined {
    if (!candidate) return undefined;
    return {
        label: candidate.label || candidate.controlLabel || '',
        hints: candidate.matchedHints?.slice(0, 4),
        score: candidate.score,
        context: candidate.context ? cleanWhitespace(candidate.context).slice(0, 180) : undefined,
        reason: candidate.reason,
    };
}

function summarizeChoices(choices?: BrowserUserChoice[]): string {
    return (choices || [])
        .slice(0, 4)
        .map((choice) => cleanWhitespace(choice.label).slice(0, 120))
        .join(' || ');
}

function isSensitiveSelector(selector?: string): boolean {
    return /password|pass|парол|token|secret|otp|code|sms/i.test(selector ?? '');
}

function actionSignature(decision: BrowserAction): string {
    const selector = decision.selector ? ` [${decision.selector.slice(0, 80)}]` : '';
    const value =
        decision.action === 'fill_credential'
            ? ` ${decision.value ?? ''}`
            : decision.action === 'fill' || decision.action === 'type'
                ? isSensitiveSelector(decision.selector) ? ' [скрыто]' : ` "${redactSecrets(decision.value ?? '').slice(0, 30)}"`
                : decision.value ? ` "${redactSecrets(decision.value).slice(0, 60)}"` : '';
    return `${decision.action}${value}${selector}`;
}

function actionTargetSelector(decision: BrowserAction): string {
    const sel = decision.selector ?? '';
    const val = decision.value ?? '';
    return sel || (decision.action === 'click' || decision.action === 'hover' ? val : '');
}

function hrefFromCandidateSelector(selector: string, baseUrl: string): string | undefined {
    const normalized = normalizeCandidateSelector(selector);
    const href = splitCandidateSelectorMetadata(normalized).href;
    if (!href || /^(?:javascript|mailto|tel):/iu.test(href)) return undefined;
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return undefined;
    }
}

function comparableUrl(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = '';
        return parsed.toString().replace(/\/$/u, '');
    } catch {
        return rawUrl.replace(/#.*$/u, '').replace(/\/$/u, '');
    }
}

function urlsEquivalent(left: string, right: string): boolean {
    return comparableUrl(left) === comparableUrl(right);
}

function repeatedActionCount(history: ActionRecord[], decision: BrowserAction): number {
    const signature = actionSignature(decision);
    return history.slice(-6).filter((h) => h.label === signature).length;
}

function actionKindFromLabel(label: string): string {
    return cleanWhitespace(label).split(/[\s["'\[]+/u)[0] || 'unknown';
}

function actionOutcomeKey(record: ActionRecord): string {
    const surface = normalizeSearchText([record.error || '', record.comment || ''].join(' ')).slice(0, 140);
    return `${record.result}:${comparableUrl(record.url)}:${surface}`;
}

function compactActionRecord(record: ActionRecord): string {
    const error = record.error ? ` error=${record.error}` : '';
    return `${record.step}. [${record.result}] ${record.label}: ${cleanWhitespace(record.comment || '-').slice(0, 180)} (${safeLogUrl(record.url)})${error}`;
}

function browserActionTrajectorySummary(history: ActionRecord[]): string {
    if (!history.length) return '  (траектория пуста)';

    const recent = history.slice(-12);
    const earlier = history.slice(0, Math.max(0, history.length - recent.length));
    const actionCounts = new Map<string, number>();
    const failureCounts = new Map<string, number>();
    const domains = new Set<string>();

    for (const record of history) {
        const kind = actionKindFromLabel(record.label);
        actionCounts.set(kind, (actionCounts.get(kind) ?? 0) + 1);
        const domain = extractDomain(record.url);
        if (domain && domain !== 'about:blank') domains.add(domain);
        if (record.result === 'failed') {
            const failureKey = `${record.label.slice(0, 90)}${record.error ? ` (${record.error})` : ''}`;
            failureCounts.set(failureKey, (failureCounts.get(failureKey) ?? 0) + 1);
        }
    }

    const countsText = [...actionCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([kind, count]) => `${kind}:${count}`)
        .join(', ');
    const failureText = [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => `${label}${count > 1 ? ` x${count}` : ''}`)
        .join(' | ');
    const landmarks = history
        .filter((record) =>
            record.result === 'ok' &&
            !/^(?:wait|scroll|note|find_on_page|memory_lookup)\b/iu.test(actionKindFromLabel(record.label))
        )
        .slice(-5)
        .map((record) => compactActionRecord(record))
        .join('\n');

    return [
        `  total=${history.length}; earlier_compacted=${earlier.length}; recent_shown=${recent.length}`,
        countsText ? `  action_counts=${countsText}` : '',
        domains.size ? `  domains=${[...domains].slice(-6).join(', ')}` : '',
        failureText ? `  repeated_failures=${failureText}` : '',
        landmarks ? `  useful_landmarks:\n${landmarks.split('\n').map((line) => `    ${line}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
}

function alternatingTailCountWithNext(history: ActionRecord[], nextLabel: string): { count: number; pair: string[] } {
    const labels = history
        .filter((record) =>
            !/^(?:repeated_action_recovery|blocked_repeated_pause|action_loop_|loop_checkpoint|skip_technical_overlay)/iu.test(record.label)
        )
        .slice(-8)
        .map((record) => record.label);
    const sequence = [...labels, nextLabel].filter(Boolean);

    for (let count = Math.min(sequence.length, 8); count >= 5; count -= 1) {
        const tail = sequence.slice(-count);
        const pair = [...new Set(tail)];
        if (pair.length !== 2) continue;
        const alternating = tail.every((label, index) =>
            index < 2 ? true : label === tail[index - 2] && label !== tail[index - 1]
        );
        if (alternating) return { count, pair };
    }

    return { count: 0, pair: [] };
}

function browserLoopDiagnosticsSummary(history: ActionRecord[], lastActionOutcome?: ActionOutcomeUnderstanding): string {
    const recent = history.slice(-10);
    if (!recent.length && !lastActionOutcome) return '  (нет признаков цикла)';

    const labelCounts = new Map<string, number>();
    const outcomeCounts = new Map<string, number>();
    for (const record of recent) {
        labelCounts.set(record.label, (labelCounts.get(record.label) ?? 0) + 1);
        outcomeCounts.set(actionOutcomeKey(record), (outcomeCounts.get(actionOutcomeKey(record)) ?? 0) + 1);
    }

    const repeatedLabels = [...labelCounts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, count]) => `${label} x${count}`);
    const stableOutcomes = [...outcomeCounts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key, count]) => `${key.slice(0, 180)} x${count}`);
    const lastUrl = recent.at(-1)?.url;
    const sameUrlTail = lastUrl
        ? recent.filter((record) => urlsEquivalent(record.url, lastUrl)).length
        : 0;
    const failedTail = recent.filter((record) => record.result === 'failed').length;
    const signals = [
        repeatedLabels.length ? `  repeated_actions=${repeatedLabels.join(' | ')}` : '',
        stableOutcomes.length ? `  repeated_outcomes=${stableOutcomes.join(' | ')}` : '',
        sameUrlTail >= 4 ? `  same_url_recent=${sameUrlTail}/${recent.length}` : '',
        failedTail >= 2 ? `  recent_failures=${failedTail}/${recent.length}` : '',
        lastActionOutcome?.sameLoopRisk ? `  last_outcome_sameLoopRisk=true progress=${lastActionOutcome.progress}` : '',
        lastActionOutcome && /no_visible_change|unknown|stuck|blocked/iu.test(lastActionOutcome.progress)
            ? `  last_outcome_progress=${lastActionOutcome.progress}`
            : '',
    ].filter(Boolean);

    return signals.length ? signals.join('\n') : '  (нет признаков цикла)';
}

function detectBrowserActionLoopBeforeExecution(
    state: BrowserRunState,
    decision: BrowserAction,
    url: string
): BrowserActionLoopDetectionResult {
    if (['done', 'fail', 'ask_user', 'note', 'memory_lookup'].includes(decision.action)) {
        return { stuck: false };
    }

    const signature = actionSignature(decision);
    const recent = state.history.slice(-10);
    if (recent.length < 4) return { stuck: false };

    const sameUrlCount = recent.filter((record) => urlsEquivalent(record.url, url)).length;
    const failedCount = recent.filter((record) => record.result === 'failed').length;
    const sameLoopOutcome = state.lastActionOutcome?.sameLoopRisk ||
        /no_visible_change|unknown|stuck|blocked/iu.test(state.lastActionOutcome?.progress ?? '');
    const sameActionRecords = recent.filter((record) => record.label === signature);
    const noProgressEvidence = sameLoopOutcome || failedCount >= 2 || sameUrlCount >= 5;

    if (sameActionRecords.length >= 2 && noProgressEvidence) {
        const repeatedStableOutcomes = new Set(sameActionRecords.map(actionOutcomeKey)).size <= 2;
        const level: 'warning' | 'critical' =
            sameActionRecords.length >= 3 && repeatedStableOutcomes ? 'critical' : 'warning';
        return {
            stuck: true,
            level,
            detector: 'generic_repeat',
            count: sameActionRecords.length + 1,
            message: `Действие "${signature}" снова выбрано при признаках отсутствия прогресса.`,
            recovery: 'Смени маршрут: другой selector/context, visual=N, find_on_page/site_search, go_back, scroll в другую сторону, done по уже доказанным данным или fail с конкретной причиной.',
            warningKey: `generic:${signature}:${comparableUrl(url)}`,
        };
    }

    const pingPong = alternatingTailCountWithNext(recent, signature);
    if (pingPong.count >= 5 && noProgressEvidence) {
        return {
            stuck: true,
            level: pingPong.count >= 7 ? 'critical' : 'warning',
            detector: 'ping_pong',
            count: pingPong.count,
            message: `Следующее действие продолжит ping-pong цикл между "${pingPong.pair[0]}" и "${pingPong.pair[1]}".`,
            recovery: 'Не выполняй ни один из двух шагов цикла. Выбери третий путь: поиск по странице/сайту, другой блок, возврат назад, закрытие overlay, прямую ссылку из структуры или завершение с текущими доказательствами.',
            warningKey: `pingpong:${pingPong.pair.sort().join('|')}:${comparableUrl(url)}`,
        };
    }

    const recentOkNoProgress = recent.slice(-4).filter((record) => record.result === 'ok').length >= 3 &&
        sameUrlCount >= 4 &&
        sameLoopOutcome;
    if (recentOkNoProgress) {
        return {
            stuck: true,
            level: 'warning',
            detector: 'same_page_no_progress',
            count: sameUrlCount,
            message: 'Несколько успешных действий подряд оставили агент на той же странице без видимого прогресса.',
            recovery: 'Следующий шаг должен изменить область поиска или критерий: find_on_page/site_search, фильтр, другой блок, go_back или итог по уже собранным фактам.',
            warningKey: `same-page:${comparableUrl(url)}:${signature}`,
        };
    }

    return { stuck: false };
}

function browserHistorySurface(history: ActionRecord[], lookback = 14): string {
    return normalizeSearchText(history.slice(-lookback)
        .map((record) => `${record.label} ${record.comment} ${record.error ?? ''}`)
        .join('\n'));
}

function browserRecoveryKey(plan: BrowserStuckRecoveryPlan, url: string): string {
    const target = cleanWhitespace(plan.query || plan.action.value || plan.action.selector || '').slice(0, 90);
    return `${plan.kind}:${comparableUrl(url)}:${normalizeSearchText(target)}`;
}

function browserRecoveryWasRecentlyTried(state: BrowserRunState, plan: BrowserStuckRecoveryPlan, url: string): boolean {
    const key = browserRecoveryKey(plan, url);
    return state.history.slice(-12).some((record) =>
        record.label.startsWith('stuck_recovery ') &&
        normalizeSearchText(record.comment).includes(normalizeSearchText(key).slice(0, 120))
    );
}

function browserRecoveryStopWords(): Set<string> {
    return new Set([
        'найди', 'найти', 'найтись', 'открой', 'открыть', 'покажи', 'сделай', 'нужно', 'можно',
        'сайт', 'страница', 'браузер', 'задача', 'пользователь', 'который', 'которая', 'которые',
        'this', 'that', 'with', 'from', 'page', 'site', 'find', 'open', 'show', 'browser', 'task',
    ]);
}

function browserRecoverySearchCandidates(state: BrowserRunState, task: string): { findTerms: string[]; siteQueries: string[] } {
    const contract = state.taskContract;
    const ledger = state.taskLedger;
    const stopWords = browserRecoveryStopWords();
    const siteCandidates = [
        ...(contract?.searchQueries ?? []),
        contract?.goal,
        ledger?.target,
        ledger?.date ? `${ledger.target ?? ''} ${ledger.date}` : '',
        task,
    ];
    const findCandidates = [
        ledger?.target,
        ledger?.date,
        ...(contract?.hardCriteria ?? []),
        ...(contract?.softPreferences ?? []),
        ...(contract?.negativeCriteria ?? []),
        ...(contract?.searchTerms ?? []),
        ...(contract?.evidenceNeeded ?? []),
    ];
    const normalizeList = (items: Array<string | undefined>, limit: number, maxLen: number) => {
        const seen = new Set<string>();
        const output: string[] = [];
        for (const item of items) {
            const clean = cleanWhitespace(String(item ?? '')).slice(0, maxLen);
            if (clean.length < 3) continue;
            const normalized = normalizeSearchText(clean);
            if (stopWords.has(normalized) || seen.has(normalized)) continue;
            seen.add(normalized);
            output.push(clean);
            if (output.length >= limit) break;
        }
        return output;
    };
    return {
        findTerms: normalizeList(findCandidates, 8, 120),
        siteQueries: normalizeList(siteCandidates, 5, 180),
    };
}

function browserLooksLikeInProgressForm(state: BrowserRunState, observation: PageObservation, task: string): boolean {
    const surface = normalizeSearchText([
        observation.formText,
        observation.modalText,
        observation.pageText.slice(0, 900),
        state.pageUnderstanding?.phase,
        task,
    ].join('\n'));
    return isBookingOrLeadFormSurface(observation) ||
        /(checkout|payment|оплат|плат[её]ж|корзин|заказ|submit order|confirm order|бронир|бронь|заявк|регистрац)/iu.test(surface);
}

function shouldUseProactiveBrowserStuckRecovery(
    state: BrowserRunState,
    observation: PageObservation,
    url: string,
    iteration: number
): boolean {
    if (iteration < 4) return false;
    const recent = state.history.slice(-7);
    if (recent.length < 3) return false;
    const failedCount = recent.filter((record) => record.result === 'failed').length;
    const loopCount = recent.filter((record) => /^action_loop_|^blocked_repeated_pause|^repeated_action_recovery/iu.test(record.label)).length;
    const sameUrlCount = recent.filter((record) => urlsEquivalent(record.url, url)).length;
    const phaseLooksStuck = state.pageUnderstanding?.phase === 'stuck' || state.pageUnderstanding?.phase === 'blocked';
    const outcomeLooksStuck = Boolean(state.lastActionOutcome?.sameLoopRisk) ||
        /no_visible_change|unknown|stuck|blocked/iu.test(state.lastActionOutcome?.progress ?? '');
    return failedCount >= 3 ||
        loopCount >= 2 ||
        (sameUrlCount >= 5 && (phaseLooksStuck || outcomeLooksStuck)) ||
        (failedCount >= 2 && Boolean(observation.blockerSignals));
}

function chooseBrowserStuckRecoveryPlan(
    state: BrowserRunState,
    observation: PageObservation,
    task: string,
    url: string,
    trigger: string
): BrowserStuckRecoveryPlan | null {
    const recentSurface = browserHistorySurface(state.history);
    const isFlowSurface = browserLooksLikeInProgressForm(state, observation, task);
    const canScrollDown = /canScrollDown=true/iu.test(observation.scrollDiagnosticsText || '');

    const plans: BrowserStuckRecoveryPlan[] = [];
    if (hasDismissibleTechnicalOverlay(observation)) {
        plans.push({
            kind: 'dismiss_overlays',
            action: { action: 'dismiss_overlays', comment: 'Закрыть техническое окно, которое мешает странице.' },
            reason: `trigger=${trigger}; на странице виден технический overlay/cookie/notification`,
        });
    }

    const { findTerms, siteQueries } = browserRecoverySearchCandidates(state, task);
    for (const term of findTerms) {
        const normalized = normalizeSearchText(term);
        if (recentSurface.includes(`find_on_page ${normalized}`) || recentSurface.includes(`stuck_recovery find_on_page ${normalized}`)) continue;
        plans.push({
            kind: 'find_on_page',
            action: { action: 'find_on_page', value: term, comment: `Найти на текущей странице: ${term}` },
            reason: `trigger=${trigger}; сменить фокус с клика на поиск целевого текста`,
            query: term,
        });
        break;
    }

    const recentScrollDowns = state.history.slice(-4).filter((record) =>
        /^scroll\b/iu.test(record.label) || /^stuck_recovery scroll_down\b/iu.test(record.label)
    ).length;
    if (canScrollDown && recentScrollDowns < 2) {
        plans.push({
            kind: 'scroll_down',
            action: { action: 'scroll', value: 'down', comment: 'Прокрутить ниже к новым блокам страницы.' },
            reason: `trigger=${trigger}; текущая область не дала прогресса, ниже есть контент`,
        });
    }

    const recentGoBack = state.history.slice(-8).some((record) => /^stuck_recovery go_back\b/iu.test(record.label));
    const hasNavigationTrail = state.history.slice(-10).some((record) =>
        record.result === 'ok' && /^(click|navigate|site_search)\b/iu.test(record.label)
    );
    if (!isFlowSurface && hasNavigationTrail && !recentGoBack && url !== 'about:blank') {
        plans.push({
            kind: 'go_back',
            action: { action: 'go_back', comment: 'Вернуться к предыдущей странице и выбрать другой маршрут.' },
            reason: `trigger=${trigger}; текущая ветка не даёт прогресса`,
        });
    }

    for (const query of siteQueries) {
        const normalized = normalizeSearchText(query);
        if (isFlowSurface || recentSurface.includes(`site_search ${normalized}`) || recentSurface.includes(`stuck_recovery site_search ${normalized}`)) continue;
        plans.push({
            kind: 'site_search',
            action: { action: 'site_search', value: query, comment: `Выполнить поиск по сайту: ${query}` },
            reason: `trigger=${trigger}; локальная навигация застряла, нужен поиск по сайту`,
            query,
        });
        break;
    }

    const recentWait = state.history.slice(-6).some((record) => /^stuck_recovery wait\b/iu.test(record.label));
    if (!recentWait && /(loading|spinner|progress|загрузк|подожд|ожидан)/iu.test([observation.runtimeSignals, observation.pageText.slice(0, 700)].join('\n'))) {
        plans.push({
            kind: 'wait',
            action: { action: 'wait', comment: 'Дождаться окончания загрузки перед следующим действием.' },
            reason: `trigger=${trigger}; есть признаки незавершённой загрузки`,
        });
    }

    return plans.find((plan) => !browserRecoveryWasRecentlyTried(state, plan, url)) ?? null;
}

function browserStuckRecoveryProgressText(plan: BrowserStuckRecoveryPlan): string {
    switch (plan.kind) {
        case 'dismiss_overlays':
            return 'Похоже, мешает техническое окно; закрываю его и продолжаю без остановки.';
        case 'find_on_page':
            return `Застряла на текущем маршруте; ищу на странице «${plan.query || plan.action.value}».`;
        case 'scroll_down':
            return 'Текущая область не дала прогресса; прокручиваю ниже к новым блокам.';
        case 'go_back':
            return 'Эта ветка не помогает; возвращаюсь назад и попробую другой путь.';
        case 'site_search':
            return `Навигация застряла; пробую поиск по сайту «${plan.query || plan.action.value}».`;
        case 'wait':
            return 'Есть признаки загрузки; жду завершения перед следующим шагом.';
    }
}

async function executeBrowserStuckRecoveryPlan(
    ctx: BotContext,
    state: BrowserRunState,
    page: Page,
    plan: BrowserStuckRecoveryPlan,
    iteration: number,
    url: string
): Promise<boolean> {
    const recoveryKey = browserRecoveryKey(plan, url);
    const label = `stuck_recovery ${plan.kind}${plan.query ? ` "${plan.query.slice(0, 70)}"` : ''}`.slice(0, 140);
    browserLog('stuck_recovery_start', {
        iter: iteration,
        kind: plan.kind,
        key: recoveryKey,
        reason: plan.reason,
        url: safeLogUrl(url),
    });
    recordBrowserTrajectoryEvent(state, 'action.stuck_recovery.start', {
        iter: iteration,
        kind: plan.kind,
        key: recoveryKey,
        reason: plan.reason,
        action: sanitizeDecisionForLog(plan.action),
    });

    try {
        await sendProgress(ctx, `🌐 ${browserStuckRecoveryProgressText(plan)}`);
        let comment = '';
        if (plan.kind === 'find_on_page') {
            const found = await findOnPage(page, plan.query || plan.action.value || '');
            comment = `Нашла на странице «${found.query}»: ${cleanWhitespace(found.text).slice(0, 180)}`;
        } else if (plan.kind === 'site_search') {
            comment = await runSiteSearch(page, plan.query || plan.action.value || '');
        } else {
            const actionResult = await doAction(page, plan.action, state.activeCredentials, state);
            comment = typeof actionResult === 'string' && actionResult
                ? actionResult
                : browserStuckRecoveryProgressText(plan);
        }
        await adoptLatestPage(state);
        state.consecutiveActionFailures = 0;
        state.iterationCount = iteration;
        state.notes.push(`Stuck recovery ok: ${plan.kind}; ${comment}`.slice(0, 700));
        if (state.notes.length > 36) state.notes.splice(0, state.notes.length - 36);
        pushEvidence(state, 'action', comment, state.page.url());
        state.history.push({
            step: iteration,
            label,
            url,
            comment: `${recoveryKey}; ${comment}`.slice(0, 700),
            result: 'ok',
        });
        browserLog('stuck_recovery_result', {
            iter: iteration,
            kind: plan.kind,
            status: 'ok',
            beforeUrl: safeLogUrl(url),
            afterUrl: safeLogUrl(state.page.url()),
            comment: comment.slice(0, 220),
        });
        recordBrowserTrajectoryEvent(state, 'action.stuck_recovery.result', {
            iter: iteration,
            kind: plan.kind,
            status: 'ok',
            beforeUrl: safeLogUrl(url),
            afterUrl: safeLogUrl(state.page.url()),
            comment,
        });
        await state.page.waitForTimeout(350);
        return true;
    } catch (err) {
        const reason = safeErrorMessage(err);
        state.iterationCount = iteration;
        state.notes.push(`Stuck recovery failed: ${plan.kind}; ${reason}`.slice(0, 700));
        if (state.notes.length > 36) state.notes.splice(0, state.notes.length - 36);
        state.history.push({
            step: iteration,
            label,
            url,
            comment: `${recoveryKey}; recovery не сработал: ${plan.reason}`.slice(0, 700),
            result: 'failed',
            error: reason,
        });
        browserLog('stuck_recovery_result', {
            iter: iteration,
            kind: plan.kind,
            status: 'failed',
            reason,
            url: safeLogUrl(url),
        });
        recordBrowserTrajectoryEvent(state, 'action.stuck_recovery.result', {
            iter: iteration,
            kind: plan.kind,
            status: 'failed',
            reason,
        });
        return false;
    }
}

function repeatedActionRecoveryLabel(signature: string): string {
    return `repeated_action_recovery ${signature.slice(0, 80)}`;
}

function hasRecentRepeatedActionRecovery(history: ActionRecord[], signature: string): boolean {
    const label = repeatedActionRecoveryLabel(signature);
    return history.slice(-10).some((h) => h.label === label);
}

function isScrollDownDecision(decision: BrowserAction): boolean {
    return decision.action === 'scroll' && !/^up$/i.test(String(decision.value ?? 'down').trim());
}

async function getScrollBoundaryState(page: Page): Promise<{ y: number; viewportHeight: number; bodyHeight: number; canScrollDown: boolean } | null> {
    try {
        return await page.evaluate(() => {
            const y = Math.max(0, Math.round(window.scrollY));
            const viewportHeight = Math.max(0, Math.round(window.innerHeight));
            const bodyHeight = Math.max(0, Math.round(document.body?.scrollHeight ?? document.documentElement?.scrollHeight ?? 0));
            return {
                y,
                viewportHeight,
                bodyHeight,
                canScrollDown: y + viewportHeight < bodyHeight - 20,
            };
        });
    } catch {
        return null;
    }
}

function isHighImpactAction(decision: BrowserAction): boolean {
    if (decision.action !== 'click' && decision.action !== 'press_key') return false;
    const text = [
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
    ].filter(Boolean).join(' ');
    return /(оплат|плат[её]ж|заплат|оформить\s+заказ|подтвердить\s+заказ|отправить\s+заказ|отправить\s+заявк|отправляю\s+заявк|заявк[ауи]|checkout|payment|pay\b|confirm\s+(?:order|payment|booking)|подтверд(?:ить)?\s+(?:заказ|оплат|брон|заявк)|забронировать|бронь|reserve|book\b|submit\s+order)/i.test(text);
}

function isExplicitUserConfirmation(text: string): boolean {
    const normalized = cleanWhitespace(text).toLowerCase().replace(/^["'«»“”]+/u, '');
    return /^(?:да|ок|okay|yes|подтверждаю|можно|согласен|согласна|продолжай|делай|нажимай|оплати|бронируй)(?:$|[\s,.;:!?…])/iu.test(normalized);
}

function isExplicitUserRejection(text: string): boolean {
    const normalized = cleanWhitespace(text).toLowerCase().replace(/^["'«»“”]+/u, '');
    return /^(?:нет|no|не\s+надо|не\s+используй|неверно|неправильно|отмена|cancel)(?:$|[\s,.;:!?…])/iu.test(normalized);
}

function isHighImpactConfirmationPrompt(text?: string): boolean {
    return /(подтверди[\s\S]{0,120}(?:отправить|заявк|форм|финальн|необратим|потенциально)|перед\s+отправкой\s+заявк|можно\s+отправить\s+заявк|ответь\s+["«]?да,\s*подтверждаю)/iu.test(text || '');
}

function highImpactQuestion(decision: BrowserAction): string {
    const target = decision.selector || decision.comment || 'финальное действие';
    return `Подтверди, что можно выполнить потенциально необратимое действие: ${target}. Ответь «да, подтверждаю», если действительно продолжаем.`;
}

function highImpactConfirmationChoices(): BrowserUserChoice[] {
    return [{ label: 'Да, подтверждаю', answer: 'да, подтверждаю' }];
}

function iterationLimitContinuationChoices(): BrowserUserChoice[] {
    return [{ label: 'Продолжить', answer: 'продолжай' }];
}

function isIterationLimitPauseQuestion(text?: string): boolean {
    return /достигнут\s+лимит\s+(?:итераций|операций)|лимит\s+(?:итераций|операций)/iu.test(text || '');
}

function valueFromLatestUserAnswer(state: BrowserRunState, value?: string): boolean {
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedValue || normalizedValue.length < 2) return false;
    return state.lastUserAnswer.toLowerCase().includes(normalizedValue.toLowerCase());
}

function valueFromTrustedFormSource(state: BrowserRunState, value?: string): boolean {
    const normalizedValue = cleanWhitespace(value || '');
    if (!normalizedValue) return false;

    if (/^\d{1,2}$/u.test(normalizedValue)) {
        const latestAnswer = state.lastUserAnswer;
        if (new RegExp(`(^|\\D)${escapeRegExp(normalizedValue)}(\\D|$)`, 'u').test(latestAnswer)) return true;
    }

    if (normalizedValue.length < 2) return false;

    const trustedText = [
        state.lastUserAnswer,
        state.memoryContext,
        state.recentUserContext,
    ].filter(Boolean).join('\n').toLowerCase();
    if (!trustedText) return false;

    const lowerValue = normalizedValue.toLowerCase();
    if (trustedText.includes(lowerValue)) return true;

    const valueDigits = normalizedValue.replace(/\D+/g, '');
    if (valueDigits.length >= 5) {
        const trustedDigits = trustedText.replace(/\D+/g, '');
        if (trustedDigits.includes(valueDigits)) return true;
    }

    return false;
}

function isBookingOrLeadFormSurface(observation: PageObservation): boolean {
    const surface = [
        observation.formText,
        observation.pageText,
        observation.interactiveText,
    ].join('\n');
    return /(записаться\s+на\s+игру|записаться|отправить\s+заявк|название\s+команд|количество\s+участников|бронирован|заявк[аи]|booking|reservation|lead\s+form)/iu.test(surface);
}

function isContactOrBookingField(text: string): boolean {
    return /(название\s+команд|команд[аы]|team|телефон|phone|tel|email|e-mail|почт|mail|количество\s+участников|участник|participants|players|имя|name|фио|фамили|контакт|contact|откуда|source|message_source|промокод|promo|comment|коммент)/iu.test(text);
}

function isPrimaryBookingDataField(text: string): boolean {
    return /(название\s+команд|команд[аы]|team|телефон|phone|tel|email|e-mail|почт|mail|количество\s+участников|участник|participants|players|имя|name|фио|фамили|контакт|contact|откуда|source|message_source)/iu.test(text);
}

function isLikelyPlaceholderFill(value?: string): boolean {
    const normalized = normalizeSearchText(value || '');
    return !normalized ||
        /^(test|тест|example|пример|name|phone|email|команда|название\s+команды|без\s+названия|unknown|n\/a)$/iu.test(normalized) ||
        /@example\.(?:com|ru)$/iu.test(normalized);
}

function bookingFormFieldsFromObservation(observation: PageObservation): string[] {
    const surface = [observation.formText, observation.pageText].filter(Boolean).join('\n');
    const fieldInfos = observation.formText
        .split('\n')
        .map((line) => {
            const label = line.match(/-\s+(.+?)\s+\[[^\]]+\]/iu)?.[1];
            if (!label) return null;
            return {
                label: cleanWhitespace(label.replace(/\*+$/u, '')),
                required: /\[required|обязательн|\*/iu.test(line),
            };
        })
        .filter((field): field is { label: string; required: boolean } => Boolean(field?.label))
        .filter((field) => isPrimaryBookingDataField(field.label));
    const fields = fieldInfos
        .filter((field) => !/(откуда|source|message_source)/iu.test(field.label) || field.required)
        .map((field) => field.label)
        .filter((field, index, arr) => field && arr.indexOf(field) === index)
        .slice(0, 8);

    if (/количество\s+участников|участник[а-яё]*|participants|players/iu.test(surface) &&
        !fields.some((field) => /количество\s+участников|участник/iu.test(field))) {
        fields.push('количество участников');
    }
    const requiredSourceField = fieldInfos.some((field) =>
        field.required && /(откуда|source|message_source)/iu.test(field.label)
    );
    if (requiredSourceField && !fields.some((field) => /откуда|source|message_source/iu.test(field))) {
        fields.push('откуда узнали');
    }

    return fields.length
        ? fields
        : ['название команды', 'телефон', 'email', 'количество участников'];
}

function bookingFormDataQuestion(observation: PageObservation): string {
    const fields = bookingFormFieldsFromObservation(observation);
    return `Для заявки нужны данные формы: ${fields.join(', ')}. Пришли их одним сообщением. Я не буду подставлять имя, телефон, email, название команды или количество участников из догадок.`;
}

function isBookingSubmitDecision(decision: BrowserAction, observation: PageObservation): boolean {
    if (!isBookingOrLeadFormSurface(observation)) return false;
    if (decision.action !== 'click' && decision.action !== 'press_key') return false;
    const surface = [
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
    ].filter(Boolean).join(' ');
    return /(отправить|отправляю|оставить\s+заявк|заявк[ауи]|submit|send|confirm|подтверд)/iu.test(surface);
}

function safetyQuestionForDecision(
    decision: BrowserAction,
    state: BrowserRunState,
    observation: PageObservation
): string | null {
    const fieldSurface = [
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
    ].filter(Boolean).join(' ');
    const action = decision.action;
    const isFillLike = action === 'fill' || action === 'type';

    if (
        isFillLike &&
        isBookingOrLeadFormSurface(observation) &&
        isContactOrBookingField(fieldSurface) &&
        (isLikelyPlaceholderFill(decision.value) || !valueFromTrustedFormSource(state, decision.value))
    ) {
        return bookingFormDataQuestion(observation);
    }

    if (isBookingSubmitDecision(decision, observation)) {
        const emptyRequired = observation.formText
            .split('\n')
            .some((line) => /\[required/.test(line) && !/\svalue="/u.test(line));
        if (emptyRequired) return bookingFormDataQuestion(observation);
    }

    if (
        isFillLike &&
        isContactOrBookingField(fieldSurface) &&
        (isLikelyPlaceholderFill(decision.value) || !valueFromTrustedFormSource(state, decision.value))
    ) {
        return `Форма просит персональные или контактные данные (${cleanWhitespace(fieldSurface).slice(0, 120)}). Пришли точное значение явно, если его нужно ввести. Я не буду заполнять такие поля из догадок.`;
    }

    if (/captcha\/anti-bot challenge visible/i.test(observation.blockerSignals)) {
        return 'На странице видна anti-bot/captcha-проверка. Я не буду её обходить. Нужно пройти проверку вручную или дать другой способ продолжить.';
    }

    if (
        isFillLike &&
        (/(sms|смс|одноразов|otp|2fa|two[-\s]?factor|код\s+(?:из|подтверждения|безопасности))/i.test(fieldSurface) ||
            (/(one-time code or 2fa required)/i.test(observation.blockerSignals) && /^\d{4,8}$/.test(String(decision.value ?? '').trim())))
    ) {
        if (valueFromLatestUserAnswer(state, decision.value)) return null;
        return 'Сайт просит одноразовый код или 2FA. Пришли код из SMS/приложения, и я продолжу с этого места.';
    }

    if (isFillLike && /(password|парол)/i.test(fieldSurface) && !valueFromLatestUserAnswer(state, decision.value)) {
        return 'Для входа нужен пароль, а подходящего сохранённого значения нет или агент пытается ввести пароль как обычный текст. Пришли пароль явно или сохрани учётные данные для этого сайта.';
    }

    if (isFillLike && /(card\s+number|номер\s+карт|банковск\w*\s+карт|cvv|cvc|expiry|срок\s+действия)/i.test(fieldSurface)) {
        if (valueFromLatestUserAnswer(state, decision.value)) return null;
        return 'Сайт просит платёжные данные. Я не возьму их из догадок или памяти: пришли нужное значение явно, если хочешь продолжить.';
    }

    if (isFillLike && /(паспорт|passport|снилс|snils|инн|inn|document\s+number|номер\s+документа)/i.test(fieldSurface)) {
        if (valueFromLatestUserAnswer(state, decision.value)) return null;
        return 'Форма просит документ или государственный идентификатор. Пришли точное значение явно, если его нужно ввести.';
    }

    return null;
}

function browserDialogPausePromptFromRecord(
    dialog: BrowserDialogRecord
): { kind: string; question: string; choices?: BrowserUserChoice[] } {
    const visibleMessage = dialog.message || '(пустое сообщение)';
    if (dialog.type === 'prompt') {
        return {
            kind: 'browser_dialog',
            question: `Сайт показал системное окно prompt: «${visibleMessage}». Я отклонила его для безопасности. Напиши текст, который можно ввести при повторе действия, или ответь «отмена», если не надо продолжать.`,
            choices: [{ label: 'Остановиться', answer: 'отмена' }],
        };
    }
    return {
        kind: 'browser_dialog',
        question: `Сайт показал системное окно ${dialog.type}: «${visibleMessage}». Я отклонила его для безопасности. Подтверди, можно ли принять его при повторе действия, или скажи отменить задачу.`,
        choices: [
            { label: 'Принять при повторе', answer: 'да, принять системное окно и продолжить' },
            { label: 'Остановиться', answer: 'отмена' },
        ],
    };
}

function manualBlockerPausePrompt(
    observation: PageObservation,
    state: BrowserRunState
): { kind: string; question: string; choices?: BrowserUserChoice[] } | null {
    const latestDialog = latestSafetyDismissedDialog(state, false);
    if (latestDialog && !state.armedDialogResponse) {
        latestDialog.promptedAt = new Date().toISOString();
        return browserDialogPausePromptFromRecord(latestDialog);
    }

    const blockers = observation.blockerSignals || '';
    const surface = [
        blockers,
        observation.modalText,
        observation.formBrainText,
        observation.pageText.slice(0, 1200),
    ].join('\n');

    if (/captcha\/anti-bot challenge visible/i.test(blockers) || /human_verification:/i.test(surface)) {
        return {
            kind: 'human_verification',
            question: 'На странице видна anti-bot/captcha-проверка. Я не буду пытаться её обходить. Пройди проверку вручную в браузере и напиши, что можно продолжать, либо дай другой способ выполнить задачу.',
            choices: [{ label: 'Проверка пройдена', answer: 'Я прошёл проверку, продолжай' }],
        };
    }

    if (/camera or microphone permission required/i.test(blockers)) {
        return {
            kind: 'browser_permission',
            question: 'Страница просит доступ к камере или микрофону. Такое разрешение должен дать человек в браузере. Разреши доступ вручную и напиши, что можно продолжать, либо скажи остановиться.',
            choices: [{ label: 'Разрешил доступ', answer: 'Я разрешил доступ, продолжай' }],
        };
    }

    if (/one-time code or 2fa required/i.test(blockers) && hasVisibleOtpChallenge(observation) && !cleanWhitespace(state.lastUserAnswer)) {
        return {
            kind: 'otp_or_2fa',
            question: 'Сайт просит одноразовый код, SMS или 2FA. Пришли код одним сообщением, и я введу его на этой странице. Я не буду угадывать такие коды.',
        };
    }

    return null;
}

function hasVisibleOtpChallenge(observation: PageObservation): boolean {
    const focusedSurface = [
        observation.modalText,
        observation.formBrainText,
        observation.formText,
        observation.a11yText,
        observation.interactiveText,
    ].join('\n');
    return /(sms|смс|otp|2fa|two[-\s]?factor|одноразов[а-я\s]{0,40}(?:код|парол)|(?:введите|укажите|enter|input)[^.\n]{0,120}(?:код|code)[^.\n]{0,120}(?:sms|смс|подтвержд|безопасн|2fa|otp)|код\s+(?:из\s+(?:sms|смс)|безопасности))/iu.test(focusedSurface);
}

function pushPageEvent(state: BrowserRunState, event: string): void {
    const safeEvent = redactSecrets(event).slice(0, 500);
    state.pageEvents.push(`${new Date().toISOString()} ${safeEvent}`.slice(0, 500));
    if (state.pageEvents.length > 40) {
        state.pageEvents.splice(0, state.pageEvents.length - 40);
    }
    recordBrowserTrajectoryEvent(state, 'page.event', { event: safeEvent });
}

function pushBrowserDialogRecord(state: BrowserRunState, record: BrowserDialogRecord): void {
    const safeRecord: BrowserDialogRecord = {
        ...record,
        message: redactSecrets(cleanWhitespace(record.message)).slice(0, 700),
        defaultValue: record.defaultValue ? redactSecrets(cleanWhitespace(record.defaultValue)).slice(0, 300) : undefined,
    };
    state.dialogs.push(safeRecord);
    if (state.dialogs.length > 12) {
        state.dialogs.splice(0, state.dialogs.length - 12);
    }
    const event = `[dialog:${safeRecord.type}:${safeRecord.handled}] ${safeRecord.message.slice(0, 220)}`;
    pushPageEvent(state, event);
    recordBrowserTrajectoryEvent(state, 'browser.dialog', { ...safeRecord });
    if (safeRecord.handled === 'dismissed_for_safety') {
        state.notes.push(`Системное окно ${safeRecord.type} отклонено для безопасности: ${safeRecord.message}`.slice(0, 700));
        if (state.notes.length > 30) state.notes.splice(0, state.notes.length - 30);
    }
}

function latestSafetyDismissedDialog(state: BrowserRunState, includePrompted = true): BrowserDialogRecord | undefined {
    const now = Date.now();
    return [...state.dialogs].reverse().find((dialog) => {
        if (dialog.handled !== 'dismissed_for_safety') return false;
        if (!includePrompted && dialog.promptedAt) return false;
        const createdAt = Date.parse(dialog.createdAt);
        return Number.isFinite(createdAt) && now - createdAt <= BROWSER_DIALOG_RECENT_MS;
    });
}

function isBrowserDialogPauseQuestion(text?: string): boolean {
    return /сайт\s+показал\s+системн[а-я\s]+окно|системное\s+окно\s+(?:confirm|prompt|beforeunload)|отклонила\s+его\s+для\s+безопасности/iu.test(text || '');
}

function dialogMessageMatchesHint(message: string, hint?: string): boolean {
    const normalizedMessage = normalizeSearchText(message);
    const normalizedHint = normalizeSearchText(hint || '');
    if (!normalizedHint || normalizedHint.length < 8) return true;
    const shortHint = normalizedHint.slice(0, 120);
    const shortMessage = normalizedMessage.slice(0, 120);
    return normalizedMessage.includes(shortHint) || normalizedHint.includes(shortMessage);
}

function usableArmedDialogResponse(state: BrowserRunState, message: string): ArmedBrowserDialogResponse | undefined {
    const armed = state.armedDialogResponse;
    if (!armed) return undefined;
    if (Date.now() > armed.expiresAt) {
        state.armedDialogResponse = undefined;
        return undefined;
    }
    if (!dialogMessageMatchesHint(message, armed.messageHint)) return undefined;
    return armed;
}

function armBrowserDialogFromUserAnswer(
    state: BrowserRunState,
    answer: string,
    pendingQuestion?: string
): 'armed' | 'rejected' | 'ignored' {
    if (!isBrowserDialogPauseQuestion(pendingQuestion)) return 'ignored';
    const latestDialog = latestSafetyDismissedDialog(state);
    if (!latestDialog) return 'ignored';
    if (isExplicitUserRejection(answer)) {
        state.armedDialogResponse = undefined;
        state.notes.push('Пользователь отказался принимать системное окно браузера; задача остановлена.'.slice(0, 500));
        return 'rejected';
    }

    const cleanAnswer = cleanWhitespace(answer);
    const isPrompt = latestDialog.type === 'prompt';
    const acceptsDialog = isExplicitUserConfirmation(cleanAnswer) || /^(?:принять|прими|accept|разрешаю)(?:$|[\s,.;:!?…])/iu.test(cleanAnswer);
    if (!isPrompt && !acceptsDialog) return 'ignored';
    if (isPrompt && !cleanAnswer) return 'ignored';

    state.armedDialogResponse = {
        accept: true,
        promptText: isPrompt && !acceptsDialog ? cleanAnswer : undefined,
        messageHint: latestDialog.message,
        expiresAt: Date.now() + BROWSER_DIALOG_ARM_TTL_MS,
    };
    state.notes.push(`Пользователь разрешил принять следующий системный dialog ${latestDialog.type}; нужно повторить вызвавшее его действие.`.slice(0, 600));
    return 'armed';
}

function pushEvidence(state: BrowserRunState, type: BrowserEvidenceItem['type'], text: string, url = state.page.url()): void {
    const clean = cleanWhitespace(redactSecrets(text)).slice(0, 700);
    if (!clean || clean.length < 8) return;
    const safeUrl = safeLogUrl(url || state.page.url());
    const key = evidenceDedupeKey(type, clean, safeUrl);
    const exists = state.evidenceStash.some((item) =>
        evidenceDedupeKey(item.type, item.text, item.url) === key
    );
    if (exists) return;
    state.evidenceStash.push({
        type,
        text: clean,
        url: safeUrl,
        createdAt: new Date().toISOString(),
    });
    if (state.evidenceStash.length > 48) {
        state.evidenceStash.splice(0, state.evidenceStash.length - 48);
    }
    recordBrowserTrajectoryEvent(state, 'evidence.added', { type, text: clean, url: safeUrl });
}

function canonicalEvidenceHref(text: string): string {
    const href = text.match(/\bhref=(https?:\/\/[^\s)]+)/iu)?.[1];
    if (!href) return '';
    try {
        const parsed = new URL(href);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return href.split('?')[0] || href;
    }
}

function evidenceDedupeKey(type: BrowserEvidenceItem['type'], text: string, url: string): string {
    const productHref = canonicalEvidenceHref(text);
    if (/^product#\d+/iu.test(text) && productHref) {
        return `${type}:product:${normalizeSearchText(productHref)}`;
    }
    return `${type}:${normalizeSearchText(text).slice(0, 240)}:${url}`;
}

function evidenceStashSummary(state?: BrowserRunState, limit = 10): string {
    const items = state?.evidenceStash?.length ? state.evidenceStash.slice(-limit) : [];
    if (!items.length) return '(нет сохранённых доказательств)';
    return items
        .map((item, index) => {
            const url = item.url ? ` url=${item.url}` : '';
            return `  ${index + 1}. [${item.type}] ${item.text.slice(0, 360)}${url}`;
        })
        .join('\n');
}

function networkSnippetsSummary(state?: BrowserRunState, limit = 6): string {
    const snippets = state?.networkSnippets?.length ? state.networkSnippets.slice(-limit) : [];
    if (!snippets.length) return '(нет полезных сетевых ответов)';
    return snippets
        .map((snippet, index) => `  ${index + 1}. ${snippet.method} ${snippet.status} ${snippet.url}\n     ${snippet.body.slice(0, 520)}`)
        .join('\n');
}

function summarizeNetworkBody(rawText: string, contentType: string): string {
    const clean = cleanWhitespace(redactSecrets(rawText));
    if (!clean) return '';
    if (contentType.includes('json')) {
        try {
            const parsed = JSON.parse(rawText);
            const rows: string[] = [];
            const visit = (value: unknown, pathParts: string[] = [], depth = 0): void => {
                if (rows.length >= 24 || depth > 3 || value === null || value === undefined) return;
                if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                    const key = pathParts.join('.');
                    const text = cleanWhitespace(String(value));
                    if (key && text && text.length <= 220 && !/(token|secret|password|pass|authorization|cookie)/iu.test(key)) {
                        rows.push(`${key}=${text}`);
                    }
                    return;
                }
                if (Array.isArray(value)) {
                    for (const [index, item] of value.slice(0, 5).entries()) visit(item, [...pathParts, String(index)], depth + 1);
                    return;
                }
                if (typeof value === 'object') {
                    const obj = value as Record<string, unknown>;
                    const preferred = Object.keys(obj).sort((a, b) => {
                        const rank = (key: string) => /(title|name|label|price|date|status|message|url|href|id|count|total|success|error)/iu.test(key) ? 0 : 1;
                        return rank(a) - rank(b) || a.localeCompare(b);
                    });
                    for (const key of preferred.slice(0, 12)) visit(obj[key], [...pathParts, key], depth + 1);
                }
            };
            visit(parsed);
            if (rows.length) return rows.join(' | ').slice(0, 1600);
        } catch {
            // Fall back to compact text below.
        }
    }
    return clean.slice(0, 1200);
}

function pushNetworkSnippet(state: BrowserRunState, snippet: BrowserNetworkSnippet): void {
    if (!snippet.body) return;
    const key = `${snippet.method}:${snippet.status}:${snippet.url}:${normalizeSearchText(snippet.body).slice(0, 160)}`;
    const exists = state.networkSnippets.some((item) =>
        `${item.method}:${item.status}:${item.url}:${normalizeSearchText(item.body).slice(0, 160)}` === key
    );
    if (exists) return;
    state.networkSnippets.push(snippet);
    if (state.networkSnippets.length > 24) {
        state.networkSnippets.splice(0, state.networkSnippets.length - 24);
    }
    pushEvidence(state, 'network', `${snippet.method} ${snippet.status}: ${snippet.body.slice(0, 460)}`, snippet.url);
    recordBrowserTrajectoryEvent(state, 'network.snippet', {
        method: snippet.method,
        status: snippet.status,
        url: snippet.url,
        contentType: snippet.contentType,
        body: snippet.body.slice(0, 900),
    });
}

function recordEvidenceFromObservation(state: BrowserRunState, observation: PageObservation): void {
    const url = state.page.url();
    const structuredLines = observation.structuredDataText
        .split('\n')
        .map(cleanWhitespace)
        .filter((line) => /^(meta|jsonld|important-link)\b/iu.test(line.replace(/^\s+/u, '')))
        .slice(0, 5);
    for (const line of structuredLines) pushEvidence(state, 'data', line, url);

    const productLines = observation.productCardsText
        .split('\n')
        .map(cleanWhitespace)
        .filter((line) => /^product#\d+/iu.test(line))
        .slice(0, 6);
    for (const line of productLines) pushEvidence(state, 'observation', line, url);

    const tableLines = observation.tableText
        .split('\n')
        .map(cleanWhitespace)
        .filter((line) => /^table#\d+|^row#\d+/iu.test(line))
        .slice(0, 5);
    for (const line of tableLines) pushEvidence(state, 'observation', line, url);

    rememberVisibleListingItems(state, extractVisibleListingItems(observation));

    if (state.pageUnderstanding?.successEvidence) {
        pushEvidence(state, 'success', state.pageUnderstanding.successEvidence, url);
    }
    for (const evidence of state.pageUnderstanding?.evidence || []) {
        pushEvidence(state, state.pageUnderstanding?.phase === 'success' ? 'success' : 'observation', evidence, url);
    }
}

function finalSummaryWithEvidence(summary: string, state: BrowserRunState, task = state.originalTask): string {
    const cleanSummary = cleanWhitespace(summary || 'Задача выполнена.');
    const listingSummary = userReadyListingSummaryFromState(task, state);
    if (listingSummary) return listingSummary;
    if (summaryLooksUserReady(cleanSummary)) return cleanSummary;

    const evidence = state.evidenceStash
        .slice(-8)
        .filter((item) => item.type === 'success' || item.type === 'data' || item.type === 'observation' || item.type === 'network')
        .map(formatEvidenceForUserSummary)
        .filter((item): item is string => Boolean(item))
        .filter((item, index, arr) => arr.findIndex((other) => normalizeSearchText(other) === normalizeSearchText(item)) === index)
        .slice(-5);
    if (!evidence.length) return cleanSummary;
    const bullets = evidence
        .map((item) => `- ${item}`)
        .join('\n');
    return `${cleanSummary}\n\nПроверено на странице:\n${bullets}`;
}

function userReadyListingSummaryFromState(task: string, state: BrowserRunState): string | null {
    const taskSurface = listingTaskSurface(task, state);
    if (!isInformationListingTask(taskSurface) || !state.visibleListingItems.length) return null;
    const temporal = temporalRequirementFromTask(taskSurface);
    const candidates = temporal
        ? state.visibleListingItems.filter((item) => listingItemMatchesTemporalRequirement(item, temporal))
        : state.visibleListingItems;
    const items = prepareVisibleListingItemsForAnswer(candidates);
    if (!items.length) return null;

    const header = temporal
        ? `Нашла на странице варианты за «${temporal.label}»:`
        : 'Нашла на странице такие варианты:';
    return [
        header,
        '',
        formatVisibleListingItemsForAnswer(items.slice(0, 10), { includeDate: !temporal }),
        items.length > 10 ? `\nИ ещё ${items.length - 10} вариант${russianCountSuffix(items.length - 10, '', 'а', 'ов')} ниже по списку.` : '',
    ].filter(Boolean).join('\n');
}

function listingTaskSurface(task: string, state?: BrowserRunState): string {
    return [
        task,
        state?.originalTask,
        state?.recentUserContext,
    ].map((part) => cleanWhitespace(part || '')).filter(Boolean).join('\n');
}

function isUserReadyListingSummary(summary: string): boolean {
    return /^Нашла на странице (?:варианты|такие варианты)/iu.test(cleanWhitespace(summary));
}

function formatBrowserDoneResponse(summary: string, downloadsLine = ''): string {
    if (isUserReadyListingSummary(summary)) {
        return `${summary}${downloadsLine}`;
    }
    return `✅ Готово!\n\n${summary}${downloadsLine}`;
}

function browserDoneScreenshotCaption(summary: string): string {
    if (isUserReadyListingSummary(summary)) {
        const firstLine = cleanWhitespace(summary.split('\n').find((line) => line.trim()) || 'Нашла варианты.');
        return `🌐 ${firstLine.slice(0, 200)}`;
    }
    return `✅ Готово: ${summary.slice(0, 200)}`;
}

function summaryLooksUserReady(summary: string): boolean {
    const hasLink = /https?:\/\/|\[[^\]]{2,80}\]\(https?:\/\/[^)]+\)/iu.test(summary);
    const hasConcreteDetail = /₽|\bруб\b|\b\d{1,3}(?:\s?\d{3})+\b|дата|адрес|подтвержд|заявк|брон|скачан|файл|артикул|размер|цвет/iu.test(summary);
    const hasSelectionLanguage = /(найден[оы]?|подобрал[аи]?|выбрал[аи]?|вариант|ссылк|товар|подходит|соответств)/iu.test(summary);
    return hasLink && (hasConcreteDetail || hasSelectionLanguage);
}

function formatEvidenceForUserSummary(item: BrowserEvidenceItem): string | null {
    const text = cleanWhitespace(item.text);
    if (!text) return null;

    if (/^product#\d+/iu.test(text)) {
        const href = canonicalEvidenceHref(text);
        const priceMatch = text.match(/\bprice="([^"]+)"/iu);
        const productSurface = cleanWhitespace(priceMatch?.[1] || text)
            .replace(/\s*До конца акции[\s\S]*$/iu, '')
            .replace(/\bimage="[^"]*"/giu, '')
            .replace(/\bhref=https?:\/\/\S+/giu, '')
            .replace(/^product#\d+\s*/iu, '')
            .trim();
        const price = currentRublePriceFromText(productSurface);
        const title = cleanWhitespace(
            productSurface
                .replace(/^[-−]?\d+%\s*/u, '')
                .replace(/^.*₽\s*/u, '')
                .replace(/[A-Z0-9_]{8,}/giu, '')
        ).slice(0, 180);
        const parts = [title || price || 'Товар', price && title !== price ? price : '', href].filter(Boolean);
        return parts.join(' — ').slice(0, 320);
    }

    if (/^(meta|jsonld|important-link)\b/iu.test(text)) return null;
    if (/^GET\s+\d{3}:|^POST\s+\d{3}:/iu.test(text)) return null;

    const cleaned = text
        .replace(/\bimage="[^"]*"/giu, '')
        .replace(/\bsource_rec_type=[^\s)]+/giu, '')
        .trim();
    if (!cleaned || cleaned.length < 12) return null;
    return cleaned.slice(0, 260);
}

function currentRublePriceFromText(text: string): string {
    const beforeCurrency = text.match(/([0-9][0-9\s]*)\s*₽/u)?.[1];
    if (!beforeCurrency) return '';
    const groups = beforeCurrency.trim().split(/\s+/u).filter(Boolean);
    if (!groups.length) return '';
    const priceGroups = groups.length >= 4 ? groups.slice(-2) : groups;
    return `${priceGroups.join(' ')} ₽`;
}

type VisibleListingFallbackResult =
    | { action: 'done'; summary: string }
    | { action: 'scroll'; value: 'down'; comment: string };

interface TemporalRequirement {
    label: string;
    startMs?: number;
    endMs?: number;
}

const LISTING_MONTHS_RU: Record<string, number> = {
    января: 0,
    январь: 0,
    февраля: 1,
    февраль: 1,
    марта: 2,
    март: 2,
    апреля: 3,
    апрель: 3,
    мая: 4,
    май: 4,
    июня: 5,
    июнь: 5,
    июля: 6,
    июль: 6,
    августа: 7,
    август: 7,
    сентября: 8,
    сентябрь: 8,
    октября: 9,
    октябрь: 9,
    ноября: 10,
    ноябрь: 10,
    декабря: 11,
    декабрь: 11,
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sep: 8,
    sept: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11,
};

function visibleListingFallbackDecision(
    task: string,
    observation: PageObservation,
    state?: BrowserRunState
): VisibleListingFallbackResult | null {
    const taskSurface = listingTaskSurface(task, state);
    if (!isInformationListingTask(taskSurface)) return null;
    const currentItems = extractVisibleListingItems(observation);
    if (state) rememberVisibleListingItems(state, currentItems);
    const allItems = state?.visibleListingItems?.length ? state.visibleListingItems : currentItems;
    if (!allItems.length) return null;

    const temporal = temporalRequirementFromTask(taskSurface);
    const matchingItems = temporal
        ? allItems.filter((item) => listingItemMatchesTemporalRequirement(item, temporal))
        : allItems;
    const currentMatchingItems = temporal
        ? currentItems.filter((item) => listingItemMatchesTemporalRequirement(item, temporal))
        : currentItems;
    const canScrollDown = observationCanScrollDown(observation);
    const scrollAttempts = visibleListingScrollAttempts(state);
    const asksForBroadList = /(все|всё|список|расписани|какие\s+(?:будут|есть)|что\s+(?:будет|есть)|вариант[а-я]*|доступн[а-я]*|available|list|schedule)/iu.test(taskSurface);
    const shouldExhaustTemporalList = Boolean(temporal && asksForBroadList);
    const maxScrollAttempts = shouldExhaustTemporalList ? 12 : 8;

    if (temporal && !currentMatchingItems.length && canScrollDown && scrollAttempts < maxScrollAttempts) {
        return {
            action: 'scroll',
            value: 'down',
            comment: `На странице уже есть список, но видимые элементы пока не попадают в период «${temporal.label}». Прокручиваю дальше по списку.`,
        };
    }

    if (!matchingItems.length) {
        if (canScrollDown && scrollAttempts < 5) {
            return {
                action: 'scroll',
                value: 'down',
                comment: temporal
                    ? `Пока не вижу элементов за период «${temporal.label}», продолжаю прокручивать список.`
                    : 'Вижу список, продолжаю прокручивать, чтобы собрать больше подходящих вариантов.',
            };
        }
        if (visibleListingDoneRecentlyBlocked(state)) return null;
        return {
            action: 'done',
            summary: temporal
                ? `Я просмотрела видимый список, но не нашла карточек за «${temporal.label}».`
                : `Я просмотрела видимый список и нашла такие варианты:\n${formatVisibleListingItemsForAnswer(prepareVisibleListingItemsForAnswer(allItems).slice(0, 8), { includeDate: true })}`,
        };
    }

    if (shouldExhaustTemporalList && canScrollDown && scrollAttempts < maxScrollAttempts) {
        return {
            action: 'scroll',
            value: 'down',
            comment: `Нашла ${matchingItems.length} карточк${russianCountSuffix(matchingItems.length, 'у', 'и', 'ек')} за «${temporal!.label}», продолжаю сканировать ниже, чтобы собрать все варианты за эту дату.`,
        };
    }

    if (canScrollDown && asksForBroadList && scrollAttempts < 2 && matchingItems.length < 4) {
        return {
            action: 'scroll',
            value: 'down',
            comment: temporal
                ? `Нашла первые элементы за период «${temporal.label}», прокручиваю ещё немного, чтобы не пропустить другие варианты.`
                : 'Нашла первые элементы списка, прокручиваю ещё немного, чтобы собрать более полный ответ.',
        };
    }

    if (visibleListingDoneRecentlyBlocked(state)) return null;
    return {
        action: 'done',
        summary: [
            temporal ? `Нашла на странице варианты за период «${temporal.label}»:` : 'Нашла на странице такие варианты:',
            formatVisibleListingItemsForAnswer(prepareVisibleListingItemsForAnswer(matchingItems).slice(0, 10), { includeDate: !temporal }),
            matchingItems.length > 10 ? `И ещё ${matchingItems.length - 10} вариантов ниже по списку.` : '',
        ].filter(Boolean).join('\n'),
    };
}

function russianCountSuffix(count: number, one: string, few: string, many: string): string {
    const mod100 = Math.abs(count) % 100;
    const mod10 = mod100 % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

function isInformationListingTask(task: string): boolean {
    const text = normalizeSearchText(task);
    if (/(?:запиши|записаться|зарегистрируй|зарегистрироваться|забронируй|забронировать|купи|купить|оформи|оформить|оплати|отправь\s+заявк)/iu.test(text)) {
        return false;
    }
    const asksToInspect =
        /(?:посмотри|посмотреть|скажи|расскажи|найди|подбери|покажи|узнай|проверь|какие|какой|когда|где|сколько|что\s+есть|что\s+будет|list|show|find|tell|check)/iu.test(text);
    const listingDomain =
        /(?:список|расписани|афиш|каталог|вариант|карточк|событи|мероприяти|сеанс|слот|заняти|курс|тур|матч|игр|билет|товар|услуг|ваканси|запис[ьи]|schedule|listing|catalog|event|slot|session|ticket|product|service)/iu.test(text);
    return asksToInspect && listingDomain;
}

function temporalRequirementFromTask(task: string): TemporalRequirement | null {
    const text = normalizeSearchText(task);
    const today = startOfLocalDay(new Date());
    if (/(?:на\s+)?следующ(?:ей|ую|ая)\s+недел|next\s+week/iu.test(text)) {
        const day = today.getDay();
        const daysUntilNextMonday = ((8 - (day || 7)) % 7) || 7;
        const start = addDays(today, daysUntilNextMonday);
        return {
            label: 'следующая неделя',
            startMs: start.getTime(),
            endMs: addDays(start, 7).getTime(),
        };
    }
    if (/(?:на\s+)?эт(?:ой|у|а)\s+недел|this\s+week/iu.test(text)) {
        const day = today.getDay() || 7;
        const start = addDays(today, 1 - day);
        return {
            label: 'эта неделя',
            startMs: start.getTime(),
            endMs: addDays(start, 7).getTime(),
        };
    }
    if (/(?:сегодня|today)/iu.test(text)) {
        return { label: 'сегодня', startMs: today.getTime(), endMs: addDays(today, 1).getTime() };
    }
    if (/(?:завтра|tomorrow)/iu.test(text)) {
        const start = addDays(today, 1);
        return { label: 'завтра', startMs: start.getTime(), endMs: addDays(start, 1).getTime() };
    }
    const explicitDate = parseListingDateFromText(task);
    if (explicitDate) {
        const start = startOfLocalDay(new Date(explicitDate.ms));
        return { label: explicitDate.text, startMs: start.getTime(), endMs: addDays(start, 1).getTime() };
    }
    return null;
}

function visibleListingDoneRecentlyBlocked(state?: BrowserRunState): boolean {
    if (!state) return false;
    return state.history.slice(-6).some((record) =>
        /(?:blocked_universal_done|blocked_shopping_done|completion_review_block)\b/iu.test(record.label) &&
        /\bdone\b/iu.test(record.label)
    );
}

function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
}

function observationCanScrollDown(observation: PageObservation): boolean {
    return /canScrollDown=true/iu.test(observation.scrollDiagnosticsText || '');
}

function visibleListingScrollAttempts(state?: BrowserRunState): number {
    if (!state) return 0;
    return state.history.filter((record) =>
        record.label.startsWith('visible_listing_scroll') ||
        (record.label.startsWith('scroll') && /список|карточк|строк|период|вариант|listing/iu.test(record.comment || ''))
    ).length;
}

function listingItemMatchesTemporalRequirement(item: BrowserVisibleListingItem, temporal: TemporalRequirement): boolean {
    if (!temporal.startMs || !temporal.endMs) return true;
    if (!item.dateMs) return false;
    return item.dateMs >= temporal.startMs && item.dateMs < temporal.endMs;
}

function rememberVisibleListingItems(state: BrowserRunState, items: BrowserVisibleListingItem[]): void {
    for (const item of items) {
        if (state.visibleListingItems.some((known) => known.key === item.key)) continue;
        state.visibleListingItems.push(item);
        pushEvidence(state, 'data', formatVisibleListingItemForAnswer(item), state.page.url());
    }
    if (state.visibleListingItems.length > 60) {
        state.visibleListingItems.splice(0, state.visibleListingItems.length - 60);
    }
}

function extractVisibleListingItems(observation: PageObservation): BrowserVisibleListingItem[] {
    const candidates: BrowserVisibleListingItem[] = [];
    candidates.push(...extractListingItemsFromStructuredBlocks(observation.structureText));
    candidates.push(...extractListingItemsFromProductCards(observation.productCardsText));
    candidates.push(...extractListingItemsFromTables(observation.tableText));

    const seen = new Set<string>();
    return candidates
        .filter((item) => item.title || item.details)
        .filter((item) => itemLooksLikeUsefulListing(item))
        .filter((item) => {
            if (seen.has(item.key)) return false;
            seen.add(item.key);
            return true;
        })
        .slice(0, 24);
}

function extractListingItemsFromStructuredBlocks(text: string): BrowserVisibleListingItem[] {
    return splitSnapshotRecords(text, 'block')
        .map((record) => {
            const title = cleanSnapshotQuotedValue(record, 'title');
            const body = cleanSnapshotBodyText(record);
            const url = cleanUserFacingUrl(firstUrlInText(record));
            return visibleListingItemFromParts('block', title, body, url);
        })
        .filter((item): item is BrowserVisibleListingItem => Boolean(item));
}

function extractListingItemsFromProductCards(text: string): BrowserVisibleListingItem[] {
    return splitSnapshotRecords(text, 'product')
        .map((record) => {
            const brand = cleanSnapshotQuotedValue(record, 'brand');
            const name = cleanSnapshotQuotedValue(record, 'name');
            const price = cleanSnapshotQuotedValue(record, 'price');
            const title = cleanWhitespace([brand, name].filter(Boolean).join(' ')) || cleanWhitespace(price.replace(/^.*₽\s*/u, ''));
            const body = cleanWhitespace([price, cleanSnapshotBodyText(record)].filter(Boolean).join(' '));
            const url = cleanUserFacingUrl(firstUrlInText(record));
            return visibleListingItemFromParts('product', title, body, url);
        })
        .filter((item): item is BrowserVisibleListingItem => Boolean(item));
}

function extractListingItemsFromTables(text: string): BrowserVisibleListingItem[] {
    return splitSnapshotRecords(text, 'row')
        .map((record) => visibleListingItemFromParts('row', '', cleanSnapshotBodyText(record) || record, cleanUserFacingUrl(firstUrlInText(record))))
        .filter((item): item is BrowserVisibleListingItem => Boolean(item));
}

function splitSnapshotRecords(text: string, prefix: 'block' | 'product' | 'row'): string[] {
    if (!text) return [];
    const pattern = new RegExp(`^\\s*${prefix}#\\d+`, 'iu');
    const records: string[] = [];
    let current: string[] = [];
    for (const line of text.split('\n')) {
        if (pattern.test(line)) {
            if (current.length) records.push(current.join('\n'));
            current = [line];
        } else if (current.length) {
            current.push(line);
        }
    }
    if (current.length) records.push(current.join('\n'));
    return records;
}

function cleanSnapshotQuotedValue(record: string, key: string): string {
    return cleanWhitespace(record.match(new RegExp(`${escapeRegExp(key)}="([^"]*)"`, 'iu'))?.[1] || '');
}

function cleanSnapshotBodyText(record: string): string {
    const text = record.match(/\n\s*text=([\s\S]+)/iu)?.[1] || '';
    return cleanWhitespace(text);
}

function firstUrlInText(text: string): string {
    return text.match(/https?:\/\/[^\s\]|")]+/iu)?.[0] || '';
}

function cleanUserFacingUrl(rawUrl: string): string {
    if (!rawUrl) return '';
    try {
        const url = new URL(rawUrl);
        for (const key of [...url.searchParams.keys()]) {
            if (/^(utm_|yclid|gclid|fbclid|source|source_|ref|ref_|from|spm|sku)/iu.test(key)) {
                url.searchParams.delete(key);
            }
        }
        url.hash = '';
        return url.toString();
    } catch {
        return rawUrl.split('?')[0] || rawUrl;
    }
}

const LISTING_WEEKDAY_RE = /^(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)$/iu;

function visibleListingItemFromParts(
    source: string,
    title: string,
    body: string,
    url?: string
): BrowserVisibleListingItem | null {
    const cleanBody = cleanListingText(body);
    const cleanTitle = chooseVisibleListingTitle(cleanListingText(title), cleanBody);
    const date = parseListingDateFromText([cleanTitle, cleanBody].join(' '));
    const details = buildVisibleListingDetails(cleanTitle, cleanBody);
    const key = normalizeSearchText([cleanTitle, date?.text || '', details, url || ''].join('|')).slice(0, 300);
    if (!key || key.length < 8) return null;
    return {
        key,
        title: cleanTitle,
        details,
        url: url || undefined,
        dateText: date?.text,
        dateMs: date?.ms,
        source,
        firstSeenAt: new Date().toISOString(),
    };
}

function listingTextSegments(text: string): string[] {
    return text
        .split(/\s*(?:\||\n|•|·)\s*/u)
        .map((part) => cleanWhitespace(part))
        .filter(Boolean)
        .filter((part, index, arr) => arr.indexOf(part) === index)
        .slice(0, 30);
}

function isWeakListingTitleSegment(segment: string): boolean {
    const normalized = normalizeSearchText(segment);
    if (!normalized) return true;
    if (segment.length > 140) return true;
    if (LISTING_WEEKDAY_RE.test(normalized)) return true;
    if (/^(?:обычный|тематический|онлайн|online|offline|офлайн|платно|бесплатно)$/iu.test(normalized)) return true;
    if (/^(?:расписани[ея]|каталог|список|ближайш|главная|меню|навигаци[яи])\b/iu.test(normalized)) return true;
    if (/^(?:перейти|подробнее|открыть|выбрать|записаться|купить|book|buy|details|select|open)$/iu.test(normalized)) return true;
    if (/^(?:сложность|адрес|место|стоимость|цена|начало|окончание|время|дата|скидка)\b/iu.test(normalized)) return true;
    if (/^\d{1,2}[:.]\d{2}$/u.test(normalized)) return true;
    if (/^(?:\d[\d\s\u00a0]{0,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)|(?:₽|руб\.?|₸|\$|€)\s*\d[\d\s\u00a0]{0,9})$/iu.test(segment)) return true;

    const date = parseListingDateFromText(segment);
    if (date && normalized.length <= normalizeSearchText(date.text).length + 14) return true;

    return false;
}

function chooseVisibleListingTitle(title: string, body: string): string {
    const titleSegments = listingTextSegments(title);
    const bodySegments = listingTextSegments(body);
    const allSegments = [...titleSegments, ...bodySegments];
    const numberedTitle = allSegments.find((segment) => /#\d{1,8}\b/u.test(segment) && !isWeakListingTitleSegment(segment));
    if (numberedTitle) return cleanVisibleListingAnswerTitle(numberedTitle).slice(0, 180);

    const directTitle = titleSegments.find((segment) => !isWeakListingTitleSegment(segment));
    if (directTitle) return cleanVisibleListingAnswerTitle(directTitle).slice(0, 180);

    const scored = allSegments
        .filter((segment) => !isWeakListingTitleSegment(segment))
        .map((segment, index) => {
            let score = 100 - index;
            if (/#\d+/u.test(segment)) score += 40;
            if (/[A-ZА-ЯЁ][a-zа-яё]+/u.test(segment)) score += 16;
            if (segment.length >= 8 && segment.length <= 90) score += 12;
            if (/(?:описани|услов|повтор|скидк|предъявлен|документ|вопрос|стоимост|сложност)/iu.test(segment)) score -= 35;
            return { segment, score };
        })
        .sort((a, b) => b.score - a.score);
    if (scored[0]) return cleanVisibleListingAnswerTitle(scored[0].segment).slice(0, 180);

    return cleanVisibleListingAnswerTitle(titleSegments[0] || bodySegments[0] || 'Вариант').slice(0, 180);
}

function cleanListingText(text: string): string {
    return cleanWhitespace(redactSecrets(text))
        .replace(/\bimage="[^"]*"/giu, '')
        .replace(/\bsource_rec_type=[^\s)]+/giu, '')
        .replace(/\bsku=[^\s)&]+/giu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function itemLooksLikeUsefulListing(item: BrowserVisibleListingItem): boolean {
    const text = normalizeSearchText([item.title, item.details, item.url || ''].join(' '));
    if (text.length < 12) return false;
    if (/^(главная|меню|навигация|поиск|фильтр|сброс|подобрать|подробнее|открыть|выбрать|записаться|купить)$/iu.test(text)) return false;
    if (looksLikeNonListingPageChrome(item)) return false;
    const hasStructuredSignal =
        Boolean(item.dateMs) ||
        /\b\d{1,2}[:.]\d{2}\b/u.test(text) ||
        /(?:₽|руб\.?|₸|\$|€|\b\d+\s*(?:мест|билет|слот|вариант))/iu.test(text) ||
        /(?:адрес|ул\.|улиц|просп|шоссе|площад|зал|аудитор|онлайн|online|venue|location|address)/iu.test(text) ||
        Boolean(item.url);
    const hasEnoughContent = cleanWhitespace([item.title, item.details].join(' ')).length >= 35;
    return hasStructuredSignal && hasEnoughContent;
}

function looksLikeNonListingPageChrome(item: BrowserVisibleListingItem): boolean {
    const title = normalizeSearchText(item.title);
    const surface = normalizeSearchText([item.title, item.details, item.url || ''].join(' '));
    if (/^(?:отвечаем\s+на\s+звонки|квизы\s+в\s+барах|квизы\s+онлайн|политика\s+конфиденциальности|условия\s+пользовательского\s+соглашения|подпишись|telegram|vk)$/iu.test(title)) {
        return true;
    }
    if (/(?:info@|vk\.com\/|t\.me\/|agreement\.html|privacy|политика\s+конфиденциальности|пользовательск[а-яё]+\s+соглашени)/iu.test(surface)) {
        return true;
    }
    if (/(?:отвечаем\s+на\s+звонки|подпишись\s+на\s+телеграм|получай\s+уведомления\s+о\s+новых\s+играх)/iu.test(surface)) {
        return true;
    }
    return false;
}

function buildVisibleListingDetails(title: string, body: string): string {
    const source = cleanWhitespace([title, body].filter(Boolean).join(' '));
    if (!source) return '';
    const date = parseListingDateFromText(source)?.text || '';
    const times = [...source.matchAll(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/gu)]
        .map((match) => match[0].replace('.', ':'))
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .slice(0, 3);
    const prices = extractCurrencyValues(source).slice(0, 2);
    const titlePattern = title ? new RegExp(escapeRegExp(title), 'giu') : null;
    const remainder = cleanWhitespace(
        source
            .replace(titlePattern ?? /$^/u, '')
            .replace(date, '')
            .replace(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/gu, '')
            .replace(/(?:\b\d[\d\s\u00a0]{0,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)|(?:₽|руб\.?|₸|\$|€)\s*\d[\d\s\u00a0]{0,9})/giu, '')
            .replace(/\b(?:записаться|купить|подробнее|выбрать|открыть|перейти|book|buy|details|select|open)\b/giu, '')
            .replace(/\s*\|\s*/gu, ' — ')
            .replace(/\s*(?:—\s*){2,}/gu, ' — ')
            .replace(/^(?:—\s*)+|(?:\s*—)+$/gu, '')
    ).slice(0, 180);
    return [date, times.join(', '), prices.join(', '), remainder].filter(Boolean).join(' — ');
}

function extractCurrencyValues(text: string): string[] {
    const values = [...text.matchAll(/(?:\b\d[\d\s\u00a0]{0,9}\s*(?:₽|руб\.?|р\.?|₸|\$|€)|(?:₽|руб\.?|₸|\$|€)\s*\d[\d\s\u00a0]{0,9})/giu)]
        .map((match) => cleanWhitespace(match[0].replace(/\u00a0/g, ' ')))
        .filter((value) => value.length <= 30);
    return values.filter((value, index, arr) => arr.indexOf(value) === index);
}

function parseListingDateFromText(text: string): { text: string; ms: number } | null {
    const today = startOfLocalDay(new Date());
    const named = text.match(/\b(\d{1,2})\s*(января|январь|февраля|февраль|марта|март|апреля|апрель|мая|май|июня|июнь|июля|июль|августа|август|сентября|сентябрь|октября|октябрь|ноября|ноябрь|декабря|декабрь|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/iu);
    if (named) {
        const day = Number(named[1]);
        const month = LISTING_MONTHS_RU[normalizeSearchText(named[2])];
        if (Number.isInteger(day) && month !== undefined) {
            const date = inferListingDateYear(day, month, today);
            return { text: cleanWhitespace(named[0]), ms: date.getTime() };
        }
    }

    const numeric = text.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/u);
    if (numeric) {
        const day = Number(numeric[1]);
        const month = Number(numeric[2]) - 1;
        let year = numeric[3] ? Number(numeric[3]) : today.getFullYear();
        if (year < 100) year += 2000;
        if (Number.isInteger(day) && Number.isInteger(month) && month >= 0 && month < 12) {
            const date = numeric[3] ? new Date(year, month, day) : inferListingDateYear(day, month, today);
            return { text: cleanWhitespace(numeric[0]), ms: date.getTime() };
        }
    }

    return null;
}

function inferListingDateYear(day: number, month: number, today: Date): Date {
    const candidate = new Date(today.getFullYear(), month, day);
    if (candidate.getTime() < addDays(today, -30).getTime()) {
        return new Date(today.getFullYear() + 1, month, day);
    }
    return candidate;
}

interface VisibleListingAnswerFormatOptions {
    includeDate?: boolean;
}

function prepareVisibleListingItemsForAnswer(items: BrowserVisibleListingItem[]): BrowserVisibleListingItem[] {
    const byKey = new Map<string, BrowserVisibleListingItem>();
    for (const item of items) {
        const key = visibleListingAnswerDedupeKey(item);
        const current = byKey.get(key);
        if (!current || visibleListingAnswerScore(item) > visibleListingAnswerScore(current)) {
            byKey.set(key, item);
        }
    }
    return [...byKey.values()]
        .filter((item) => !isWeakListingTitleSegment(item.title))
        .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0) || firstListingTimeMinutes(a) - firstListingTimeMinutes(b) || a.title.localeCompare(b.title, 'ru'));
}

function visibleListingAnswerDedupeKey(item: BrowserVisibleListingItem): string {
    if (item.url) return `url:${cleanUserFacingUrl(item.url)}`;
    const time = firstListingTimeText(item);
    return normalizeSearchText([item.dateText || '', time, cleanVisibleListingAnswerTitle(item.title)].join('|')).slice(0, 220);
}

function visibleListingAnswerScore(item: BrowserVisibleListingItem): number {
    const title = cleanVisibleListingAnswerTitle(item.title);
    const details = cleanWhitespace(item.details);
    let score = 0;
    if (item.dateMs) score += 30;
    if (firstListingTimeText(item)) score += 18;
    if (extractCurrencyValues(details).length) score += 8;
    if (item.url) score += 8;
    if (/#\d{1,8}\b/u.test(title)) score += 35;
    if (title.length >= 6 && title.length <= 90) score += 12;
    if (listingDescriptionForAnswer(item).length >= 30) score += 18;
    if (/^(?:только\s+наличными|начало\s+игры|с\s+человека)$/iu.test(normalizeSearchText(title))) score -= 35;
    if (isWeakListingTitleSegment(title)) score -= 80;
    return score;
}

function firstListingTimeText(item: BrowserVisibleListingItem): string {
    return [item.title, item.details].join(' ').match(/\b([01]?\d|2[0-3])[:.][0-5]\d\b/u)?.[0]?.replace('.', ':') || '';
}

function firstListingTimeMinutes(item: BrowserVisibleListingItem): number {
    const time = firstListingTimeText(item);
    const match = time.match(/^(\d{1,2}):(\d{2})$/u);
    if (!match) return Number.MAX_SAFE_INTEGER;
    return Number(match[1]) * 60 + Number(match[2]);
}

function formatVisibleListingItemsForAnswer(
    items: BrowserVisibleListingItem[],
    options: VisibleListingAnswerFormatOptions = {}
): string {
    return items
        .map((item, index) => `${index + 1}. ${formatVisibleListingItemForAnswer(item, options)}`)
        .join('\n\n');
}

function formatVisibleListingItemForAnswer(
    item: BrowserVisibleListingItem,
    options: VisibleListingAnswerFormatOptions = {}
): string {
    const title = cleanVisibleListingAnswerTitle(item.title || 'Вариант');
    const meta = visibleListingMetaForAnswer(item, options);
    const description = listingDescriptionForAnswer(item);
    const lines = [
        title,
        meta ? `   ${meta}` : '',
        description ? `   ${description}` : '',
        item.url ? `   ${cleanUserFacingUrl(item.url)}` : '',
    ].filter(Boolean);
    return lines.join('\n').slice(0, 720);
}

function cleanVisibleListingAnswerTitle(title: string): string {
    let cleaned = cleanWhitespace(title)
        .replace(/\s+[-–—]\s*(?:\d{1,2}\s*)?(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b.*$/iu, '')
        .replace(/\s+[-–—]\s*\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b.*$/u, '')
        .replace(/^(?:игра|квиз|мероприятие|событие)\s*[:#-]\s*/iu, '')
        .replace(/\s*(?:—\s*){2,}/gu, ' — ')
        .replace(/^[-–—\s]+|[-–—\s]+$/gu, '');
    if (!cleaned) cleaned = cleanWhitespace(title) || 'Вариант';
    return cleaned.slice(0, 160);
}

function visibleListingMetaForAnswer(item: BrowserVisibleListingItem, options: VisibleListingAnswerFormatOptions): string {
    const surface = [item.title, item.details].join(' ');
    const date = options.includeDate === false ? '' : item.dateText || parseListingDateFromText(surface)?.text || '';
    const time = firstListingTimeText(item);
    const price = extractCurrencyValues(surface)[0] || '';
    return [date, time, price].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).join(', ');
}

function listingDescriptionForAnswer(item: BrowserVisibleListingItem): string {
    const title = cleanVisibleListingAnswerTitle(item.title);
    const segments = listingTextSegments(item.details)
        .map((segment) => segment.replace(/\s*(?:—\s*){2,}/gu, ' — ').trim())
        .filter(Boolean)
        .filter((segment) => normalizeSearchText(cleanVisibleListingAnswerTitle(segment)) !== normalizeSearchText(title))
        .filter((segment) => !isListingMetaSegment(segment))
        .filter((segment, index, arr) => arr.findIndex((other) => normalizeSearchText(other) === normalizeSearchText(segment)) === index);
    const sentenceLike = segments.filter((segment) => segment.length >= 28 && /[а-яёa-z]/iu.test(segment));
    const shortTags = segments
        .filter((segment) => segment.length >= 4 && segment.length <= 32 && !/[.!?]/u.test(segment))
        .slice(0, 1);
    const chosen = [...shortTags, ...sentenceLike].slice(0, 3);
    return cleanWhitespace(chosen.join(' ')).slice(0, 260);
}

function isListingMetaSegment(segment: string): boolean {
    const normalized = normalizeSearchText(segment);
    if (!normalized) return true;
    if (isWeakListingTitleSegment(segment)) return true;
    if (/^(?:сложность|стоимость|цена|начало|окончание|место|адрес|скидка|повтор\s+вопросов|с\s+человека)\b/iu.test(normalized)) return true;
    if (/(?:ул\.|улиц|просп|шоссе|площад|пер\.|бульвар|наб\.|д\.)/iu.test(segment)) return true;
    if (/^https?:\/\//iu.test(segment)) return true;
    return false;
}

function attachPageObserversToPage(state: BrowserRunState, page: Page): void {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('dialog', async (dialog) => {
        const type = dialog.type();
        const message = redactSecrets(cleanWhitespace(dialog.message()));
        const defaultValue = redactSecrets(cleanWhitespace(dialog.defaultValue() || '')) || undefined;
        let handled: BrowserDialogRecord['handled'] = 'failed';
        try {
            const armed = usableArmedDialogResponse(state, message);
            if (armed) {
                if (armed.accept) {
                    await dialog.accept(armed.promptText);
                    handled = 'accepted_by_user';
                } else {
                    await dialog.dismiss();
                    handled = 'dismissed_by_user';
                }
                state.armedDialogResponse = undefined;
            } else if (type === 'alert') {
                await dialog.accept();
                handled = 'accepted_alert';
            } else {
                await dialog.dismiss();
                handled = 'dismissed_for_safety';
            }
        } catch (err) {
            handled = 'failed';
            pushPageEvent(state, `[dialog:error] ${safeErrorMessage(err)}`);
        } finally {
            pushBrowserDialogRecord(state, {
                type,
                message,
                defaultValue,
                handled,
                createdAt: new Date().toISOString(),
            });
        }
    });
    page.on('console', (msg) => {
        if (!['error', 'warning'].includes(msg.type())) return;
        pushPageEvent(state, `[console:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
        pushPageEvent(state, `[pageerror] ${safeErrorMessage(err)}`);
    });
    page.on('response', async (response) => {
        const status = response.status();
        const resourceType = response.request().resourceType();
        if (status >= 400) {
            if (!['document', 'xhr', 'fetch'].includes(resourceType)) return;
            pushPageEvent(state, `[http:${status}:${resourceType}] ${response.url()}`);
            return;
        }
        if (!['xhr', 'fetch'].includes(resourceType)) return;
        if (status < 200 || status >= 300) return;
        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        if (!/(json|text|graphql|javascript)/iu.test(contentType)) return;
        const url = response.url();
        if (/(analytics|metrika|googletagmanager|google-analytics|doubleclick|facebook|sentry|hotjar|segment|amplitude|telemetry)/iu.test(url)) return;
        try {
            const rawText = await response.text();
            if (!rawText || rawText.length > 180_000) return;
            const body = summarizeNetworkBody(rawText, contentType);
            if (!body || body.length < 12) return;
            pushNetworkSnippet(state, {
                method: response.request().method(),
                status,
                url: safeLogUrl(url),
                contentType: contentType.slice(0, 100),
                body: body.slice(0, 1600),
                createdAt: new Date().toISOString(),
            });
        } catch (err) {
            devLog('browserAgent: failed to capture network response:', safeErrorMessage(err));
        }
    });
    page.on('download', async (download) => {
        try {
            const filename = safeFileName(download.suggestedFilename());
            const dir = path.join(os.tmpdir(), 'kira-browser-downloads', state.id);
            fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, `${Date.now()}_${filename}`);
            await download.saveAs(filePath);
            state.downloads.push({ filename, filePath, url: download.url() });
            state.notes.push(`Скачан файл: ${filename}`);
            pushEvidence(state, 'download', `Скачан файл: ${filename}`, download.url() || state.page.url());
            pushPageEvent(state, `[download] ${filename}`);
        } catch (err) {
            pushPageEvent(state, `[download:error] ${safeErrorMessage(err)}`);
        }
    });
}

function attachPageObservers(state: BrowserRunState): void {
    attachPageObserversToPage(state, state.page);
    state.browserCtx.on('page', (page) => {
        installBrowserPageDefaults(page);
        attachPageObserversToPage(state, page);
    });
}

async function adoptLatestPage(state: BrowserRunState): Promise<void> {
    const pages = state.browserCtx.pages().filter((p) => !p.isClosed());
    const latest = pages[pages.length - 1];
    if (!latest || latest === state.page) return;

    await latest.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    installBrowserPageDefaults(latest);
    state.page = latest;
    attachPageObserversToPage(state, latest);
    pushPageEvent(state, `[browser] switched to new page ${latest.url()}`);
    recordBrowserTrajectoryEvent(state, 'browser.page_switched', {
        url: safeLogUrl(latest.url()),
        pages: pages.length,
    });
}

async function ensureUsableBrowserPage(state: BrowserRunState): Promise<void> {
    if (!state.browser.isConnected()) {
        throw new Error('Браузерное соединение закрыто. Нужно перезапустить браузерную задачу.');
    }

    if (!state.page.isClosed()) return;

    const livePages = state.browserCtx.pages().filter((candidate) => !candidate.isClosed());
    const replacement = livePages[livePages.length - 1] ?? await state.browserCtx.newPage();
    installBrowserPageDefaults(replacement);
    state.page = replacement;
    attachPageObserversToPage(state, replacement);
    pushPageEvent(state, `[browser] recovered active page ${replacement.url()}`);
    browserLog('browser_page_recovered', {
        sessionId: state.id,
        url: safeLogUrl(replacement.url()),
        livePages: livePages.length,
    });
    recordBrowserTrajectoryEvent(state, 'browser.page_recovered', {
        url: safeLogUrl(replacement.url()),
        livePages: livePages.length,
    });
}

function browserTaskSessionFromMessage(message: string): string | undefined {
    return message.match(/browserSessionId:\s*([a-zA-Z0-9-]+)/)?.[1];
}

function browserTaskAnswerFromMessage(message: string): string | undefined {
    const match = message.match(/Ответ пользователя:\s*([\s\S]*?)(?:\n(?:Используй ответ|Предыдущая live-сессия|Вопрос агента пользователю:|Вопрос, на который отвечал пользователь:|Контекст предыдущей|Последняя страница:|Заголовок последней страницы:)|\n$|$)/);
    return match?.[1]?.trim();
}

function browserTaskUserAnswerFromText(message: string): string | undefined {
    const explicit = browserTaskAnswerFromMessage(message);
    if (explicit) return explicit;

    const resumed = message.match(/Уточнение пользователя для продолжения браузерной задачи:\s*([\s\S]*?)(?:\n(?:Используй ответ|Предыдущая live-сессия|Вопрос агента пользователю:|Вопрос, на который отвечал пользователь:|Контекст предыдущей|Последняя страница:|Заголовок последней страницы:)|\n$|$)/)?.[1]?.trim();
    if (!resumed || resumed === '(ответ не распознан)') return undefined;
    return resumed;
}

interface ParsedBrowserContinuation {
    sessionId?: string;
    originalTask?: string;
    question?: string;
    answer?: string;
    previousContext?: string;
    previousUrl?: string;
    previousTitle?: string;
}

function parseHttpUrl(value?: string): string | undefined {
    if (!value) return undefined;
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
    } catch {
        return undefined;
    }
}

function parseBrowserContinuationMessage(message: string): ParsedBrowserContinuation | null {
    if (!BROWSER_CONTINUATION_RE.test(message)) return null;
    const sessionId = browserTaskSessionFromMessage(message);
    const originalTask = message.match(/Исходная задача пользователя:\s*([\s\S]*?)(?:\nВопрос агента пользователю:|\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const question = message.match(/Вопрос агента пользователю:\s*([\s\S]*?)(?:\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const previousContext = message.match(/Контекст предыдущей завершённой браузерной задачи:\s*([\s\S]*?)(?:\nПоследняя страница:|\nЗаголовок последней страницы:|\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const previousUrl = parseHttpUrl(message.match(/Последняя страница:\s*(\S+)/)?.[1]);
    const previousTitle = message.match(/Заголовок последней страницы:\s*([\s\S]*?)(?:\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const answer = browserTaskAnswerFromMessage(message);
    return { sessionId, originalTask, question, answer, previousContext, previousUrl, previousTitle };
}

function getPausedBrowserSession(ctx: BotContext, message: string): BrowserRunState | undefined {
    const sessionId =
        ctx.session.pendingBrowserTask?.sessionId ||
        browserTaskSessionFromMessage(message);
    if (!sessionId) return undefined;

    const state = pausedBrowserSessions.get(sessionId);
    if (!state) return undefined;
    if (Date.now() > state.expiresAt) {
        closeBrowserRunState(state, 'expired').catch(() => {});
        return undefined;
    }
    if (state.userId !== (ctx.from?.id ?? 0) || state.chatId !== ctx.chat?.id) return undefined;
    return state;
}

function browserRunOwnerKey(userId: number, chatId?: number): string {
    return `${chatId ?? 0}:${userId}`;
}

function browserRunOwnerKeyForContext(ctx: BotContext): string {
    return browserRunOwnerKey(ctx.from?.id ?? 0, ctx.chat?.id);
}

function shouldInterruptActiveBrowserRun(ctx: BotContext, message: string): boolean {
    if (BROWSER_CONTINUATION_RE.test(message) || !isBrowserCancellationText(message)) return false;
    return Boolean(getActiveBrowserSession(ctx) || ctx.session.activeBrowserTask || ctx.session.pendingBrowserTask);
}

async function enqueueBrowserAgentLane<T>(
    ctx: BotContext,
    run: () => Promise<T>
): Promise<T> {
    const laneKey = browserRunOwnerKeyForContext(ctx);
    const previous = browserAgentLanes.get(laneKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    browserAgentLanes.set(laneKey, next);

    const waitedSince = Date.now();
    let waitNoticeSent = false;
    const waitNotice = setTimeout(() => {
        waitNoticeSent = true;
        sendProgress(ctx, '🌐 Браузерная сессия уже выполняет действие; ставлю новое сообщение в очередь этой же сессии.').catch(() => {});
    }, 2_000);

    try {
        await previous.catch(() => undefined);
        clearTimeout(waitNotice);
        if (waitNoticeSent) {
            browserLog('browser_lane_waited', {
                laneKey,
                waitedMs: Date.now() - waitedSince,
            });
        }
        return await run();
    } finally {
        clearTimeout(waitNotice);
        releaseCurrent();
        if (browserAgentLanes.get(laneKey) === next) {
            browserAgentLanes.delete(laneKey);
        }
    }
}

function registerActiveBrowserRun(ctx: BotContext, state: BrowserRunState): void {
    activeBrowserSessions.set(browserRunOwnerKey(state.userId, state.chatId), state);
    ctx.session.activeBrowserTask = {
        originalTask: state.originalTask,
        sessionId: state.id,
        createdAt: Date.now(),
        expiresAt: state.expiresAt,
    };
}

function getActiveBrowserSession(ctx: BotContext): BrowserRunState | undefined {
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id;
    const state = activeBrowserSessions.get(browserRunOwnerKey(userId, chatId));
    if (!state) return undefined;
    if (Date.now() > state.expiresAt || state.userId !== userId || state.chatId !== chatId) {
        activeBrowserSessions.delete(browserRunOwnerKey(userId, chatId));
        return undefined;
    }
    return state;
}

export function hasActiveBrowserRunForContext(ctx: BotContext): boolean {
    return Boolean(getActiveBrowserSession(ctx));
}

function isBrowserCancellationText(text: string): boolean {
    return looksLikeBrowserTaskCancellation(text);
}

function compactBrowserChoiceLabel(label: string): string {
    const singleLine = cleanWhitespace(label);
    return singleLine.length <= 54 ? singleLine : `${singleLine.slice(0, 53).trimEnd()}…`;
}

function buildBrowserPauseKeyboard(sessionId: string, choices: BrowserUserChoice[] = []): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    choices.slice(0, 4).forEach((choice, index) => {
        keyboard.text(compactBrowserChoiceLabel(choice.label), `browser_choice:${sessionId}:${index}`).row();
    });
    keyboard.text('Отменить браузерную задачу', `browser_cancel:${sessionId}`);
    return keyboard;
}

function pauseBrowserRun(
    ctx: BotContext,
    state: BrowserRunState,
    question: string,
    risk?: 'high_impact',
    choices?: BrowserUserChoice[]
): void {
    state.expiresAt = Date.now() + PENDING_BROWSER_TTL_MS;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
        closeBrowserRunState(state, 'expired').catch(() => {});
    }, PENDING_BROWSER_TTL_MS);
    pausedBrowserSessions.set(state.id, state);
    activeBrowserSessions.delete(browserRunOwnerKey(state.userId, state.chatId));
    ctx.session.activeBrowserTask = undefined;
    ctx.session.pendingBrowserTask = {
        originalTask: state.originalTask,
        question,
        sessionId: state.id,
        risk,
        choices: choices?.slice(0, 4),
        createdAt: Date.now(),
        expiresAt: state.expiresAt,
    };
    browserLog('pause_browser_run', {
        sessionId: state.id,
        risk,
        question: question.slice(0, 220),
        choices: choices?.length || 0,
    });
    recordBrowserTrajectoryEvent(state, 'lifecycle.pause', {
        risk,
        question: question.slice(0, 600),
        choices: choices?.map((choice) => choice.label).slice(0, 4),
    });
}

function resumeBrowserRun(ctx: BotContext, state: BrowserRunState): void {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = undefined;
    pausedBrowserSessions.delete(state.id);
    ctx.session.pendingBrowserTask = undefined;
    registerActiveBrowserRun(ctx, state);
    recordBrowserTrajectoryEvent(state, 'lifecycle.resume', {
        iterationCount: state.iterationCount,
        historyLength: state.history.length,
    });
}

function ensureBrowserRunStateShape(state: BrowserRunState): void {
    const mutable = state as BrowserRunState & {
        networkSnippets?: BrowserNetworkSnippet[];
        evidenceStash?: BrowserEvidenceItem[];
        visibleListingItems?: BrowserVisibleListingItem[];
        formAutofillAttempts?: string[];
        loopCheckpointSignatures?: string[];
        dialogs?: BrowserDialogRecord[];
        taskContractSource?: string;
    };
    mutable.networkSnippets ||= [];
    mutable.evidenceStash ||= [];
    mutable.visibleListingItems ||= [];
    mutable.formAutofillAttempts ||= [];
    mutable.loopCheckpointSignatures ||= [];
    mutable.dialogs ||= [];
    mutable.taskContractSource ||= undefined;
}

async function closeBrowserRunState(state: BrowserRunState, reason: 'done' | 'failed' | 'expired' | 'cancelled'): Promise<void> {
    if (state.timeout) clearTimeout(state.timeout);
    pausedBrowserSessions.delete(state.id);
    activeBrowserSessions.delete(browserRunOwnerKey(state.userId, state.chatId));
    recordBrowserTrajectoryEvent(state, 'lifecycle.close', {
        reason,
        historyLength: state.history.length,
        notes: state.notes.slice(-5),
        evidenceItems: state.evidenceStash.length,
        downloads: state.downloads.map((download) => download.filename).slice(0, 5),
    });
    finishBrowserTrajectory(state, reason);
    state.trajectory = undefined;

    const domain = extractDomain(state.page.url());
    if (domain && domain !== 'about:blank') {
        await BrowserSessionStore.save(state.browserCtx, state.userId, domain).catch(() => {});
    }

    await state.browserCtx.close().catch(() => {});
    await state.browser.close().catch(() => {});
    for (const download of state.downloads) {
        fs.unlink(download.filePath, () => {});
    }
    devLog('browserAgent: closed browser run', state.id, reason);
}

async function sendDownloadedFiles(ctx: BotContext, state: BrowserRunState): Promise<string[]> {
    const sent: string[] = [];
    for (const download of state.downloads.slice(0, 5)) {
        try {
            const stat = fs.statSync(download.filePath);
            if (stat.size > 45 * 1024 * 1024) {
                sent.push(`${download.filename} (слишком большой для отправки)`);
                continue;
            }
            await ctx.replyWithDocument(new InputFile(fs.createReadStream(download.filePath), download.filename));
            sent.push(download.filename);
        } catch (err) {
            devLog('browserAgent: failed to send download', download.filename, err);
        }
    }
    return sent;
}

export async function cancelPausedBrowserSession(sessionId?: string): Promise<void> {
    if (sessionId) {
        const state = pausedBrowserSessions.get(sessionId);
        if (state) await closeBrowserRunState(state, 'cancelled');
        const activeState = [...activeBrowserSessions.values()].find((item) => item.id === sessionId);
        if (activeState) {
            activeState.cancelRequested = true;
            await closeBrowserRunState(activeState, 'cancelled');
        }
        return;
    }

    await Promise.all([
        ...[...pausedBrowserSessions.values()].map((state) => closeBrowserRunState(state, 'cancelled')),
        ...[...activeBrowserSessions.values()].map((state) => {
            state.cancelRequested = true;
            return closeBrowserRunState(state, 'cancelled');
        }),
    ]);
}

export async function cancelBrowserRunForContext(ctx: BotContext): Promise<boolean> {
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id;
    const sessionIds = new Set<string>();
    if (ctx.session.pendingBrowserTask?.sessionId) sessionIds.add(ctx.session.pendingBrowserTask.sessionId);
    if (ctx.session.activeBrowserTask?.sessionId) sessionIds.add(ctx.session.activeBrowserTask.sessionId);

    let cancelled = Boolean(ctx.session.pendingBrowserTask || ctx.session.activeBrowserTask);

    for (const sessionId of sessionIds) {
        const paused = pausedBrowserSessions.get(sessionId);
        if (paused && paused.userId === userId && paused.chatId === chatId) {
            await closeBrowserRunState(paused, 'cancelled').catch(() => {});
            cancelled = true;
        }

        const active = [...activeBrowserSessions.values()].find(
            (item) => item.id === sessionId && item.userId === userId && item.chatId === chatId
        );
        if (active) {
            active.cancelRequested = true;
            active.cancelAcknowledged = true;
            await closeBrowserRunState(active, 'cancelled').catch(() => {});
            cancelled = true;
        }
    }

    const activeForContext = getActiveBrowserSession(ctx);
    if (activeForContext && !sessionIds.has(activeForContext.id)) {
        activeForContext.cancelRequested = true;
        activeForContext.cancelAcknowledged = true;
        await closeBrowserRunState(activeForContext, 'cancelled').catch(() => {});
        cancelled = true;
    }

    ctx.session.pendingBrowserTask = undefined;
    ctx.session.activeBrowserTask = undefined;
    return cancelled;
}

function buildMemoryPrompt(memoryContext?: string): string {
    if (!memoryContext?.trim()) return '(нет релевантного контекста)';
    return limitText(redactSecrets(memoryContext.trim()), 4500);
}

function buildRecentUserContext(messageHistory: MessageHistory[]): string {
    const lines = messageHistory
        .filter((message) => message.role === 'user' && message.content?.trim())
        .slice(-25)
        .map((message) => cleanWhitespace(message.content))
        .filter(Boolean);
    if (!lines.length) return '';
    return limitText(lines.join('\n'), 5000);
}

function recentUserContextBlock(recentUserContext?: string): string {
    return recentUserContext?.trim()
        ? `Недавние сообщения пользователя в этом чате:\n${recentUserContext.trim()}`
        : '';
}

function mergeMemoryContext(existing: string | undefined, addition: string, query: string): string {
    if (!addition.trim()) return existing ?? '';
    const block = [
        existing?.trim() ?? '',
        `\nДополнительный поиск в долговременной памяти по запросу "${query}":\n${addition.trim()}`,
    ].filter(Boolean).join('\n\n');
    return limitText(block, 9000);
}

function normalizeLookupQuery(query: string): string {
    return query.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function lookupBrowserMemory(ctx: BotContext, query: string): Promise<string> {
    const memory = await fetchAgentMemoryContext(ctx, query);
    return buildMemoryContextBlock(memory).trim();
}

function isBookingFormDataQuestionText(text?: string): boolean {
    return /(данн[ыеых]+\s+форм|форм[уы]\s+.*запис|название\s+команд|телефон|email|e-mail|количество\s+участников)/iu.test(text || '');
}

function userAsksWhatDataNeeded(answer: string): boolean {
    return /(что\s+(?:тебе|нужно|надо)|какие\s+данн|чего\s+не\s+хватает|что\s+ввести|what\s+do\s+you\s+need)/iu.test(answer);
}

function userSaysUsePreviouslyProvidedData(answer: string): boolean {
    return /(уже\s+(?:присылал|присылала|кидал|кидала|писал|писала|давал|давала|отправлял|отправляла)|(?:они|данные)\s+у\s+тебя\s+(?:есть|были)|посмотри\s+(?:в\s+)?памят|проверь\s+(?:в\s+)?памят|из\s+памят|возьми\s+из\s+памят|ты\s+должн[ао]?\s+знать)/iu.test(answer);
}

function bookingFormKindFromLabel(rawLabel: string): BookingFormFieldKind | '' {
    const label = rawLabel.toLowerCase();
    if (/(телефон|phone|tel|контакт)/iu.test(label)) return 'phone';
    if (/(email|e-mail|почт|mail)/iu.test(label)) return 'email';
    if (/(количество\s+участников|участник|participants|players|человек)/iu.test(label)) return 'participants';
    if (/(название\s+команд|команд[аы]|team(?:\s+name)?)/iu.test(label)) return 'teamName';
    if (/(имя|фио|фамили|name|full\s+name)/iu.test(label)) return 'name';
    if (/(откуда|source|message_source)/iu.test(label)) return 'source';
    return '';
}

interface BookingFormKnownData {
    name?: string;
    teamName?: string;
    phone?: string;
    email?: string;
    participants?: string;
    source?: string;
}

type BookingFormFieldKind = keyof BookingFormKnownData;

type SemanticFormValueKind =
    | 'name'
    | 'organization_or_team'
    | 'phone'
    | 'email'
    | 'participant_count'
    | 'source'
    | 'date'
    | 'time'
    | 'address'
    | 'comment'
    | 'other';

interface BookingFormFillItem {
    fieldIndex: number;
    kind: BookingFormFieldKind | 'semantic';
    label: string;
    value: string;
    controlType: string;
}

interface SemanticFormValue {
    fieldLabel: string;
    value: string;
    evidence?: string;
    kind?: SemanticFormValueKind;
}

interface SemanticFormExtraction {
    values?: SemanticFormValue[];
    missingFields?: string[];
    confidence?: number;
}

type BookingFormFillResult =
    | { status: 'none'; reason?: string }
    | { status: 'filled'; fields: string[] }
    | { status: 'needs_data'; question: string }
    | { status: 'needs_confirmation'; question: string; choices: BrowserUserChoice[]; snapshot: string }
    | { status: 'failed'; reason: string };

function extractBookingFormKnownData(text: string): BookingFormKnownData {
    const compacted = cleanWhitespace(text);
    const phone = compacted.match(/(?:телефон|phone|tel|контакт)[^+\d]{0,30}(\+?\d[\d\s().-]{7,}\d)/iu)?.[1] ||
        compacted.match(/(\+?\d[\d\s().-]{8,}\d)/u)?.[1];
    const email = compacted.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
    const name = compacted.match(/(?:имя|фио|name|full\s+name)[\s:=\-]+["'«“]?([^"'»”\n.;,]{2,80})/iu)?.[1];
    const source = compacted.match(/(?:откуда\s+(?:вы\s+)?(?:о\s+нас\s+)?узнал[аи]?|источник|source|message_source)[\s:=\-]+["'«“]?([^"'»”\n.;,]{2,80})/iu)?.[1] ||
        compacted.match(/узнал[аи]?\s+(?:о\s+)?сайт[еа]?\s+(?:от|через|у)\s+([^"'»”\n.;,]{2,80})/iu)?.[1];
    const cleanTeamName = (value?: string) =>
        value
            ? cleanWhitespace(value)
                .replace(/^(?:называется|зов[её]тся|called|name\s+is)\s+/iu, '')
                .trim()
            : undefined;
    let teamName = compacted.match(/(?:команд[аы]\s+(?:называется|зов[её]тся|called)|team\s+(?:is|called))\s+["'«“]?([^"'»”\n.;,]{2,80})/iu)?.[1] ||
        compacted.match(/(?:название\s+команд[ыа]|team(?:\s+name)?)[\s:=\-]+["'«“]?([^"'»”\n.;,]{2,80})/iu)?.[1] ||
        compacted.match(/(?:команд[аы]|team)[\s:=\-]+["'«“]?((?!(?:называется|зов[её]тся)\b)[^"'»”\n.;,]{2,80})/iu)?.[1];
    const participants = compacted.match(/(?:количество\s+участников|участников|человек|participants|players)[^\d]{0,20}(\d{1,2})/iu)?.[1] ||
        compacted.match(/(\d{1,2})\s*(?:человек|чел\.?|участник[а-яё]*|participants?|players?)(?![\p{L}\p{N}_])/iu)?.[1];

    if (!teamName && (phone || email || participants)) {
        const candidateSource = text
            .split(/\n+/u)
            .map((line) => cleanWhitespace(line))
            .filter((line) =>
                /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(line) ||
                /\+?\d[\d\s().-]{7,}\d/u.test(line) ||
                /(?:количество\s+участников|участников|человек|participants|players)/iu.test(line) ||
                /(?:название\s+команд[ыа]|команд[аы]|team(?:\s+name)?)/iu.test(line)
            )
            .join('\n') || compacted;
        const stripped = candidateSource
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, ' ')
            .replace(/\+?\d[\d\s().-]{7,}\d/gu, ' ')
            .replace(/(?:имя|фио|name|full\s+name)[\s:=\-]+["'«“]?[^"'»”\n.;,]{2,80}/giu, ' ')
            .replace(/(?<![\p{L}\p{N}_])\d{1,2}\s*(?:человек|чел\.?|участник[а-яё]*|participants?|players?)(?![\p{L}\p{N}_])/giu, ' ');
        teamName = stripped
            .split(/[,\n;]+/u)
            .map((part) => cleanWhitespace(part))
            .map((part) => part.replace(/^(?:нас\s+будет.*?\s+и\s+)?(?:наша|моя)?\s*команд[аы]\s+(?:называется|зов[её]тся)?\s*/iu, '').trim())
            .find((part) =>
                part.length >= 2 &&
                part.length <= 80 &&
                /[a-zа-яё]/iu.test(part) &&
                !/(телефон|phone|email|e-mail|почт|участник|человек|контакт|имя|фио|name|данн[ыеых]+|заявк|форм)/iu.test(part)
            );
    }

    return {
        name: name ? cleanWhitespace(name) : undefined,
        teamName: cleanTeamName(teamName),
        phone: phone ? cleanWhitespace(phone) : undefined,
        email: email ? cleanWhitespace(email) : undefined,
        participants,
        source: source ? cleanWhitespace(source) : undefined,
    };
}

function mergeBookingFormKnownData(sources: string[]): BookingFormKnownData {
    const merged: BookingFormKnownData = {};
    const keys: BookingFormFieldKind[] = ['name', 'teamName', 'phone', 'email', 'participants', 'source'];
    for (const source of sources) {
        if (!source?.trim()) continue;
        const data = extractBookingFormKnownData(source);
        for (const key of keys) {
            if (data[key]) merged[key] = data[key];
        }
    }
    return merged;
}

function skippedBookingFieldKindsFromContext(text: string): Set<BookingFormFieldKind> {
    const skipped = new Set<BookingFormFieldKind>();
    const normalized = normalizeSearchText(text);
    if (/(?:не\s+(?:заполняй|заполнять|вводи|вводить|указывай|указывать)|пропусти|оставь\s+пуст[а-яё]*).{0,100}(?:откуда|source|message_source|сайт)|(?:откуда|source|message_source).{0,100}(?:не\s+(?:заполняй|заполнять|вводи|вводить|указывай|указывать)|пропусти|оставь\s+пуст[а-яё]*)/iu.test(normalized)) {
        skipped.add('source');
    }
    return skipped;
}

function userSkipsBookingField(answer: string, pendingQuestion: string, kind: BookingFormFieldKind): boolean {
    const normalizedAnswer = normalizeSearchText(answer);
    const normalizedQuestion = normalizeSearchText(pendingQuestion);
    const skipIntent = /(?:не\s+(?:заполняй|заполнять|вводи|вводить|указывай|указывать)|пропусти|оставь\s+пуст[а-яё]*)/iu.test(normalizedAnswer);
    if (!skipIntent) return false;
    if (kind === 'source') {
        return /(?:откуда|source|message_source|сайт)/iu.test(normalizedAnswer) ||
            (/(?:это|это\s+поле|его|е[её])/iu.test(normalizedAnswer) && /(?:откуда|source|message_source|сайт)/iu.test(normalizedQuestion));
    }
    return false;
}

function semanticValueBookingKind(item: SemanticFormValue): BookingFormFieldKind | '' {
    if (item.kind === 'name') return 'name';
    if (item.kind === 'organization_or_team') return 'teamName';
    if (item.kind === 'phone') return 'phone';
    if (item.kind === 'email') return 'email';
    if (item.kind === 'participant_count') return 'participants';
    if (item.kind === 'source') return 'source';
    return bookingFormKindFromLabel(item.fieldLabel);
}

function bookingFormMissingFields(data: BookingFormKnownData, observation?: PageObservation, skippedKinds = new Set<BookingFormFieldKind>()): string[] {
    const fields = observation ? bookingFormFieldsFromObservation(observation) : ['название команды', 'телефон', 'email', 'количество участников'];
    const missing: string[] = [];
    const wants = (pattern: RegExp) => fields.some((field) => pattern.test(field));

    if (wants(/имя|name|фио|фамили/iu) && !data.name && !skippedKinds.has('name')) missing.push('имя/ФИО');
    if (wants(/название\s+команд|команд[аы]/iu) && !data.teamName && !skippedKinds.has('teamName')) missing.push('название команды');
    if (wants(/телефон|phone/iu) && !data.phone && !skippedKinds.has('phone')) missing.push('телефон');
    if (wants(/email|e-mail|почт/iu) && !data.email && !skippedKinds.has('email')) missing.push('email');
    if (wants(/количество\s+участников|участник/iu) && !data.participants && !skippedKinds.has('participants')) missing.push('количество участников');
    if (wants(/откуда|source|message_source/iu) && !data.source && !skippedKinds.has('source')) missing.push('откуда узнали о сайте');

    return missing.filter((field, index, arr) => arr.indexOf(field) === index);
}

function bookingFormRequiredKinds(observation?: PageObservation, skippedKinds = new Set<BookingFormFieldKind>()): BookingFormFieldKind[] {
    const fields = observation ? bookingFormFieldsFromObservation(observation) : ['название команды', 'телефон', 'email', 'количество участников'];
    const wants = (pattern: RegExp) => fields.some((field) => pattern.test(field));
    const kinds: BookingFormFieldKind[] = [];

    if (wants(/имя|name|фио|фамили/iu) && !skippedKinds.has('name')) kinds.push('name');
    if (wants(/название\s+команд|команд[аы]/iu) && !skippedKinds.has('teamName')) kinds.push('teamName');
    if (wants(/телефон|phone/iu) && !skippedKinds.has('phone')) kinds.push('phone');
    if (wants(/email|e-mail|почт/iu) && !skippedKinds.has('email')) kinds.push('email');
    if (wants(/количество\s+участников|участник/iu) && !skippedKinds.has('participants')) kinds.push('participants');
    if (wants(/откуда|source|message_source/iu) && !skippedKinds.has('source')) kinds.push('source');

    return kinds.filter((kind, index, arr) => arr.indexOf(kind) === index);
}

function bookingFormKnownDataSummary(data: BookingFormKnownData): string {
    return [
        data.name ? `имя/ФИО: ${data.name}` : '',
        data.teamName ? `название команды: ${data.teamName}` : '',
        data.phone ? `телефон: ${data.phone}` : '',
        data.email ? `email: ${data.email}` : '',
        data.participants ? `количество участников: ${data.participants}` : '',
        data.source ? `откуда узнали: ${data.source}` : '',
    ].filter(Boolean).join(', ');
}

function bookingFormSubset(data: BookingFormKnownData, kinds: BookingFormFieldKind[]): BookingFormKnownData {
    const subset: BookingFormKnownData = {};
    for (const kind of kinds) {
        if (data[kind]) subset[kind] = data[kind];
    }
    return subset;
}

function bookingFormDataSnapshot(data: BookingFormKnownData, kinds?: BookingFormFieldKind[]): string {
    const orderedKinds: BookingFormFieldKind[] = ['name', 'teamName', 'phone', 'email', 'participants', 'source'];
    const allowed = kinds?.length ? new Set(kinds) : null;
    return orderedKinds
        .filter((kind) => (!allowed || allowed.has(kind)) && Boolean(data[kind]))
        .map((kind) => `${kind}=${cleanWhitespace(String(data[kind]))}`)
        .join('|');
}

function memoryBookingDataConfirmationQuestion(data: BookingFormKnownData): string {
    return [
        `Я нашла в памяти данные для формы: ${bookingFormKnownDataSummary(data)}.`,
        'Использовать их для заполнения? Если что-то неверно, нажми «Нет» и пришли правильные данные одним сообщением.',
    ].join(' ');
}

function memoryBookingDataConfirmationChoices(): BrowserUserChoice[] {
    return [
        {
            label: 'Да, использовать данные',
            answer: 'Да, используй найденные в памяти данные формы.',
        },
        {
            label: 'Нет, пришлю другие',
            answer: 'Нет, не используй найденные в памяти данные; я пришлю другие.',
        },
    ];
}

function bookingKnownDataKinds(data: BookingFormKnownData): string {
    return (['name', 'teamName', 'phone', 'email', 'participants', 'source'] as BookingFormFieldKind[])
        .filter((kind) => Boolean(data[kind]))
        .join(',');
}

function bookingKnownDataHasField(data: BookingFormKnownData, fieldLabel: string): boolean {
    const kind = bookingFormKindFromLabel(fieldLabel);
    if (kind) return Boolean(data[kind]);
    return false;
}

function hasVisibleBookingContactFields(observation: PageObservation): boolean {
    return observation.formText
        .split('\n')
        .some((line) => /\[[^\]]+\]/u.test(line) && isPrimaryBookingDataField(line));
}

function bookingDataValue(data: BookingFormKnownData, kind: BookingFormFieldKind): string | undefined {
    return data[kind] ? cleanWhitespace(String(data[kind])) : undefined;
}

function valueAppearsInTrustedSource(source: string, value?: string, evidence?: string): boolean {
    const normalizedValue = cleanWhitespace(value || '');
    if (!normalizedValue) return false;

    const normalizedSource = source.toLowerCase();
    const lowerValue = normalizedValue.toLowerCase();
    if (normalizedSource.includes(lowerValue)) return true;

    const normalizedEvidence = cleanWhitespace(evidence || '');
    if (normalizedEvidence && normalizedSource.includes(normalizedEvidence.toLowerCase())) return true;

    const valueDigits = normalizedValue.replace(/\D+/g, '');
    if (valueDigits.length >= 1) {
        const sourceDigits = source.replace(/\D+/g, '');
        if (valueDigits.length >= 5 && sourceDigits.includes(valueDigits)) return true;
        if (valueDigits.length <= 2 && new RegExp(`(^|\\D)${escapeRegExp(valueDigits)}(\\D|$)`, 'u').test(source)) return true;
    }

    return false;
}

function semanticFormFieldLabels(observation: PageObservation): string[] {
    return bookingFormFieldsFromObservation(observation)
        .map((field) => cleanWhitespace(field))
        .filter((field, index, arr) => field && arr.indexOf(field) === index)
        .slice(0, 12);
}

function filterTrustedSemanticValues(values: SemanticFormValue[] | undefined, trustedSource: string): SemanticFormValue[] {
    return (values || [])
        .map((item) => ({
            ...item,
            fieldLabel: cleanWhitespace(item.fieldLabel || ''),
            value: cleanWhitespace(item.value || ''),
            evidence: cleanWhitespace(item.evidence || ''),
        }))
        .filter((item) => item.fieldLabel && item.value && valueAppearsInTrustedSource(trustedSource, item.value, item.evidence))
        .filter((item, index, arr) =>
            arr.findIndex((other) =>
                normalizeSearchText(other.fieldLabel) === normalizeSearchText(item.fieldLabel) &&
                normalizeSearchText(other.value) === normalizeSearchText(item.value)
            ) === index
        )
        .slice(0, 12);
}

function semanticKnownDataSummary(values: SemanticFormValue[]): string {
    return values
        .map((item) => `${item.fieldLabel}: ${item.value}`)
        .join(', ');
}

async function extractSemanticFormValuesWithLlm(
    fields: string[],
    trustedSource: string,
    task: string
): Promise<SemanticFormExtraction | null> {
    if (!fields.length || !trustedSource.trim()) return null;

    const prompt = [
        'Ты сопоставляешь данные пользователя с видимыми полями формы.',
        'Нужно вернуть только JSON без markdown.',
        'Не извлекай и не придумывай значение, если его нет явно в источнике. Для каждого значения укажи evidence — точный фрагмент источника, на котором основано значение.',
        'Если в источнике есть конфликтующие значения, используй самое новое явное сообщение пользователя, которое находится ближе к началу источника.',
        'fieldLabel должен быть одним из видимых полей, скопированным дословно.',
        'kind выбери из: name, organization_or_team, phone, email, participant_count, source, date, time, address, comment, other.',
        'Если данных для поля нет, добавь fieldLabel в missingFields.',
        '',
        `Задача пользователя:\n${redactSecrets(task).slice(0, 1200)}`,
        '',
        `Видимые поля формы:\n${fields.map((field) => `- ${field}`).join('\n')}`,
        '',
        `Источник доверенных данных:\n${redactSecrets(trustedSource).slice(0, 6000)}`,
        '',
        'Формат:',
        '{"values":[{"fieldLabel":"...","kind":"...","value":"...","evidence":"..."}],"missingFields":["..."],"confidence":0.0}',
    ].join('\n');

    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await createChatCompletionForTask('browserPlanning', {
                max_completion_tokens: 600,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content: 'Верни строгий JSON. Не добавляй пояснения. Не нормализуй значения, кроме удаления лишних пробелов.',
                    },
                    { role: 'user', content: prompt },
                ],
            });
            const parsed = parseLLMJson<SemanticFormExtraction>(response.choices[0]?.message?.content?.trim() || '');
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch (err: any) {
            lastError = err;
            devLog('browserAgent: semantic form extraction failed:', err?.message ?? err);
            if (!isTransientLlmError(err) || attempt === 1) break;
            await sleepMs(450);
        }
    }

    if (lastError) devLog('browserAgent: semantic form extraction unavailable:', safeErrorMessage(lastError));
    return null;
}

interface VisibleAutofillFieldInfo {
    label: string;
    kind: string;
    type: string;
    required: boolean;
    missing: boolean;
    invalid: boolean;
    hasValue: boolean;
}

type GenericFormFillResult =
    | { status: 'none'; reason?: string }
    | { status: 'filled'; fields: string[] }
    | { status: 'failed'; reason: string };

function visibleAutofillFieldsFromObservation(observation: PageObservation): VisibleAutofillFieldInfo[] {
    return observation.formBrainText
        .split('\n')
        .map((line) => {
            const match = line.match(/field#\d+\s+kind=([^\s]+)\s+label="([^"]*)"\s+type=([^\s]+)/u);
            if (!match) return null;
            const flags = line.match(/flags=\[([^\]]+)\]/u)?.[1] || '';
            const value = cleanWhitespace(line.match(/\svalue="([^"]*)"/u)?.[1] || '');
            const label = cleanWhitespace(match[2]).replace(/^\(без label\)$/iu, '');
            if (!label) return null;
            return {
                label,
                kind: cleanWhitespace(match[1]).toLowerCase(),
                type: cleanWhitespace(match[3]).toLowerCase(),
                required: /required/iu.test(flags),
                missing: /missing/iu.test(flags),
                invalid: /invalid/iu.test(flags),
                hasValue: Boolean(value),
            };
        })
        .filter((field): field is VisibleAutofillFieldInfo => Boolean(field))
        .filter((field) => {
            if (field.hasValue && !field.invalid) return false;
            const surface = normalizeSearchText(`${field.kind} ${field.type} ${field.label}`);
            if (/(search|поиск|найти|query|captcha|recaptcha|hcaptcha|otp|2fa|код\s+подтверждения|sms|смс|password|парол|card|cvv|cvc|passport|паспорт|снилс|inn|инн|file|upload)/iu.test(surface)) {
                return false;
            }
            return !['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(field.type);
        })
        .filter((field, index, arr) =>
            arr.findIndex((other) => normalizeSearchText(other.label) === normalizeSearchText(field.label)) === index
        )
        .slice(0, 12);
}

function genericFormAutofillSource(state: BrowserRunState, task: string): string {
    return [
        state.lastUserAnswer,
        task,
        state.recentUserContext,
    ].filter(Boolean).join('\n');
}

function genericFormAutofillSignature(page: Page, fields: VisibleAutofillFieldInfo[], source: string): string {
    const fieldKey = fields
        .map((field) => `${field.kind}:${field.type}:${normalizeSearchText(field.label)}`)
        .join('|');
    return normalizeSearchText(`${safeLogUrl(page.url())}|${fieldKey}|${source.slice(0, 1800)}`).slice(0, 900);
}

function isSafeGenericSemanticFormValue(item: SemanticFormValue, fields: VisibleAutofillFieldInfo[]): boolean {
    const normalizedLabel = normalizeSearchText(item.fieldLabel);
    const field = fields.find((candidate) => normalizeSearchText(candidate.label) === normalizedLabel);
    if (!field) return false;
    const surface = normalizeSearchText(`${field.kind} ${field.type} ${field.label} ${item.kind || ''}`);
    if (/(password|парол|captcha|otp|2fa|sms|смс|card|cvv|cvc|passport|паспорт|снилс|inn|инн|file|upload)/iu.test(surface)) {
        return false;
    }
    return !isLikelyPlaceholderFill(item.value);
}

async function maybeFillVisibleFormFromTrustedData(
    page: Page,
    state: BrowserRunState,
    observation: PageObservation,
    task: string
): Promise<GenericFormFillResult> {
    const fields = visibleAutofillFieldsFromObservation(observation);
    if (!fields.length) return { status: 'none', reason: 'no_empty_safe_fields' };

    const trustedSource = genericFormAutofillSource(state, task);
    if (!trustedSource.trim()) return { status: 'none', reason: 'no_trusted_source' };

    const signature = genericFormAutofillSignature(page, fields, trustedSource);
    if (state.formAutofillAttempts.includes(signature)) {
        return { status: 'none', reason: 'already_attempted' };
    }
    state.formAutofillAttempts.push(signature);
    if (state.formAutofillAttempts.length > 16) {
        state.formAutofillAttempts.splice(0, state.formAutofillAttempts.length - 16);
    }

    const extraction = await extractSemanticFormValuesWithLlm(
        fields.map((field) => field.label),
        trustedSource,
        task
    );
    const values = filterTrustedSemanticValues(extraction?.values, trustedSource)
        .filter((item) => isSafeGenericSemanticFormValue(item, fields));
    if (!values.length) return { status: 'none', reason: 'no_matching_values' };

    const plan = await getSemanticFormFillPlan(page, values);
    const filled: string[] = [];
    for (const item of plan) {
        if (!isSafeGenericSemanticFormValue({ fieldLabel: item.label, value: item.value }, fields)) continue;
        const didFill = await fillBookingFormFieldByIndex(page, item);
        if (didFill) filled.push(item.label || item.kind);
    }

    const uniqueFilled = filled.filter((field, index, arr) => arr.indexOf(field) === index);
    if (!uniqueFilled.length) return { status: 'none', reason: 'fill_plan_empty_or_already_filled' };
    browserLog('generic_form_fill_verified', {
        fields: uniqueFilled.join(', '),
        source: 'trusted_user_context',
    });
    return { status: 'filled', fields: uniqueFilled };
}

async function getSemanticFormFillPlan(page: Page, values: SemanticFormValue[]): Promise<BookingFormFillItem[]> {
    return page.evaluate((rawValues) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
	            const labelFor = (el: Element) => {
	                const input = el as HTMLInputElement;
	                const byLabels = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
	                if (byLabels) return byLabels;
            const ariaLabel = compact(el.getAttribute('aria-label'));
            if (ariaLabel) return ariaLabel;
            const ariaLabelledBy = compact(el.getAttribute('aria-labelledby'));
            if (ariaLabelledBy) {
                const text = ariaLabelledBy
                    .split(/\s+/)
                    .map((ref) => compact(document.getElementById(ref)?.innerText))
                    .filter(Boolean)
                    .join(' ');
                if (text) return text;
            }
            const id = compact(el.getAttribute('id'));
            if (id) {
                const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                const text = compact((label as HTMLElement | null)?.innerText);
                if (text) return text;
            }
            const parentPlaceholder = compact(
                input.parentElement?.querySelector('.placeholder')?.textContent ||
                input.parentElement?.querySelector('label')?.textContent ||
                ''
            );
	                if (parentPlaceholder) return parentPlaceholder;
	                return compact(el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('autocomplete') || el.getAttribute('type') || el.tagName);
	            };
	            const existingFieldValue = (el: Element) => {
	                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
	                const tag = el.tagName.toLowerCase();
	                const selectizeRoot = el.closest('.selectize-control') || el.parentElement?.closest('.selectize-control');
	                const selectizeValue = compact(
	                    selectizeRoot?.querySelector('.selectize-input .item')?.textContent ||
	                    selectizeRoot?.querySelector('[data-value]')?.getAttribute('data-value') ||
	                    ''
	                );
	                if (selectizeValue) return selectizeValue;
	                return compact(
	                    tag === 'select'
	                        ? (input as HTMLSelectElement).selectedOptions?.[0]?.text || (input as HTMLSelectElement).value
	                        : (input as HTMLInputElement | HTMLTextAreaElement).value
	                );
	            };
	            const values = rawValues
	                .map((item) => ({
	                    fieldLabel: compact(item.fieldLabel),
	                    fieldNorm: normalize(item.fieldLabel),
                value: compact(item.value),
            }))
            .filter((item) => item.fieldLabel && item.value);
        const fields = Array.from(document.querySelectorAll('input, textarea, select'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const input = el as HTMLInputElement;
                const tag = el.tagName.toLowerCase();
                const type = tag === 'input' ? input.type.toLowerCase() : tag;
                return !input.disabled &&
                    !input.readOnly &&
                    !['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(type);
            });

        return fields
            .map((el, fieldIndex) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
                const tag = el.tagName.toLowerCase();
	                const controlType = tag === 'input' ? (input as HTMLInputElement).type.toLowerCase() : tag;
	                const label = labelFor(el);
	                const labelNorm = normalize(label);
	                const match = values.find((item) =>
	                    item.fieldNorm === labelNorm ||
	                    labelNorm.includes(item.fieldNorm) ||
	                    item.fieldNorm.includes(labelNorm)
	                );
	                const existingValue = existingFieldValue(el);
	                if (!match || existingValue) return null;
	                return {
	                    fieldIndex,
                    kind: 'semantic',
                    label,
                    value: match.value,
                    controlType,
                };
            })
            .filter(Boolean) as BookingFormFillItem[];
    }, values);
}

function semanticParticipantValue(values: SemanticFormValue[]): string | undefined {
    return values.find((item) =>
        item.kind === 'participant_count' ||
        /(количество\s+участников|участник|participants|players|человек)/iu.test(item.fieldLabel)
    )?.value;
}

async function getBookingFormFillPlan(page: Page, data: BookingFormKnownData): Promise<BookingFormFillItem[]> {
    return page.evaluate((known) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const labelFor = (el: Element) => {
            const input = el as HTMLInputElement;
            const byLabels = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
            if (byLabels) return byLabels;
            const ariaLabel = compact(el.getAttribute('aria-label'));
            if (ariaLabel) return ariaLabel;
            const ariaLabelledBy = compact(el.getAttribute('aria-labelledby'));
            if (ariaLabelledBy) {
                const text = ariaLabelledBy
                    .split(/\s+/)
                    .map((ref) => compact(document.getElementById(ref)?.innerText))
                    .filter(Boolean)
                    .join(' ');
                if (text) return text;
            }
            const id = compact(el.getAttribute('id'));
            if (id) {
                const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                const text = compact((label as HTMLElement | null)?.innerText);
                if (text) return text;
            }
            const parentPlaceholder = compact(
                input.parentElement?.querySelector('.placeholder')?.textContent ||
                input.parentElement?.querySelector('label')?.textContent ||
                ''
            );
            if (parentPlaceholder) return parentPlaceholder;
            return compact(
                el.getAttribute('placeholder') ||
                    el.getAttribute('name') ||
                    el.getAttribute('autocomplete') ||
                    el.getAttribute('type') ||
	                    el.tagName
	                );
	            };
	            const existingFieldValue = (el: Element) => {
	                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
	                const tag = el.tagName.toLowerCase();
	                const selectizeRoot = el.closest('.selectize-control') || el.parentElement?.closest('.selectize-control');
	                const selectizeValue = compact(
	                    selectizeRoot?.querySelector('.selectize-input .item')?.textContent ||
	                    selectizeRoot?.querySelector('[data-value]')?.getAttribute('data-value') ||
	                    ''
	                );
	                if (selectizeValue) return selectizeValue;
	                return compact(
	                    tag === 'select'
	                        ? (input as HTMLSelectElement).selectedOptions?.[0]?.text || (input as HTMLSelectElement).value
	                        : (input as HTMLInputElement | HTMLTextAreaElement).value
	                );
	            };
	            const kindFromLabel = (rawLabel: string): BookingFormFieldKind | '' => {
	                const label = rawLabel.toLowerCase();
	                if (/(телефон|phone|tel|контакт)/iu.test(label)) return 'phone';
            if (/(email|e-mail|почт|mail)/iu.test(label)) return 'email';
            if (/(количество\s+участников|участник|participants|players)/iu.test(label)) return 'participants';
            if (/(название\s+команд|команд[аы]|team(?:\s+name)?)/iu.test(label)) return 'teamName';
            if (/(имя|фио|фамили|name|full\s+name)/iu.test(label)) return 'name';
            if (/(откуда|source|message_source)/iu.test(label)) return 'source';
            return '';
        };
        const valueFor = (kind: BookingFormFieldKind | '') => kind ? compact((known as Record<string, string | undefined>)[kind]) : '';
        const fields = Array.from(document.querySelectorAll('input, textarea, select'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const input = el as HTMLInputElement;
                const tag = el.tagName.toLowerCase();
                const type = tag === 'input' ? input.type.toLowerCase() : tag;
                return !input.disabled &&
                    !input.readOnly &&
                    !['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(type);
            });

        return fields
            .map((el, fieldIndex) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
                const tag = el.tagName.toLowerCase();
	                const controlType = tag === 'input' ? (input as HTMLInputElement).type.toLowerCase() : tag;
	                const label = labelFor(el);
	                const kind = kindFromLabel(label);
	                const value = valueFor(kind);
	                const existingValue = existingFieldValue(el);
	                if (!kind || !value || existingValue) return null;
	                return { fieldIndex, kind, label, value, controlType };
	            })
            .filter(Boolean) as BookingFormFillItem[];
    }, data);
}

function filledValueMatches(current: string, expected: string): boolean {
    const actual = cleanWhitespace(current);
    const wanted = cleanWhitespace(expected);
    if (!wanted) return true;
    if (actual === wanted) return true;
    if (actual && (actual.includes(wanted) || (actual.length >= 3 && wanted.includes(actual)))) return true;

    const actualDigits = actual.replace(/\D+/g, '');
    const wantedDigits = wanted.replace(/\D+/g, '');
    if (wantedDigits.length >= 4 && actualDigits.includes(wantedDigits)) return true;

    return false;
}

async function editableElementValue(element: any): Promise<string> {
    return cleanWhitespace(await element.evaluate((el: Element) => {
        const compact = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, ' ').trim();
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
            const select = el as HTMLSelectElement;
            return compact(select.selectedOptions?.[0]?.text || select.value);
        }
        if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') {
            return compact((el as HTMLElement).innerText || el.textContent);
        }
        return compact((el as HTMLInputElement | HTMLTextAreaElement).value || '');
    }));
}

async function dispatchFormFieldEvents(element: any): Promise<void> {
    await element.evaluate((el: Element) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
}

async function reliableFillElement(page: Page, element: any, value: string): Promise<string> {
    await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

    const verify = async () => {
        await dispatchFormFieldEvents(element);
        const current = await editableElementValue(element);
        if (!filledValueMatches(current, value)) {
            throw new Error(`field value mismatch: expected "${redactSecrets(value).slice(0, 80)}", got "${redactSecrets(current).slice(0, 80)}"`);
        }
        return current;
    };

    try {
        await element.fill(value, { timeout: ACTION_TIMEOUT_MS });
        return await verify();
    } catch (primaryErr) {
        await element.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.type(value, { delay: 20 });
        try {
            return await verify();
        } catch {
            throw primaryErr;
        }
    }
}

async function reliableFillLocator(page: Page, locator: Locator, value: string): Promise<string> {
    return reliableFillElement(page, locator.first(), value);
}

async function reliableSelectElement(element: any, value: string): Promise<string> {
    await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
        await element.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
    } catch {
        await element.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
    }
    await dispatchFormFieldEvents(element);
    const current = await editableElementValue(element);
    if (!filledValueMatches(current, value)) {
        throw new Error(`select value mismatch: expected "${redactSecrets(value).slice(0, 80)}", got "${redactSecrets(current).slice(0, 80)}"`);
    }
    return current;
}

async function fillBookingFormFieldByIndex(page: Page, item: BookingFormFillItem): Promise<boolean> {
    const intendedKind = item.kind === 'semantic'
        ? bookingFormKindFromLabel(item.label)
        : item.kind;

    if (intendedKind === 'teamName') {
        const selectizeResult = await page.evaluate((value) => {
            const compact = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, ' ').trim();
            const teamValue = compact(value);
            if (!teamValue) return { attempted: false, ok: false, value: '' };

            const original = document.querySelector('input[name="team_name"]') as any;
            if (original?.selectize) {
                const selectize = original.selectize;
                const valueField = selectize.settings?.valueField || 'value';
                const labelField = selectize.settings?.labelField || 'text';
                if (!selectize.options?.[teamValue]) {
                    selectize.addOption({ [valueField]: teamValue, [labelField]: teamValue });
                }
                selectize.addItem(teamValue, true);
                selectize.setValue(teamValue, true);
                selectize.updateOriginalInput?.();
                selectize.refreshItems?.();
                selectize.refreshOptions?.(false);
                original.dispatchEvent(new Event('input', { bubbles: true }));
                original.dispatchEvent(new Event('change', { bubbles: true }));
                const currentValue = compact(original.value);
                const visibleText = compact(document.querySelector('.selectize-control .selectize-input')?.textContent);
                return {
                    attempted: true,
                    ok: currentValue === teamValue || visibleText.includes(teamValue),
                    value: currentValue || visibleText,
                };
            }

            return { attempted: false, ok: false, value: '' };
        }, item.value).catch(() => false);

        if (selectizeResult && typeof selectizeResult === 'object' && 'attempted' in selectizeResult && selectizeResult.attempted) {
            if (selectizeResult.ok) return true;
            throw new Error(`team selectize did not accept value; current=${selectizeResult.value || '(empty)'}`);
        }
    }

    const handle = await page.evaluateHandle((fieldIndex) => {
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const fields = Array.from(document.querySelectorAll('input, textarea, select'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const input = el as HTMLInputElement;
                const tag = el.tagName.toLowerCase();
                const type = tag === 'input' ? input.type.toLowerCase() : tag;
                return !input.disabled &&
                    !input.readOnly &&
                    !['hidden', 'password', 'submit', 'button', 'reset', 'checkbox', 'radio', 'file'].includes(type);
            });
        return fields[fieldIndex] || null;
    }, item.fieldIndex);
    const element = handle.asElement();
    if (!element) throw new Error(`field not found: ${item.label}`);

    const tagName = await element.evaluate((el) => el.tagName.toLowerCase());
    if (tagName === 'select') {
        await reliableSelectElement(element, item.value);
    } else {
        await reliableFillElement(page, element, item.value);
    }
    const confirmed = await element.evaluate((el, expected) => {
        const compact = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, ' ').trim();
        const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const tag = el.tagName.toLowerCase();
        const current = compact(
            tag === 'select'
                ? (input as HTMLSelectElement).selectedOptions?.[0]?.text || (input as HTMLSelectElement).value
                : (input as HTMLInputElement | HTMLTextAreaElement).value
        );
        const expectedText = compact(expected);
        if (current === expectedText || (current && (current.includes(expectedText) || (current.length >= 3 && expectedText.includes(current))))) return true;
        const currentDigits = current.replace(/\D+/g, '');
        const expectedDigits = expectedText.replace(/\D+/g, '');
        return expectedDigits.length >= 4 && currentDigits.includes(expectedDigits);
    }, item.value).catch(() => true);
    return confirmed;
}

type ParticipantSelectionResult = 'none' | 'selected' | 'already_selected';

async function maybeSelectParticipantCount(page: Page, participants?: string): Promise<ParticipantSelectionResult> {
    const value = cleanWhitespace(participants || '');
    if (!/^\d{1,2}$/u.test(value)) return 'none';

    return page.evaluate((targetValue) => {
        const compact = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, ' ').trim();
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const contextText = (el: Element) => {
            let node: Element | null = el;
            const parts: string[] = [];
            for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
                parts.push(compact((node as HTMLElement).innerText || node.textContent));
            }
            return parts.join(' ');
        };
        const controlText = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact(
                (el as HTMLElement).innerText ||
                    el.textContent ||
                    input.value ||
                    el.getAttribute('aria-label') ||
                el.getAttribute('title')
            );
        };
        const dispatchRadioEvents = (radio: HTMLInputElement) => {
            radio.dispatchEvent(new Event('input', { bubbles: true }));
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            radio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        };

        const participantContext = (el: Element) =>
            /(количество\s+участников|участник|participants|players)/iu.test(contextText(el)) ||
            /(количество\s+участников|участник|participants|players)/iu.test(compact(document.body.innerText || document.body.textContent));

        const targetRadio = Array.from(document.querySelectorAll('input[type="radio"], input[name="number"]'))
            .find((el) => (el as HTMLInputElement).value === targetValue && participantContext(el)) as HTMLInputElement | undefined;
        if (targetRadio) {
            if (targetRadio.checked) return 'already_selected' as ParticipantSelectionResult;
            const labels = Array.from(document.querySelectorAll('label')).filter(isVisible);
            const label = labels.find((el) =>
                (el.contains(targetRadio) || participantContext(el)) &&
                controlText(el) === targetValue
            );
            if (label) {
                (label as HTMLElement).click();
            } else {
                targetRadio.checked = true;
                dispatchRadioEvents(targetRadio);
            }
            if (!targetRadio.checked) {
                targetRadio.checked = true;
                dispatchRadioEvents(targetRadio);
            }
            return targetRadio.checked ? 'selected' as ParticipantSelectionResult : 'none' as ParticipantSelectionResult;
        }

        const controls = Array.from(document.querySelectorAll('button, [role="button"], label'))
            .filter(isVisible);
        const exactControl = controls.find((el) => {
            const text = controlText(el);
            return text === targetValue && participantContext(el);
        });
        if (!exactControl) return 'none' as ParticipantSelectionResult;
        (exactControl as HTMLElement).click();
        return 'selected' as ParticipantSelectionResult;
    }, value);
}

async function maybeFillBookingFormFromKnownData(
    page: Page,
    state: BrowserRunState,
    observation: PageObservation
): Promise<BookingFormFillResult> {
    if (!hasVisibleBookingContactFields(observation)) {
        return { status: 'none', reason: 'no booking/contact fields visible' };
    }

    const userSource = [
        state.recentUserContext,
        state.lastUserAnswer,
    ].filter(Boolean).join('\n');
    const memoryData = extractBookingFormKnownData(state.memoryContext || '');
    const memorySnapshot = bookingFormDataSnapshot(memoryData);
    const memoryRejected = Boolean(memorySnapshot && state.rejectedBookingMemorySnapshots.includes(memorySnapshot));
    const memorySource = memoryRejected ? '' : (state.memoryContext || '');
    const trustedSource = [
        state.lastUserAnswer,
        memorySource,
        state.recentUserContext,
    ].filter(Boolean).join('\n');
    const userData = mergeBookingFormKnownData([
        state.recentUserContext || '',
        state.lastUserAnswer || '',
    ]);
    const knownData = mergeBookingFormKnownData([
        memorySource,
        state.recentUserContext || '',
        state.lastUserAnswer || '',
    ]);
    const skippedKinds = skippedBookingFieldKindsFromContext(trustedSource);
    for (const kind of skippedKinds) {
        delete knownData[kind];
    }
    const requiredKinds = bookingFormRequiredKinds(observation, skippedKinds);
    const memoryOnlyKinds = requiredKinds
        .filter((kind) => Boolean(knownData[kind]) && Boolean(memoryData[kind]) && !userData[kind]);
    const memoryOnlySnapshot = bookingFormDataSnapshot(memoryData, memoryOnlyKinds);
    if (
        memoryOnlyKinds.length &&
        memoryOnlySnapshot &&
        state.confirmedBookingMemorySnapshot !== memorySnapshot &&
        !state.rejectedBookingMemorySnapshots.includes(memorySnapshot)
    ) {
        const memoryOnlyData = bookingFormSubset(memoryData, memoryOnlyKinds);
        state.pendingBookingMemorySnapshot = memorySnapshot;
        browserLog('booking_form_memory_confirmation_needed', {
            fields: bookingKnownDataKinds(memoryOnlyData),
            snapshot: memoryOnlySnapshot,
        });
        return {
            status: 'needs_confirmation',
            question: memoryBookingDataConfirmationQuestion(memoryOnlyData),
            choices: memoryBookingDataConfirmationChoices(),
            snapshot: memorySnapshot,
        };
    }
    const visibleFields = semanticFormFieldLabels(observation);
    const semanticExtraction = await extractSemanticFormValuesWithLlm(visibleFields, trustedSource, state.originalTask);
    const semanticValues = filterTrustedSemanticValues(semanticExtraction?.values, trustedSource)
        .filter((item) => {
            const kind = semanticValueBookingKind(item);
            return !kind || !skippedKinds.has(kind);
        });
    const semanticMissing = (semanticExtraction?.missingFields || [])
        .map((field) => cleanWhitespace(field))
        .filter(Boolean)
        .filter((field) => {
            const kind = bookingFormKindFromLabel(field);
            return !kind || !skippedKinds.has(kind);
        })
        .filter((field, index, arr) => arr.indexOf(field) === index)
        .slice(0, 8);

	    if (semanticExtraction) {
	        const plan = await getSemanticFormFillPlan(page, semanticValues);
	        const filled: string[] = [];

	        for (const item of plan) {
	            const didFill = await fillBookingFormFieldByIndex(page, item);
	            if (didFill) filled.push(item.label || item.kind);
	        }

	        const participantValue = bookingDataValue(knownData, 'participants') || semanticParticipantValue(semanticValues);
	        const selectedParticipants = await maybeSelectParticipantCount(page, participantValue).catch(() => 'none' as ParticipantSelectionResult);
	        browserLog('booking_form_participants_result', {
	            hasParticipantValue: Boolean(participantValue),
	            result: selectedParticipants,
	        });
	        if (selectedParticipants === 'selected') filled.push('количество участников');

	        if (filled.length) {
	            browserLog('booking_form_fill_verified', {
	                fields: filled.filter((field, index, arr) => arr.indexOf(field) === index).join(', '),
	                knownKinds: bookingKnownDataKinds(knownData),
	            });
	            return { status: 'filled', fields: filled.filter((field, index, arr) => arr.indexOf(field) === index) };
	        }

        const unresolvedSemanticMissing = semanticMissing.filter((field) => !bookingKnownDataHasField(knownData, field));
        if (unresolvedSemanticMissing.length) {
            const found = semanticKnownDataSummary(semanticValues);
            const question = found
                ? `Вижу часть данных формы (${found}), но не хватает: ${unresolvedSemanticMissing.join(', ')}. Пришли недостающие значения одним сообщением.`
                : `Для заявки нужны данные формы: ${unresolvedSemanticMissing.join(', ')}. Пришли их одним сообщением. Я не буду подставлять значения из догадок.`;
            return { status: 'needs_data', question };
        }
    }

    const missing = bookingFormMissingFields(knownData, observation, skippedKinds);
    if (missing.length) {
        const found = bookingFormKnownDataSummary(knownData);
        const question = found
            ? `Вижу часть данных формы (${found}), но не хватает: ${missing.join(', ')}. Пришли недостающие значения одним сообщением.`
            : bookingFormDataQuestion(observation);
        return { status: 'needs_data', question };
    }

	    const plan = await getBookingFormFillPlan(page, knownData);
	    const filled: string[] = [];

	    for (const item of plan) {
	        const didFill = await fillBookingFormFieldByIndex(page, item);
	        if (didFill) filled.push(item.label || item.kind);
	    }

	    const participantValue = bookingDataValue(knownData, 'participants');
	    const selectedParticipants = await maybeSelectParticipantCount(page, participantValue).catch(() => 'none' as ParticipantSelectionResult);
	    browserLog('booking_form_participants_result', {
	        hasParticipantValue: Boolean(participantValue),
	        result: selectedParticipants,
	    });
	    if (selectedParticipants === 'selected') filled.push('количество участников');

	    if (!filled.length) return { status: 'none', reason: 'known values already appear filled or fields are custom controls' };
	    browserLog('booking_form_fill_verified', {
	        fields: filled.filter((field, index, arr) => arr.indexOf(field) === index).join(', '),
	        knownKinds: bookingKnownDataKinds(knownData),
	    });
	    return { status: 'filled', fields: filled.filter((field, index, arr) => arr.indexOf(field) === index) };
}

async function lookupBookingFormMemory(ctx: BotContext, state: BrowserRunState, task: string): Promise<string> {
    const queries = uniqueStrings([
        `${task} данные формы телефон email название команды количество участников откуда узнали`,
        'мои контактные данные телефон email для заявки',
        'данные для записи или заявки название команды организации телефон email количество участников источник',
        'название команды или организации для записи',
    ]).slice(0, 4);

    let merged = state.memoryContext || '';
    const blocks = await Promise.all(queries.map(async (query) => {
        const block = await lookupBrowserMemory(ctx, query).catch((err) => {
            devLog('browserAgent: booking form memory lookup failed:', err);
            return '';
        });
        return { query, block };
    }));

    for (const { query, block } of blocks) {
        if (block) merged = mergeMemoryContext(merged, block, query);
    }

    return merged;
}

function buildBrowserMemoryQueries(task: string): string[] {
    const queries: string[] = [];
    const normalizedTask = cleanWhitespace(task).slice(0, 300);
    if (normalizedTask) queries.push(normalizedTask);

    for (const domain of extractDomainsFromText(task)) {
        queries.push(`${domain} логин пароль аккаунт профиль`);
        queries.push(`${domain} адрес телефон предпочтения данные для формы`);
    }

    if (/(адрес|достав|самовывоз|город|улиц|дом|квартир)/i.test(task)) {
        queries.push('мой адрес телефон город данные доставки');
    }
    if (/(врач|клиник|запис|при[её]м|услуг|салон|брон|билет|отель|ресторан)/i.test(task)) {
        queries.push('предпочтения для записи бронирования имя телефон дата рождения');
    }

    const seen = new Set<string>();
    return queries.filter((query) => {
        const normalized = normalizeLookupQuery(query);
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
    }).slice(0, 5);
}

function parseBrowserActionJson(text: string): BrowserAction | null {
    const parsed = parseLLMJson<Partial<BrowserAction>>(text);
    const action = normalizeBrowserActionKind(parsed?.action);
    if (!parsed || !action) return null;
    return { ...parsed, action } as BrowserAction;
}

function normalizeBrowserActionKind(raw: unknown): BrowserActionKind | null {
    const normalized = cleanWhitespace(String(raw ?? ''))
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!normalized) return null;
    if (VALID_BROWSER_ACTIONS.has(normalized)) return normalized as BrowserActionKind;
    return BROWSER_ACTION_ALIASES[normalized] ?? null;
}

async function repairBrowserActionJson(text: string): Promise<BrowserAction | null> {
    const source = text.trim();
    if (!source) return null;

    try {
        const response = await createChatCompletionForTask('browserPlanning', {
            max_completion_tokens: 260,
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content:
                        'Преобразуй ответ браузерного агента в один JSON-объект BrowserAction. ' +
                        `action должен быть одним из: ${Array.from(VALID_BROWSER_ACTIONS).join(', ')}. ` +
                        'Верни только JSON без markdown. Если действие неясно, верни {"action":"ask_user","summary":"Нужно уточнить следующий шаг."}.',
                },
                { role: 'user', content: redactSecrets(source).slice(0, 3000) },
            ],
        });
        return parseBrowserActionJson(response.choices[0]?.message?.content?.trim() ?? '');
    } catch (err) {
        devLog('browserAgent: failed to repair LLM response:', err);
        return null;
    }
}

async function enrichBrowserMemoryContext(
    ctx: BotContext,
    task: string,
    initialContext?: string
): Promise<string | undefined> {
    let context = initialContext?.trim() || '';
    const queries = buildBrowserMemoryQueries(task);

    const blocks = await Promise.all(queries.map(async (query) => {
        const block = await lookupBrowserMemory(ctx, query).catch((err) => {
            devLog('browserAgent: preflight memory lookup failed:', err);
            return '';
        });
        return { query, block };
    }));

    for (const { query, block } of blocks) {
        if (block) {
            context = mergeMemoryContext(context, block, query);
        }
    }

    return context.trim() || undefined;
}

function normalizeStringArray(value: unknown, limit = 8): string[] {
    return Array.isArray(value)
        ? value
            .map((item) => cleanWhitespace(String(item ?? '')))
            .filter(Boolean)
            .slice(0, limit)
        : [];
}

function heuristicTaskContract(task: string): BrowserTaskContract {
    const cleanTask = cleanWhitespace(task).slice(0, 500);
    const evidenceDriven = isEvidenceDrivenSelectionTask(task);
    const searchTerms = cleanTask
        .split(/[^a-zа-яё0-9#№]+/iu)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .filter((token, index, arr) => arr.findIndex((other) => normalizeSearchText(other) === normalizeSearchText(token)) === index)
        .slice(0, 12);
    return {
        goal: cleanTask || 'Выполнить браузерную задачу пользователя.',
        objectiveType: evidenceDriven ? 'evidence_driven_selection' : 'browser_workflow',
        domain: isShoppingBrowseTask(task) ? 'catalog_or_shopping' : 'general_web',
        inferredMeaning: [],
        hardCriteria: evidenceDriven ? ['Покрыть явные критерии пользователя', 'Подтвердить результат фактами со страницы'] : ['Получить видимое подтверждение результата'],
        softPreferences: [],
        negativeCriteria: [],
        searchQueries: cleanTask ? [cleanTask] : [],
        searchTerms,
        evidenceNeeded: evidenceDriven ? ['названия/варианты', 'ключевые свойства', 'источник или ссылка', 'причина соответствия'] : ['видимое подтверждение или результат действия'],
        verificationSteps: evidenceDriven
            ? ['извлечь критерии', 'найти несколько кандидатов', 'проверить свойства', 'отбросить несоответствия', 'вернуть доказанный итог']
            : ['проверить видимое подтверждение выполнения'],
        successDefinition: evidenceDriven
            ? 'Итог содержит конкретные проверенные варианты или вывод, покрывающий критерии пользователя.'
            : 'Цель пользователя достигнута и подтверждена на странице.',
        unknowns: [],
        confidence: 0.45,
    };
}

function normalizeTaskContract(raw: unknown, task: string): BrowserTaskContract {
    const fallback = heuristicTaskContract(task);
    if (!raw || typeof raw !== 'object') return fallback;
    const source = raw as Record<string, unknown>;
    return {
        goal: cleanWhitespace(String(source.goal ?? fallback.goal)).slice(0, 500) || fallback.goal,
        objectiveType: cleanWhitespace(String(source.objectiveType ?? fallback.objectiveType)).slice(0, 80) || fallback.objectiveType,
        domain: cleanWhitespace(String(source.domain ?? fallback.domain)).slice(0, 80) || fallback.domain,
        inferredMeaning: normalizeStringArray(source.inferredMeaning, 10),
        hardCriteria: normalizeStringArray(source.hardCriteria, 12),
        softPreferences: normalizeStringArray(source.softPreferences, 10),
        negativeCriteria: normalizeStringArray(source.negativeCriteria, 10),
        searchQueries: normalizeStringArray(source.searchQueries, 8),
        searchTerms: normalizeStringArray(source.searchTerms, 16),
        evidenceNeeded: normalizeStringArray(source.evidenceNeeded, 10),
        verificationSteps: normalizeStringArray(source.verificationSteps, 10),
        successDefinition: cleanWhitespace(String(source.successDefinition ?? fallback.successDefinition)).slice(0, 700) || fallback.successDefinition,
        unknowns: normalizeStringArray(source.unknowns, 8),
        confidence: Math.max(0, Math.min(1, Number(source.confidence ?? fallback.confidence))),
    };
}

function taskContractSummary(contract?: BrowserTaskContract): string {
    if (!contract) return '(task contract ещё не построен)';
    const lines = [
        `goal=${contract.goal}`,
        `type=${contract.objectiveType}; domain=${contract.domain}; confidence=${contract.confidence.toFixed(2)}`,
        contract.inferredMeaning.length ? `inferredMeaning=${contract.inferredMeaning.join(' | ')}` : '',
        contract.hardCriteria.length ? `hardCriteria=${contract.hardCriteria.join(' | ')}` : '',
        contract.softPreferences.length ? `softPreferences=${contract.softPreferences.join(' | ')}` : '',
        contract.negativeCriteria.length ? `negativeCriteria=${contract.negativeCriteria.join(' | ')}` : '',
        contract.searchQueries.length ? `searchQueries=${contract.searchQueries.join(' | ')}` : '',
        contract.searchTerms.length ? `searchTerms=${contract.searchTerms.join(', ')}` : '',
        contract.evidenceNeeded.length ? `evidenceNeeded=${contract.evidenceNeeded.join(' | ')}` : '',
        contract.verificationSteps.length ? `verificationSteps=${contract.verificationSteps.join(' -> ')}` : '',
        `successDefinition=${contract.successDefinition}`,
        contract.unknowns.length ? `unknowns=${contract.unknowns.join(' | ')}` : '',
    ].filter(Boolean);
    return limitText(lines.join('\n'), 2800);
}

async function inferTaskContractWithLlm(
    task: string,
    memoryContext?: string,
    recentUserContext?: string
): Promise<BrowserTaskContract> {
    const prompt = [
        'Ты preflight task understanding layer для браузерного агента.',
        'Преобразуй запрос пользователя в операционный контракт, по которому агент сможет пользоваться сайтом как человек.',
        'Особенно важно раскрывать неявные смысловые формулировки в наблюдаемые признаки. Например: стиль, уют, надёжность, семейный формат, премиальность, бюджетность, лёгкость, совместимость, "похоже на ..." должны стать проверяемыми критериями, поисковыми словами и анти-признаками.',
        'Не выдумывай конкретные товары/места/факты. Можно делать разумные доменные выводы о том, какие признаки стоит искать и чем проверять.',
        'Если критерий субъективный, разложи его на observable traits и укажи, что итог должен объяснить соответствие.',
        'Верни строгий JSON без markdown.',
        '',
        `Задача пользователя:\n${redactSecrets(task).slice(0, 2200)}`,
        '',
        `Контекст памяти:\n${buildMemoryPrompt(memoryContext).slice(0, 1800)}`,
        '',
        `Недавний пользовательский контекст:\n${redactSecrets(recentUserContext || '').slice(0, 1200)}`,
        '',
        'Формат:',
        '{"goal":"...","objectiveType":"navigate|fill_form|book|buy|evidence_driven_selection|research|download|other","domain":"...","inferredMeaning":["..."],"hardCriteria":["..."],"softPreferences":["..."],"negativeCriteria":["..."],"searchQueries":["..."],"searchTerms":["..."],"evidenceNeeded":["..."],"verificationSteps":["..."],"successDefinition":"...","unknowns":["..."],"confidence":0.0}',
    ].join('\n');

    try {
        const response = await createChatCompletionForTask('browserVision', {
            max_tokens: 720,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Верни только JSON. Делай критерии практичными для браузерного поиска и проверки результата.' },
                { role: 'user', content: prompt },
            ],
        });
        return normalizeTaskContract(parseLLMJson<unknown>(response.choices[0]?.message?.content?.trim() || ''), task);
    } catch (err) {
        browserLog('task_contract_error', { reason: safeErrorMessage(err) });
        return heuristicTaskContract(task);
    }
}

async function maybeUpdateTaskContract(
    state: BrowserRunState,
    task: string,
    memoryContext?: string,
    recentUserContext?: string
): Promise<void> {
    const source = normalizeSearchText([task, memoryContext || '', recentUserContext || ''].join('\n')).slice(0, 4000);
    if (state.taskContract && state.taskContractSource === source) return;
    const contract = await inferTaskContractWithLlm(task, memoryContext, recentUserContext);
    state.taskContract = contract;
    state.taskContractSource = source;
    browserLog('task_contract', {
        type: contract.objectiveType,
        domain: contract.domain,
        confidence: contract.confidence,
        hardCriteria: contract.hardCriteria.join(' | ').slice(0, 240),
        inferred: contract.inferredMeaning.join(' | ').slice(0, 240),
    });
    const note = `Task contract: ${contract.goal}; criteria=${contract.hardCriteria.join(' | ')}; evidence=${contract.evidenceNeeded.join(' | ')}`.slice(0, 900);
    state.notes.push(note);
    if (state.notes.length > 30) state.notes.splice(0, state.notes.length - 30);
}

function normalizeLedger(raw: unknown, previous?: BrowserTaskLedger): BrowserTaskLedger | undefined {
    if (!raw || typeof raw !== 'object') return previous;
    const source = raw as Record<string, unknown>;
    const formData = source.formData && typeof source.formData === 'object'
        ? Object.fromEntries(
            Object.entries(source.formData as Record<string, unknown>)
                .map(([key, value]) => [cleanWhitespace(key), cleanWhitespace(String(value ?? ''))])
                .filter(([key, value]) => key && value)
                .slice(0, 12)
        )
        : previous?.formData;

    return {
        goal: cleanWhitespace(String(source.goal ?? previous?.goal ?? '')) || undefined,
        target: cleanWhitespace(String(source.target ?? previous?.target ?? '')) || undefined,
        date: cleanWhitespace(String(source.date ?? previous?.date ?? '')) || undefined,
        formData,
        filled: normalizeStringArray(source.filled ?? previous?.filled),
        pending: normalizeStringArray(source.pending ?? previous?.pending),
        confirmations: normalizeStringArray(source.confirmations ?? previous?.confirmations),
        lastEvidence: normalizeStringArray(source.lastEvidence ?? previous?.lastEvidence, 6),
    };
}

function normalizeTaskPlan(raw: unknown, previous?: BrowserTaskPlanStep[]): BrowserTaskPlanStep[] | undefined {
    const source = Array.isArray(raw) ? raw : previous;
    if (!Array.isArray(source)) return previous;
    const allowed = new Set(['pending', 'in_progress', 'done', 'blocked']);
    const steps: BrowserTaskPlanStep[] = [];
    source
        .map((item, index) => {
            const record = typeof item === 'object' && item ? item as Record<string, unknown> : {};
            const label = cleanWhitespace(String(record.label ?? record.title ?? record.step ?? ''));
            if (!label) return null;
            const rawStatus = cleanWhitespace(String(record.status ?? 'pending')).toLowerCase();
            const step: BrowserTaskPlanStep = {
                id: cleanWhitespace(String(record.id ?? `step_${index + 1}`)).slice(0, 60) || `step_${index + 1}`,
                label: label.slice(0, 180),
                status: allowed.has(rawStatus) ? rawStatus as BrowserTaskPlanStep['status'] : 'pending',
                evidence: cleanWhitespace(String(record.evidence ?? '')).slice(0, 240) || undefined,
            };
            return step;
        })
        .forEach((step) => {
            if (step) steps.push(step);
        });
    return steps.slice(0, 12);
}

function normalizePageUnderstanding(raw: unknown, previousLedger?: BrowserTaskLedger, previousPlan?: BrowserTaskPlanStep[]): PageUnderstanding | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const phaseRaw = cleanWhitespace(String(source.phase ?? 'unknown')).toLowerCase();
    const allowedPhases: BrowserPagePhase[] = [
        'unknown',
        'listing',
        'detail_page',
        'booking_form',
        'confirmation_modal',
        'success',
        'validation_error',
        'blocked',
        'stuck',
    ];
    const phase = allowedPhases.includes(phaseRaw as BrowserPagePhase)
        ? phaseRaw as BrowserPagePhase
        : 'unknown';
    const confidence = Math.max(0, Math.min(1, Number(source.confidence ?? 0)));
    const understanding: PageUnderstanding = {
        phase,
        whatIsHappening: cleanWhitespace(String(source.whatIsHappening ?? source.summary ?? '')) || 'Состояние страницы не распознано.',
        blockingElement: cleanWhitespace(String(source.blockingElement ?? '')) || undefined,
        primaryVisibleAction: cleanWhitespace(String(source.primaryVisibleAction ?? '')) || undefined,
        successEvidence: source.successEvidence == null ? null : cleanWhitespace(String(source.successEvidence)) || null,
        missingData: normalizeStringArray(source.missingData),
        nextExpectedPhase: cleanWhitespace(String(source.nextExpectedPhase ?? '')) || undefined,
        confidence,
        evidence: normalizeStringArray(source.evidence, 8),
        ledger: normalizeLedger(source.ledger, previousLedger),
        taskPlan: normalizeTaskPlan(source.taskPlan, previousPlan),
    };
    return understanding;
}

function pageUnderstandingSummary(understanding?: PageUnderstanding): string {
    if (!understanding) return '(нет отдельной классификации состояния страницы)';
    const parts = [
        `phase=${understanding.phase}`,
        `confidence=${understanding.confidence.toFixed(2)}`,
        `state=${understanding.whatIsHappening}`,
        understanding.blockingElement ? `blocking=${understanding.blockingElement}` : '',
        understanding.primaryVisibleAction ? `primaryAction=${understanding.primaryVisibleAction}` : '',
        understanding.successEvidence ? `success=${understanding.successEvidence}` : '',
        understanding.missingData?.length ? `missing=${understanding.missingData.join(', ')}` : '',
        understanding.nextExpectedPhase ? `next=${understanding.nextExpectedPhase}` : '',
        understanding.evidence?.length ? `evidence=${understanding.evidence.join(' | ')}` : '',
    ].filter(Boolean);
    return parts.join('\n');
}

function taskLedgerSummary(ledger?: BrowserTaskLedger): string {
    if (!ledger) return '(ledger процесса пуст)';
    const formData = ledger.formData
        ? Object.entries(ledger.formData).map(([key, value]) => `${key}: ${value}`).join(', ')
        : '';
    return [
        ledger.goal ? `goal=${ledger.goal}` : '',
        ledger.target ? `target=${ledger.target}` : '',
        ledger.date ? `date=${ledger.date}` : '',
        formData ? `formData=${formData}` : '',
        ledger.filled?.length ? `filled=${ledger.filled.join(', ')}` : '',
        ledger.pending?.length ? `pending=${ledger.pending.join(', ')}` : '',
        ledger.confirmations?.length ? `confirmations=${ledger.confirmations.join(', ')}` : '',
        ledger.lastEvidence?.length ? `evidence=${ledger.lastEvidence.join(' | ')}` : '',
    ].filter(Boolean).join('\n') || '(ledger процесса пуст)';
}

function taskPlanSummary(plan?: BrowserTaskPlanStep[]): string {
    if (!plan?.length) return '(план процесса пуст)';
    return plan
        .map((step, index) => {
            const evidence = step.evidence ? ` — ${step.evidence}` : '';
            return `${index + 1}. [${step.status}] ${step.label}${evidence}`;
        })
        .join('\n');
}

function actionOutcomeSummary(outcome?: ActionOutcomeUnderstanding): string {
    if (!outcome) return '(нет проверки результата последнего действия)';
    return [
        `changed=${outcome.changed}`,
        `progress=${outcome.progress}`,
        `sameLoopRisk=${outcome.sameLoopRisk}`,
        outcome.nextExpectedPhase ? `next=${outcome.nextExpectedPhase}` : '',
        `confidence=${outcome.confidence.toFixed(2)}`,
        outcome.evidence?.length ? `evidence=${outcome.evidence.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
}

function maybeInjectBrowserLoopCheckpoint(
    state: BrowserRunState,
    observation: PageObservation,
    url: string,
    iteration: number
): void {
    if (iteration < 6) return;

    const recent = state.history.slice(-6);
    if (recent.length < 4) return;

    const labelCounts = new Map<string, number>();
    for (const record of recent) {
        labelCounts.set(record.label, (labelCounts.get(record.label) ?? 0) + 1);
    }

    const maxRepeatedLabel = Math.max(0, ...labelCounts.values());
    const sameUrlCount = recent.filter((record) => urlsEquivalent(record.url, url)).length;
    const failedCount = recent.filter((record) => record.result === 'failed').length;
    const noVisibleProgress = state.lastActionOutcome?.sameLoopRisk ||
        /no_visible_change|unknown|stuck|blocked/iu.test(state.lastActionOutcome?.progress ?? '');
    const phaseLooksStuck = state.pageUnderstanding?.phase === 'stuck' || state.pageUnderstanding?.phase === 'blocked';
    const scheduledReview = iteration % 6 === 0 && sameUrlCount >= 4;

    const signals = [
        maxRepeatedLabel >= 2 ? `повторяется действие "${[...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''}"` : '',
        failedCount >= 2 ? `${failedCount} недавних неудачных действия` : '',
        noVisibleProgress ? `последний outcome: ${state.lastActionOutcome?.progress ?? 'sameLoopRisk'}` : '',
        phaseLooksStuck ? `phase=${state.pageUnderstanding?.phase}` : '',
        scheduledReview ? 'плановый checkpoint на той же странице' : '',
        observation.blockerSignals ? `видимые блокеры: ${cleanWhitespace(observation.blockerSignals).slice(0, 160)}` : '',
    ].filter(Boolean);

    if (!signals.length) return;

    const dominantLabel = [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed';
    const signature = `${Math.floor(iteration / 6)}:${comparableUrl(url)}:${dominantLabel}:${signals.slice(0, 3).join('|')}`;
    if (state.loopCheckpointSignatures.includes(signature)) return;

    state.loopCheckpointSignatures.push(signature);
    if (state.loopCheckpointSignatures.length > 12) {
        state.loopCheckpointSignatures.splice(0, state.loopCheckpointSignatures.length - 12);
    }

    const note = [
        `Loop checkpoint ${iteration}: ${signals.join('; ')}.`,
        'Перед следующим действием явно смени стратегию: другой selector/visual map, find_on_page/site_search, scroll к новому блоку, go_back, memory_lookup или ask_user, если недостаёт внешних данных.',
    ].join(' ');
    state.notes.push(note.slice(0, 800));
    if (state.notes.length > 36) {
        state.notes.splice(0, state.notes.length - 36);
    }
    browserLog('loop_checkpoint', {
        iter: iteration,
        url: safeLogUrl(url),
        signals: signals.join(' | ').slice(0, 260),
    });
}

function shouldRunPageUnderstanding(state: BrowserRunState, observation: PageObservation, url: string, iteration: number): boolean {
    if (!observation.screenshotB64 || url === 'about:blank') return false;
    const sinceLast = iteration - state.lastUnderstandingIteration;
    if (url !== state.lastUnderstandingUrl) return true;
    if (sinceLast >= 4) return true;
    if (sinceLast >= 2 && observation.modalText) return true;
    if (sinceLast >= 2 && isBookingOrLeadFormSurface(observation)) return true;
    if (sinceLast >= 2 && state.history.slice(-3).some((record) => record.result === 'failed')) return true;
    if (sinceLast >= 3 && observation.blockerSignals) return true;
    return false;
}

async function understandPageStateWithLlm(
    task: string,
    observation: PageObservation,
    history: ActionRecord[],
    previousLedger?: BrowserTaskLedger,
    previousPlan?: BrowserTaskPlanStep[],
    sitePatternsText?: string,
    taskContractText?: string
): Promise<PageUnderstanding | null> {
    const recentHistory = history
        .slice(-8)
        .map((record) => `[${record.result}] ${record.label}: ${record.comment || record.error || '-'}`)
        .join('\n') || '(нет)';
    const prompt = [
        'Ты классификатор состояния браузерной задачи. Не выбирай действие, только определи фазу процесса и обнови ledger.',
        'Верни строгий JSON без markdown.',
        'phase выбери из: unknown, listing, detail_page, booking_form, confirmation_modal, success, validation_error, blocked, stuck.',
        'Если видна модалка/попап с вопросом и кнопками, phase=confirmation_modal, даже если исходная карточка/товар не рядом.',
        'Если форма отправлена и видно подтверждение/успешная бронь/заявка принята, phase=success и successEvidence заполни видимым доказательством.',
        'Для задач подбора/поиска товаров каталог, категория, брендовая страница или фраза "visible products" НЕ являются success. phase=success только если уже есть итоговая подборка конкретных товаров; если пользователь просит сайт/ссылки/заказ, в доказательстве должны быть прямые URL карточек товаров.',
        'Для задач подбора/сравнения/выбора success только если есть конкретные варианты под роли и критерии пользователя, доказанные свойства и причина выбора. Первые видимые карточки/строки без проверки не success.',
        'Для товарного подбора без явной просьбы купить/оформить корзина и checkout не являются обязательными pending-шагами; pending должен быть про find/select/report_links.',
        'Если видны ошибки обязательных полей/валидации, phase=validation_error и missingData заполни конкретными полями.',
        'ledger.pending должен отражать следующие оставшиеся шаги процесса, например submit, site_confirmation_modal, wait_for_success.',
        'taskPlan верни как стабильный чеклист процесса: шаги open/find/open_form/fill/confirm_submit/handle_site_modal/verify_success или доменно подходящие аналоги. Сохраняй уже выполненные шаги done.',
        '',
        `Задача пользователя:\n${redactSecrets(task).slice(0, 1800)}`,
        '',
        `Task contract:\n${redactSecrets(taskContractText || '(task contract ещё не построен)').slice(0, 2200)}`,
        '',
        `Предыдущий ledger:\n${taskLedgerSummary(previousLedger)}`,
        '',
        `Предыдущий план:\n${taskPlanSummary(previousPlan)}`,
        '',
        `Известные паттерны этого домена:\n${sitePatternsText || '(нет доменного паттерна)'}`,
        '',
        `История действий:\n${redactSecrets(recentHistory).slice(0, 1800)}`,
        '',
        `Scroll diagnostics:\n${redactSecrets(observation.scrollDiagnosticsText || '').slice(0, 900)}`,
        '',
        `Filter/facet map:\n${redactSecrets(observation.filterControlsText || '').slice(0, 1800)}`,
        '',
        `Модалки:\n${redactSecrets(observation.modalText || '').slice(0, 1600)}`,
        '',
        `Формы:\n${redactSecrets(observation.formText || '').slice(0, 1800)}`,
        '',
        `Form brain:\n${redactSecrets(observation.formBrainText || '').slice(0, 1800)}`,
        '',
        `Структура:\n${redactSecrets(observation.structureText || '').slice(0, 2200)}`,
        '',
        `Semantic page map:\n${redactSecrets(observation.semanticMapText || '').slice(0, 2200)}`,
        '',
        `Structured data/meta:\n${redactSecrets(observation.structuredDataText || '').slice(0, 1800)}`,
        '',
        `Товарные карточки и прямые ссылки:\n${redactSecrets(observation.productCardsText || '').slice(0, 2600)}`,
        '',
        `Таблицы и гриды:\n${redactSecrets(observation.tableText || '').slice(0, 2400)}`,
        '',
        `Affordance graph:\n${redactSecrets(observation.affordanceGraphText || '').slice(0, 2600)}`,
        '',
        `Visual/code map:\n${redactSecrets(observation.visualMapText || '').slice(0, 1800)}`,
        '',
        `Вкладки:\n${redactSecrets(observation.tabsText || '').slice(0, 1200)}`,
        '',
        `Видимый текст:\n${redactSecrets(observation.pageText || '').slice(0, 2200)}`,
        '',
        `Сигналы:\n${redactSecrets(observation.blockerSignals || '').slice(0, 800)}`,
        '',
        'Формат:',
        '{"phase":"booking_form","whatIsHappening":"...","blockingElement":"modal|form|none","primaryVisibleAction":"...","successEvidence":null,"missingData":[],"nextExpectedPhase":"...","confidence":0.0,"evidence":["..."],"ledger":{"goal":"...","target":"...","date":"...","formData":{"team":"..."},"filled":["..."],"pending":["..."],"confirmations":["..."],"lastEvidence":["..."]},"taskPlan":[{"id":"open","label":"Открыть сайт","status":"done","evidence":"..."},{"id":"handle_site_modal","label":"Ответить на модалку сайта","status":"in_progress","evidence":"..."}]}',
    ].join('\n');

    try {
        const response = await createChatCompletionForTask('browserVision', {
            max_tokens: 600,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Верни только JSON. Не предлагай action. Не выдумывай значения формы, которых нет в тексте или на скриншоте.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${observation.screenshotB64}`,
                                detail: 'high',
                            },
                        },
                    ],
                },
            ],
        });
        const parsed = parseLLMJson<unknown>(response.choices[0]?.message?.content?.trim() || '');
        return normalizePageUnderstanding(parsed, previousLedger, previousPlan);
    } catch (err) {
        browserLog('page_understanding_error', { reason: safeErrorMessage(err) });
        return null;
    }
}

async function maybeUpdatePageUnderstanding(
    state: BrowserRunState,
    task: string,
    observation: PageObservation,
    url: string,
    iteration: number,
    sitePatternsText?: string
): Promise<void> {
    if (!shouldRunPageUnderstanding(state, observation, url, iteration)) return;
    const understanding = await understandPageStateWithLlm(
        task,
        observation,
        state.history,
        state.taskLedger,
        state.taskPlan,
        sitePatternsText,
        taskContractSummary(state.taskContract)
    );
    if (!understanding) return;
    state.pageUnderstanding = understanding;
    state.taskLedger = understanding.ledger || state.taskLedger;
    state.taskPlan = understanding.taskPlan || state.taskPlan;
    state.lastUnderstandingUrl = url;
    state.lastUnderstandingIteration = iteration;
    browserLog('page_understanding', {
        phase: understanding.phase,
        confidence: understanding.confidence,
        state: understanding.whatIsHappening.slice(0, 220),
        primary: understanding.primaryVisibleAction,
        pending: understanding.ledger?.pending?.join(', '),
        plan: understanding.taskPlan?.map((step) => `${step.id}:${step.status}`).join(', '),
    });
}

function shouldVerifyActionOutcome(decision: BrowserAction, result: ActionRecord['result']): boolean {
    if (result !== 'ok') return false;
    if (decision.action !== 'click' && decision.action !== 'press_key') return false;
    const text = [decision.selector, decision.value, decision.comment, decision.summary].filter(Boolean).join(' ');
    return /(отправ|заявк|брон|подтверд|да|нет|ok|submit|send|confirm|book|reserve|register|continue|next|success|готов)/iu.test(text);
}

function isGenericClickLabel(label: string): boolean {
    const normalized = normalizeSearchText(label);
    return /^(да|нет|ok|ок|yes|no|далее|продолжить|отправить|подтвердить|выбрать|submit|send|confirm|continue|next)$/iu.test(normalized);
}

function shouldCritiqueDecision(
    decision: BrowserAction,
    state: BrowserRunState,
    observation: PageObservation,
    repeatedCount: number
): boolean {
    if (decision.action !== 'click' && decision.action !== 'navigate' && decision.action !== 'press_key') return false;
    if (state.lastActionOutcome?.sameLoopRisk) return true;
    if (repeatedCount > 0) return true;
    if (state.pageUnderstanding?.phase === 'confirmation_modal' || state.pageUnderstanding?.phase === 'validation_error') return true;
    if (decision.action === 'navigate' && isBookingOrLeadFormSurface(observation)) return true;
    if (decision.action === 'click') {
        const label = clickLabelFromDecision(decision);
        if (isGenericClickLabel(label)) return true;
        if (isHighImpactAction(decision)) return true;
    }
    return false;
}

function normalizeDecisionCriticResult(raw: unknown): DecisionCriticResult | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const verdictRaw = cleanWhitespace(String(source.verdict ?? 'allow')).toLowerCase();
    const verdict: DecisionCriticVerdict =
        verdictRaw === 'block' || verdictRaw === 'ask_user' ? verdictRaw : 'allow';
    const riskRaw = cleanWhitespace(String(source.risk ?? 'low')).toLowerCase();
    const risk: DecisionCriticResult['risk'] =
        riskRaw === 'high' || riskRaw === 'medium' ? riskRaw : 'low';
    return {
        verdict,
        risk,
        confidence: Math.max(0, Math.min(1, Number(source.confidence ?? 0))),
        reason: cleanWhitespace(String(source.reason ?? '')) || 'critic без пояснения',
        question: cleanWhitespace(String(source.question ?? '')) || undefined,
    };
}

async function critiqueDecisionWithLlm(
    task: string,
    decision: BrowserAction,
    observation: PageObservation,
    state: BrowserRunState
): Promise<DecisionCriticResult | null> {
    const prompt = [
        'Ты decision critic для браузерного агента. Проверь, стоит ли выполнять предложенное действие.',
        'Не выбирай новое действие. Верни JSON с verdict: allow, block или ask_user.',
        'allow — действие логично и безопасно в текущей фазе.',
        'block — действие выглядит неверным/цикличным/оторванным от текущего контекста; агент должен выбрать другую стратегию.',
        'ask_user — данных или безопасного подтверждения явно не хватает.',
        'Если phase=confirmation_modal и действие кликает кнопку внутри видимой модалки, обычно allow, даже если рядом нет исходной карточки.',
        'Если действие повторяет no_visible_change/sameLoopRisk, block.',
        '',
        `Задача:\n${redactSecrets(task).slice(0, 1400)}`,
        '',
        `Task contract:\n${taskContractSummary(state.taskContract)}`,
        '',
        `Действие:\n${redactSecrets(JSON.stringify(sanitizeDecisionForLog(decision))).slice(0, 900)}`,
        '',
        `Понимание страницы:\n${pageUnderstandingSummary(state.pageUnderstanding)}`,
        '',
        `Ledger:\n${taskLedgerSummary(state.taskLedger)}`,
        '',
        `План:\n${taskPlanSummary(state.taskPlan)}`,
        '',
        `Последний outcome:\n${actionOutcomeSummary(state.lastActionOutcome)}`,
        '',
        `Scroll diagnostics:\n${redactSecrets(observation.scrollDiagnosticsText || '').slice(0, 900)}`,
        '',
        `Filter/facet map:\n${redactSecrets(observation.filterControlsText || '').slice(0, 1800)}`,
        '',
        `Evidence stash:\n${evidenceStashSummary(state, 8)}`,
        '',
        `Network observer:\n${networkSnippetsSummary(state, 4)}`,
        '',
        `Semantic page map:\n${redactSecrets(observation.semanticMapText || '').slice(0, 1800)}`,
        '',
        `Structured data/meta:\n${redactSecrets(observation.structuredDataText || '').slice(0, 1400)}`,
        '',
        `Form brain:\n${redactSecrets(observation.formBrainText || '').slice(0, 1400)}`,
        '',
        `Affordance graph:\n${redactSecrets(observation.affordanceGraphText || '').slice(0, 2200)}`,
        '',
        `Таблицы и гриды:\n${redactSecrets(observation.tableText || '').slice(0, 1800)}`,
        '',
        `Visual/code map:\n${redactSecrets(observation.visualMapText || '').slice(0, 1800)}`,
        '',
        `Вкладки:\n${redactSecrets(observation.tabsText || '').slice(0, 1200)}`,
        '',
        `Модалки:\n${redactSecrets(observation.modalText || '').slice(0, 1400)}`,
        '',
        'Формат: {"verdict":"allow|block|ask_user","risk":"low|medium|high","confidence":0.0,"reason":"...","question":"..."}',
    ].join('\n');

    try {
        const response = await createChatCompletionForTask('browserVision', {
            max_tokens: 320,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Верни только JSON. Будь строгим к циклам и неверному контексту, но не блокируй очевидные кнопки текущей модалки.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${observation.screenshotB64}`,
                                detail: 'high',
                            },
                        },
                    ],
                },
            ],
        });
        return normalizeDecisionCriticResult(parseLLMJson<unknown>(response.choices[0]?.message?.content?.trim() || ''));
    } catch (err) {
        browserLog('decision_critic_error', { reason: safeErrorMessage(err) });
        return null;
    }
}

async function verifyActionOutcomeWithLlm(
    task: string,
    decision: BrowserAction,
    before: PageObservation,
    after: PageObservation,
    previousUnderstanding?: PageUnderstanding
): Promise<ActionOutcomeUnderstanding | null> {
    const prompt = [
        'Ты проверяешь результат последнего браузерного действия. Верни только JSON.',
        'Оцени, изменилась ли страница смыслово, какой прогресс произошёл, есть ли риск повторить тот же шаг.',
        'Если появился popup/modal, progress должен это явно сказать. Если виден успех/подтверждение, укажи это.',
        'Для задач подбора товаров переход на страницу бренда/категории или видимость карточек — это listing/browse progress, НЕ success. success только если уже собраны конкретные выбранные товары и нужные ссылки.',
        'Для подбора/сравнения success только если уже выбраны все требуемые роли/варианты из задачи и есть доказательства по критериям пользователя; иначе это browse/filter/research progress.',
        '',
        `Задача:\n${redactSecrets(task).slice(0, 1400)}`,
        '',
        `Действие:\n${redactSecrets(actionSignature(decision)).slice(0, 500)}\ncomment=${redactSecrets(decision.comment || '').slice(0, 500)}`,
        '',
        `Предыдущее понимание:\n${pageUnderstandingSummary(previousUnderstanding)}`,
        '',
        `Before modal/form/products/data/text:\n${redactSecrets([before.modalText, before.formText, before.formBrainText, before.productCardsText, before.structuredDataText, before.pageText].filter(Boolean).join('\n')).slice(0, 2800)}`,
        '',
        `After modal/form/products/data/text:\n${redactSecrets([after.modalText, after.formText, after.formBrainText, after.productCardsText, after.structuredDataText, after.pageText].filter(Boolean).join('\n')).slice(0, 3000)}`,
        '',
        'Формат: {"changed":true,"progress":"modal_opened|form_submitted|success|validation_error|no_visible_change|...","sameLoopRisk":false,"nextExpectedPhase":"...","evidence":["..."],"confidence":0.0}',
    ].join('\n');

    try {
        const response = await createChatCompletionForTask('browserVision', {
            max_tokens: 360,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Верни строгий JSON. Не выбирай следующее действие.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${after.screenshotB64}`,
                                detail: 'high',
                            },
                        },
                    ],
                },
            ],
        });
        const parsed = parseLLMJson<Record<string, unknown>>(response.choices[0]?.message?.content?.trim() || '');
        if (!parsed) return null;
        return {
            changed: Boolean(parsed.changed),
            progress: cleanWhitespace(String(parsed.progress ?? 'unknown')),
            sameLoopRisk: Boolean(parsed.sameLoopRisk),
            nextExpectedPhase: cleanWhitespace(String(parsed.nextExpectedPhase ?? '')) || undefined,
            evidence: normalizeStringArray(parsed.evidence, 6),
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
        };
    } catch (err) {
        browserLog('action_outcome_error', { reason: safeErrorMessage(err) });
        return null;
    }
}

function normalizeCompletionReviewResult(raw: unknown): CompletionReviewResult | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    return {
        complete: Boolean(source.complete),
        confidence: Math.max(0, Math.min(1, Number(source.confidence ?? 0))),
        reason: cleanWhitespace(String(source.reason ?? '')) || 'completion review без пояснения',
        missingCriteria: normalizeStringArray(source.missingCriteria, 8),
        unsupportedClaims: normalizeStringArray(source.unsupportedClaims, 8),
        nextStep: cleanWhitespace(String(source.nextStep ?? '')) || undefined,
    };
}

function completionReviewBlockReason(review: CompletionReviewResult | null): string | null {
    if (!review || review.complete || review.confidence < 0.55) return null;
    const missing = review.missingCriteria.length ? ` Не хватает: ${review.missingCriteria.join('; ')}.` : '';
    const unsupported = review.unsupportedClaims.length ? ` Неподтверждённые утверждения: ${review.unsupportedClaims.join('; ')}.` : '';
    const next = review.nextStep ? ` Следующий шаг: ${review.nextStep}.` : '';
    return `${review.reason}${missing}${unsupported}${next}`.slice(0, 900);
}

async function reviewTaskCompletionWithLlm(
    task: string,
    summary: string,
    observation: PageObservation,
    state: BrowserRunState
): Promise<CompletionReviewResult | null> {
    const recentHistory = state.history
        .slice(-10)
        .map((record) => `[${record.result}] ${record.label}: ${record.comment || record.error || '-'}`)
        .join('\n') || '(нет)';
    const prompt = [
        'Ты universal completion critic для браузерного агента.',
        'Задача: определить, можно ли завершать работу по исходному запросу пользователя.',
        'Не выбирай действие для браузера. Проверь только полноту и доказанность результата.',
        'Извлеки критерии пользователя из задачи и Task contract. Считай результат complete=true только если summary и evidence покрывают hardCriteria, inferredMeaning и successDefinition.',
        'Если пользователь просил подобрать/найти/сравнить/выбрать варианты, навигация к списку результатов, первые видимые карточки или общий статус страницы НЕ являются complete.',
        'Если summary утверждает свойство варианта (цвет, цена, дата, адрес, наличие, материал, рейтинг, соответствие стилю, совместимость, ссылка), это свойство должно быть подтверждено evidence, DOM, структурированными данными, сетевым ответом или видимым текстом.',
        'Не требуй лишнего: если задача простая и есть видимое подтверждение/файл/форма отправлена, complete=true.',
        'Верни строгий JSON без markdown.',
        '',
        `Исходная задача:\n${redactSecrets(task).slice(0, 1800)}`,
        '',
        `Task contract:\n${taskContractSummary(state.taskContract)}`,
        '',
        `Предлагаемый итог:\n${redactSecrets(summary).slice(0, 1600)}`,
        '',
        `Рубрика выполнения:\n${taskExecutionRubricForPrompt(task).slice(0, 1800)}`,
        '',
        `Exploration coverage:\n${explorationSummaryForPrompt(state, observation).slice(0, 1200)}`,
        '',
        `Evidence stash:\n${evidenceStashSummary(state, 12)}`,
        '',
        `Network observer:\n${networkSnippetsSummary(state, 6)}`,
        '',
        `История действий:\n${redactSecrets(recentHistory).slice(0, 1600)}`,
        '',
        `Scroll diagnostics:\n${redactSecrets(observation.scrollDiagnosticsText || '').slice(0, 900)}`,
        '',
        `Filter/facet map:\n${redactSecrets(observation.filterControlsText || '').slice(0, 1800)}`,
        '',
        `Рабочие заметки:\n${redactSecrets(state.notes.slice(-10).join('\n')).slice(0, 1600)}`,
        '',
        `Structured data/meta:\n${redactSecrets(observation.structuredDataText || '').slice(0, 1800)}`,
        '',
        `Товарные карточки/варианты:\n${redactSecrets(observation.productCardsText || '').slice(0, 2200)}`,
        '',
        `Таблицы/гриды:\n${redactSecrets(observation.tableText || '').slice(0, 1600)}`,
        '',
        `Видимый текст:\n${redactSecrets(observation.pageText || '').slice(0, 2200)}`,
        '',
        `Сигналы:\n${redactSecrets(observation.blockerSignals || '').slice(0, 800)}`,
        '',
        'Формат:',
        '{"complete":false,"confidence":0.0,"reason":"...","missingCriteria":["..."],"unsupportedClaims":["..."],"nextStep":"..."}',
    ].join('\n');

    try {
        const response = await createChatCompletionForTask('browserVision', {
            max_tokens: 520,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Верни только JSON. Будь строгим к непроверенным подборам, но не блокируй реальные подтверждения выполненных форм/скачанных файлов.' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${observation.screenshotB64}`,
                                detail: 'high',
                            },
                        },
                    ],
                },
            ],
        });
        return normalizeCompletionReviewResult(parseLLMJson<unknown>(response.choices[0]?.message?.content?.trim() || ''));
    } catch (err) {
        browserLog('completion_review_error', { reason: safeErrorMessage(err) });
        return null;
    }
}

// ─── LLM-решение ─────────────────────────────────────────────────────────────

async function askNextAction(
    task: string,
    url: string,
    title: string,
    observation: PageObservation,
    history: ActionRecord[],
    notes: string[],
    credentialHint: string,
    memoryContext?: string,
    pageUnderstanding?: PageUnderstanding,
    taskLedger?: BrowserTaskLedger,
    taskPlan?: BrowserTaskPlanStep[],
    lastActionOutcome?: ActionOutcomeUnderstanding,
    sitePatternsText?: string,
    state?: BrowserRunState
): Promise<BrowserAction> {
    const historyText = history.length
        ? history
              .slice(-12)
              .map((h) => `  ${compactActionRecord(h)}`)
              .join('\n')
        : '  (нет предыдущих действий)';
    const trajectoryText = browserActionTrajectorySummary(history);
    const loopDiagnosticsText = browserLoopDiagnosticsSummary(history, lastActionOutcome);
    const notesText = notes.length
        ? notes.slice(-12).map((note, index) => `  ${index + 1}. ${note}`).join('\n')
        : '  (нет рабочих заметок)';
    const recentFailures = history.filter((h) => h.result === 'failed').slice(-3);
    const recoveryText = recentFailures.length
        ? recentFailures.map((h) => `  - ${h.label}: ${h.error || h.comment || 'ошибка без текста'}`).join('\n')
        : '  (нет недавних ошибок)';
    const evidenceText = evidenceStashSummary(state, 10);
    const networkText = networkSnippetsSummary(state, 6);
    const taskContractText = taskContractSummary(state?.taskContract);
    const taskRubricText = taskExecutionRubricForPrompt(task);
    const explorationText = explorationSummaryForPrompt(state, observation);
    const nowText = new Date().toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });

    const systemPrompt = `Ты промышленный браузерный агент: выполняешь задачу пользователя в Playwright аккуратно, устойчиво и без выдумывания данных.

Доступные действия:
- navigate        — перейти по URL (value = полный URL с https://)
- click           — кликнуть (selector = один из candidate selectors или точный видимый текст)
- fill            — заполнить поле обычным текстом (selector, value)
- fill_credential — заполнить поле сохранённым login/password (selector, value = "login" или "password")
- type            — напечатать текст в активном элементе (value)
- press_key       — нажать клавишу (value = Enter | Tab | Escape | ArrowDown | ArrowUp | Space | Backspace)
- select_option   — выбрать значение в <select> (selector, value = текст видимой опции или value)
- check/uncheck   — изменить чекбокс/радио (selector)
- hover           — навести курсор (selector)
- scroll          — прокрутить страницу (value = "down" или "up")
- find_on_page    — найти текст/подсказку/кодовый признак на текущей странице и прокрутить к лучшему совпадению (value = что искать)
- site_search     — воспользоваться поиском текущего сайта/каталога/документации (value = поисковый запрос)
- select_date     — выбрать дату в календаре/datepicker (value = дата как просит пользователь; selector необязателен)
- switch_tab      — переключиться на вкладку (value = "last" | "next" | "previous" | номер | часть title/url)
- close_tab       — закрыть вкладку (value = "current" | "last" | номер | часть title/url)
- dismiss_overlays — закрыть/принять cookie, consent, newsletter, notification и другие мешающие overlay
- save_page_pdf   — сохранить текущую страницу PDF-файлом для отправки пользователю (value = желаемое имя, необязательно)
- save_screenshot — сохранить текущий экран JPG-файлом для отправки пользователю (value = желаемое имя, необязательно)
- wait            — подождать конкретное UI-состояние: selector=..., text=..., textGone=..., url=..., loadState=domcontentloaded|load|networkidle, timeMs=...
- go_back         — вернуться назад
- memory_lookup   — поискать недостающий факт в долговременной памяти (value = точный поисковый запрос)
- note            — сохранить краткую рабочую заметку внутри текущей сессии (summary = факт/решение; без действий на странице)
- ask_user        — остановиться и спросить пользователя, если данных нет или нужен безопасный ручной шаг
- done            — задача выполнена (summary = что сделано)
- fail            — задача невыполнима (summary = причина)

Правила качества:
0. Если задача начинается с about:blank и пользователь не дал конкретный URL, сначала открой поисковик или наиболее вероятный официальный сайт по задаче. Не жди URL от пользователя, если его можно найти обычным поиском.
0a. Если задача содержит "Последняя страница" или контекст предыдущей браузерной задачи, продолжай с этой страницы и выбирай вариант там. Не придумывай новый домен по названию мероприятия, игры, товара или места.
0b. Перед действиями опирайся на Task contract: hardCriteria, inferredMeaning, negativeCriteria, searchQueries/searchTerms, evidenceNeeded и successDefinition. Если критерий субъективный ("итальянский стиль", "премиально", "уютно", "лёгкий вариант", "подходит друг к другу"), используй inferredMeaning как наблюдаемые признаки и проверяй их фактами, а не своим первым впечатлением.
0c. Сохраняй область задачи: пол/аудитория, город, дата, категория, ценовой диапазон, цвет, размер и другие hardCriteria. Если видимая страница, заголовок, URL или выбранный раздел противоречат hardCriteria (например, нужен мужской раздел, а открыт женский), сначала исправь область через переключатель, поиск или фильтр. Не выбирай результаты из неправильной области.
1. Сначала используй "Candidate selectors"; копируй selector ровно как указан после стрелки "->".
   Если selector вида ref=e1 из Accessibility tree, предпочитай его: это Playwright ARIA-ref из текущего snapshot.
   Если Candidate selectors даёт domref=k1, это стабильная DOM-ссылка из текущего candidate snapshot.
   Не используй номер строки вида "#1" как selector. Если нужен именно номер элемента, используй index=1.
   Если selector начинается с "frame=N >>", используй его целиком — это действие внутри iframe/виджета.
   Если есть одинаковые кнопки/ссылки, выбирай по context=... или href=..., а не только по названию кнопки.
1v. Если целевой элемент легче распознать визуально (иконка, картинка, аватар, крестик, корзина, поиск, календарь, без текста), используй "Visual/code map": selector вида visual=3 или один из alt selector после "alt:".
    Сопоставляй то, что видишь на скриншоте, с bbox/center/visual/context/code-hints. Не спрашивай пользователя, где находится картинка или кнопка, если она видна на странице.
1a. Для сложных интерфейсов с карточками, строками таблиц, списками и модалками сначала найди нужный объект по тексту из задачи, затем нажимай кнопку/ссылку внутри этого же ближайшего блока. Если нужный блок не виден, прокрути страницу и повтори поиск. Не спрашивай пользователя выбирать среди одинаковых кнопок, когда целевой текст уже есть на странице, в DOM или в context.
1b. В каталогах товаров "#6 link/menuitem ..." — это описание строки, а не selector. Для выбора товара не кликай верхнее меню ("Новинки", "Одежда", "Скидки") и не используй index=N, пока не проверил, что target text/href действительно относится к товарной карточке. Если видны только категории/меню, прокрути до товарных карточек или используй ссылку товара из structure/affordance graph.
1c. Если сайт открыл новую вкладку или результат находится в другой вкладке, используй switch_tab по номеру/title/url из блока "Вкладки". Закрывай лишнюю вкладку close_tab только если она явно мешает или это пустой/рекламный popup.
1d. Используй Semantic page map для общей ориентации: где навигация, основная область, поиск, форма, диалог, повторяющиеся секции. Для данных о сущностях, ценах, датах и канонических ссылках проверяй Structured data/meta.
	2. Используй долговременную память для адресов, предпочтений, имён, сохранённых параметров и известных учётных данных.
	3. Если нужного факта нет в текущем контексте памяти, сначала используй memory_lookup с конкретным запросом. Если память не дала ответа или дала неполные данные — ask_user в контексте текущей формы/страницы, без ухода в общий диалог о сохранении фактов.
	3a. Если данные для формы взяты из памяти, можно попросить пользователя подтвердить, что найденные значения актуальны, особенно перед отправкой заявки.
	4. Для пароля/login используй fill_credential, если credentialHint говорит что данные доступны.
5. Captcha, SMS/2FA/OTP, банковские карты, документы, платёж, юридическое согласие и необратимые действия требуют ask_user, если пользователь явно не дал все нужные данные.
5a. Не выдумывай значения для форм: телефон, email, имя, название команды/организации, количество участников, комментарии и контактные данные можно вводить только из сообщения пользователя, долговременной памяти или сохранённых учётных данных. Если данных нет — ask_user до fill и до отправки формы.
5b. Для форм сначала смотри Form brain: kind, required/missing/invalid, selectors, options. Заполняй только поля, для которых есть данные; select_option используй для реальных options.
6. Если страница просит финальное подтверждение покупки/оплаты/бронирования с деньгами или штрафом — ask_user, даже если задача в целом понятна.
7. done разрешён только когда на странице явно видно, что цель достигнута: подтверждение, созданная запись, отправленная форма, скачанный файл или другая проверяемая фиксация результата.
7a. Для задач "подбери/найди/выбери/сравни/порекомендуй" цель достигнута только когда результат покрывает все явные критерии пользователя и содержит проверяемые доказательства: названия, свойства, цены/даты/адреса/ссылки/причины выбора — что применимо к домену задачи.
7b. Страница категории, поиска, списка или факт видимых результатов сами по себе не являются выполненной задачей. Не возвращай done со словами "перешла", "видны варианты", "открыт каталог", "successfully navigated". Сначала отфильтруй, сравни и выбери конкретные подходящие варианты.
7c. Не бери первые видимые варианты без проверки условий. Для любой задачи подбора сначала извлеки критерии из запроса, затем пользуйся сайтом как человек: фильтры, поиск, сортировка, открытие карточек/деталей, сравнение нескольких кандидатов, проверка несовпадений.
7d. done по подбору/исследованию должен перечислять выбранные варианты и по каждому указывать: что это, ключевые свойства из критериев, источник/URL, и почему вариант подходит. Если есть критерий, но нет доказательства, продолжай работу на сайте.
7e. done — это пользовательский ответ, а не debug dump. Не вставляй сырые строки Evidence stash, product#N, image=, href=, sku=, source_rec_type, JSON/API-поля и обрезанные URL. Переформулируй доказательства нормальным языком: название, цена/дата/статус, короткая причина и чистая ссылка.
8. Используй note, когда нашёл важный факт на странице или в памяти: выбранный слот, адрес, цену, ограничение, причину ошибки.
9. Если действие уже повторялось и не помогает — смени стратегию: другой selector, scroll/wait, go_back, memory_lookup или ask_user/fail.
9a. На длинной странице не делай много scroll подряд вслепую. Если известен текст, название карточки, кнопки, фильтра, поля, иконки или кодовый признак из задачи — используй find_on_page, затем уже click/fill по обновлённой visual/code map.
9a2. Не используй wait как слепую паузу, если можно ждать конкретное состояние: text=..., selector=..., url=... или textGone=... . После wait обязательно заново оцени страницу по snapshot.
9b. Если цель нужно найти внутри текущего сайта, каталога, базы знаний или админки, используй site_search с коротким запросом вместо угадывания меню и ручной прокрутки.
9b2. Если Filter/facet map показывает релевантные фильтры/сортировки, используй их до выбора результата, когда критерии пользователя можно сузить фильтром. Если Scroll diagnostics говорит canScrollDown=true и результат ещё не доказан, прокрути или найди следующий блок вместо преждевременного done.
9c. Если cookie/consent/newsletter/notification overlay закрывает интерфейс, используй dismiss_overlays. Не спрашивай пользователя про такие технические баннеры, если действие безопасно.
9d. Если пользователь просит прислать страницу, доказательство, квитанцию, отчёт, документ или скриншот, используй save_page_pdf или save_screenshot, затем done. Файлы будут отправлены автоматически при завершении.
9e. Для календарей и выбора даты используй select_date, если дата известна из задачи/памяти/ответа пользователя. Не кликай случайный день по номеру, если месяц/год не совпадают с видимым календарём.
9f. Если Network observer уже содержит полезный JSON/API-ответ с результатами, ценами, статусом, ошибкой или ссылками, используй эти факты в note/done и не повторяй визуальную прокрутку ради тех же данных.
9g. Если Runtime-сигналы или рабочие заметки говорят, что системное окно browser dialog confirm/prompt было отклонено для безопасности, не повторяй вызвавшее его действие без явного разрешения пользователя. Если разрешение уже есть, повтори ровно действие, которое вызвало dialog.
10. ask_user формулируй как один конкретный вопрос: какой именно факт/код/выбор нужен и почему его нельзя взять из памяти. Если на странице есть явный выбор кнопками (например "Да"/"Нет"), добавь поле choices: [{"label":"понятная кнопка для пользователя","answer":"что именно нажать/ввести"}].
10a. Если всё же нужно спросить про одинаковые кнопки, варианты должны различаться контекстом блока/строки/карточки. Не предлагай пользователю несколько одинаковых "Выбрать: Записаться" без названия объекта рядом.
10b. Не спрашивай пользователя, какой UI-блок, DOM-элемент, карточку, ссылку, меню или кнопку нажать, если это можно решить просмотром страницы. Это внутренняя работа браузерного агента: выбери сам по скриншоту/DOM/context, прокрути, открой более общий раздел, вернись назад или смени стратегию. ask_user разрешён только для внешних данных пользователя, captcha/OTP/auth, безопасностного подтверждения или субъективного выбора, который невозможно вывести из задачи.
10c. Для информационных задач про списки, расписания, каталоги, события, слоты, товары или услуги не спрашивай "что нажать дальше", если уже видны карточки/строки. Извлеки видимые элементы из Structure/Table/Product/Affordance, проверь дату/цену/название/место/ссылку по критериям пользователя, прокручивай список при необходимости и возвращай done с нормальным списком.
11. Если пользователь просит только найти варианты игр/мероприятий/квизов/билетов, собери ближайшие варианты с датами, местами и ссылками, затем done с предложением выбрать вариант для записи. Не начинай регистрацию, пока пользователь явно не попросил записать/зарегистрировать.
12. Перед каждым click проверь цепочку: цель пользователя -> нужный объект/блок на странице -> действие внутри этого блока. Если можешь назвать только текст кнопки, но не можешь связать её с нужным объектом, не возвращай click: используй scroll, go_back, memory_lookup, note или ask_user.
12a. Если нейро-классификатор ниже говорит phase=confirmation_modal, текущая модалка/попап является локальным контекстом задачи. Для кнопок этой модалки не требуй, чтобы рядом снова был исходный объект/карточка из задачи.
12b. Если phase=success и есть successEvidence, возвращай done с кратким подтверждением результата, не продолжай кликать. Для товарного подбора это правило действует только если successEvidence содержит выбранные товары и нужные ссылки, а не просто страницу каталога/бренда.
12c. Если lastActionOutcome.sameLoopRisk=true или progress=no_visible_change, не повторяй то же действие: выбери другую стратегию или ask_user.
12d. Evidence stash — это проверенные факты, найденные во время задачи. В итоговом done опирайся на них; если доказательств достижения цели нет, сначала найди/получи их.
12e. Если Loop diagnostics показывает repeated_actions, repeated_outcomes или ping-pong-паттерн, не выбирай следующий шаг из этого цикла. Выбери новый тип действия или заверши по уже доказанным данным.
13. Отвечай ТОЛЬКО JSON, без markdown-блоков.`;

    const userContent = `Задача пользователя:
${redactSecrets(task)}

Текущая дата и время: ${nowText} (Europe/Moscow)
Осталось итераций в текущем пакете: ${Math.max(0, MAX_ITERATIONS - (state?.iterationCount ?? history.length))}

Task contract: операционное понимание задачи, критерии, поисковые формулировки и проверка результата:
${taskContractText}

Текущая страница:
URL: ${url || 'about:blank'}
Заголовок: ${title || '(нет)'}
Состояние: ${observation.pageState || '(нет данных)'}
Сигналы блокеров/рисков:
${observation.blockerSignals || '(нет явных)'}

Scroll diagnostics:
${observation.scrollDiagnosticsText || '(нет диагностики скролла)'}

Filter/facet map:
${observation.filterControlsText || '(релевантные фильтры/сортировки не выделены)'}

Контекст из долговременной памяти:
${buildMemoryPrompt(memoryContext)}

Учётные данные:
${credentialHint}

История действий:
${historyText}

Сжатая траектория всей задачи:
${trajectoryText}

Loop diagnostics:
${loopDiagnosticsText}

Рабочие заметки:
${notesText}

Evidence stash:
${evidenceText}

Network observer:
${networkText}

Нейро-понимание текущей фазы страницы:
${pageUnderstandingSummary(pageUnderstanding)}

Ledger процесса:
${taskLedgerSummary(taskLedger)}

План/чеклист процесса:
${taskPlanSummary(taskPlan)}

Известные паттерны этого домена:
${sitePatternsText || '(нет доменного паттерна)'}

Проверка результата последнего действия:
${actionOutcomeSummary(lastActionOutcome)}

Рубрика выполнения задачи:
${taskRubricText}

Exploration coverage:
${explorationText}

Недавние ошибки и подсказка восстановления:
${recoveryText}
Если здесь есть ошибки локатора, выбери другой selector из Candidate selectors, попробуй index=N, scroll/wait или задай ask_user.

Candidate selectors:
${observation.interactiveText || '(нет явных интерактивных элементов)'}

Visual/code map: видимые кликабельные области, включая иконки/картинки без текста. Для click можно использовать selector visual=N или alt selector после "alt:":
${observation.visualMapText || '(визуальная карта кликабельных элементов пуста)'}

Структура страницы: карточки, строки, повторяющиеся блоки и действия внутри них:
${observation.structureText || '(структурные блоки не выделены)'}

Semantic page map: крупные области страницы, навигация, основная зона, формы, диалоги, поисковые и повторяющиеся секции:
${observation.semanticMapText || '(semantic map пуст)'}

Structured data/meta: JSON-LD, meta, canonical/важные ссылки:
${observation.structuredDataText || '(structured data не найдены)'}

Товарные карточки и прямые ссылки:
${observation.productCardsText || '(товарные карточки с прямыми ссылками не выделены)'}

Таблицы и гриды: строки, колонки и действия внутри строк:
${observation.tableText || '(таблицы/гриды не обнаружены)'}

Affordance graph: смысловые блоки интерфейса, поля и действия внутри них:
${observation.affordanceGraphText || '(affordance graph пуст)'}

Диагностика форм:
${observation.formText || '(формы/ошибки не обнаружены)'}

Form brain: поля, их kind, required/missing/invalid, selectors и options:
${observation.formBrainText || '(form brain пуст)'}

Модалки и cookie/consent-баннеры:
${observation.modalText || '(модалки/баннеры не обнаружены)'}

Iframe/встроенные виджеты:
${observation.frameText || '(нет важных iframe)'}

Вкладки браузера:
${observation.tabsText || '(открыта одна вкладка)'}

Accessibility tree:
${observation.a11yText || '(недоступна)'}

Видимый текст страницы:
${observation.pageText || '(нет текста)'}

Дропдауны:
${observation.selectOptions || '(нет select-элементов)'}

Runtime-сигналы страницы:
${observation.runtimeSignals || '(нет ошибок/предупреждений)'}

Что делать дальше? Верни JSON:
{"action":"...","selector":"...","value":"...","comment":"...","summary":"..."}`;

    let lastError: any;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const response = await createChatCompletionForTask('browserVision', {
                max_tokens: 650,
                temperature: 0.1,
                messages: [
                    { role: 'system', content: systemPrompt },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userContent },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${observation.screenshotB64}`,
                                    detail: 'high',
                                },
                            },
                        ],
                    },
                ],
            });

            const text = response.choices[0]?.message?.content?.trim() ?? '';
            const parsed = parseBrowserActionJson(text);
            if (parsed?.action) return parsed;
            const repaired = await repairBrowserActionJson(text);
            if (repaired?.action) return repaired;
            devLog('browserAgent: unparseable LLM response:', redactSecrets(text));
            const listingFallback = visibleListingFallbackDecision(task, observation, state);
            if (listingFallback) return listingFallback;
            return {
                action: 'ask_user',
                summary: 'Я не смогла надёжно выбрать следующий шаг на странице. Подскажи, что нажать дальше, или уточни цель.',
            };
        } catch (err: any) {
            lastError = err;
            console.error('[BROWSER] askNextAction error:', err?.message ?? err);
            if (!isTransientLlmError(err) || attempt === 2) break;
            await sleepMs(700 + attempt * 900);
        }
    }

    if (isTransientLlmError(lastError)) {
        return {
            action: 'ask_user',
            summary: `Временная ошибка LLM: ${safeErrorMessage(lastError) || 'неизвестно'}. Браузерная сессия сохранена; ответь «продолжай», и я продолжу с этого места.`,
        };
    }

    return { action: 'fail', summary: `Ошибка LLM: ${safeErrorMessage(lastError) || 'неизвестно'}` };
}

// ─── Выполнение действия ──────────────────────────────────────────────────────

function unescapeSelectorValue(value: string): string {
    return value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function normalizeCandidateSelector(selector: string): string {
    const trimmed = selector.trim();
    if (/^e\d{1,3}$/iu.test(trimmed)) return `ref=${trimmed.toLowerCase()}`;
    if (/^k\d{1,3}$/iu.test(trimmed)) return `domref=${trimmed.toLowerCase()}`;
    const bareIndex = trimmed.match(/^#(\d{1,3})$/);
    if (bareIndex) return `index=${bareIndex[1]}`;

    const copiedCandidate = trimmed.match(/->\s*([\s\S]+)$/);
    if (copiedCandidate) return copiedCandidate[1].trim();

    const verboseSnapshotIndex = trimmed.match(/^(?:candidate\s*)?#(\d{1,3})(?:\s|$)/i);
    if (verboseSnapshotIndex) return `index=${verboseSnapshotIndex[1]}`;

    const describedCandidate = trimmed.match(/^(?:candidate\s*)?#\d{1,3}\s+([a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)?\s+[«"“']([^«»“”"']{1,120})[»"”']\s*$/u);
    if (describedCandidate) {
        const role = describedCandidate[1].toLowerCase();
        const label = cleanWhitespace(unescapeSelectorValue(describedCandidate[2] || ''));
        const supportedRole = ['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab'].includes(role);
        if (supportedRole && label) return `role=${role}[name="${cssStringValue(label)}"]`;
        if (label) return `text=${label}`;
    }

    const candidateIndex = trimmed.match(/^(?:candidate\s*)?#(\d{1,3})$/i);
    if (candidateIndex) return `index=${candidateIndex[1]}`;

    return trimmed;
}

function resolveFrame(page: Page, frameRef: string): Frame | null {
    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    const numericIndex = frameRef.match(/^\d+$/) ? Number(frameRef) - 1 : -1;
    if (numericIndex >= 0) return frames[numericIndex] ?? null;

    const normalizedRef = frameRef.toLowerCase();
    return frames.find((frame) =>
        frame.url().toLowerCase().includes(normalizedRef) ||
        (frame.name() || '').toLowerCase().includes(normalizedRef)
    ) ?? null;
}

function cssStringValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssSelectorTextHint(selector: string): string {
    const attrMatch = selector.match(/\[(?:aria-label|title|value|placeholder)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\]/iu);
    if (attrMatch) return cleanWhitespace(unescapeSelectorValue(attrMatch[1] || attrMatch[2] || attrMatch[3] || ''));

    const hasTextMatch = selector.match(/:has-text\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/iu);
    if (hasTextMatch) return cleanWhitespace(unescapeSelectorValue(hasTextMatch[1] || hasTextMatch[2] || ''));

    const textMatch = selector.match(/text\s*=\s*(?:"([^"]+)"|'([^']+)')/iu);
    if (textMatch) return cleanWhitespace(unescapeSelectorValue(textMatch[1] || textMatch[2] || ''));

    return '';
}

function splitCandidateSelectorMetadata(selector: string): { core: string; href?: string } {
    let core = selector.trim();
    const hrefMatch = core.match(/\bhref=(?:"([^"]+)"|(\S+))/i);
    const href = hrefMatch ? cleanWhitespace(hrefMatch[1] || hrefMatch[2] || '') : undefined;

    core = core
        .replace(/\s+href=(?:"[^"]+"|\S+)/gi, '')
        .replace(/\s+context="[^"]*"/gi, '')
        .replace(/\s+alt:\s+[\s\S]*$/i, '')
        .trim();

    return { core, href };
}

function hrefLocatorsInRoot(root: Page | Frame, href?: string, name?: string): Locator[] {
    if (!href) return [];

    const locators: Locator[] = [];
    const add = (selector: string) => {
        const locator = (root as any).locator(selector);
        locators.push(name ? locator.filter({ hasText: name }) : locator);
    };

    add(`a[href="${cssStringValue(href)}"]`);

    try {
        const parsed = new URL(href);
        const path = `${parsed.pathname}${parsed.search || ''}`;
        if (path && path !== '/') add(`a[href*="${cssStringValue(path)}"]`);
    } catch {
        if (href.length >= 6) add(`a[href*="${cssStringValue(href)}"]`);
    }

    return locators;
}

function exactTextLocatorsInRoot(root: Page | Frame, text: string): Locator[] {
    const label = cleanWhitespace(text);
    if (!label) return [];
    return [
        (root as any).getByText(label, { exact: true }),
        (root as any).locator(`a:visible`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'iu') }),
        (root as any).locator(`button:visible`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'iu') }),
        (root as any).locator(`[role="menuitem"]:visible`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'iu') }),
        (root as any).locator(`[role="button"]:visible`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'iu') }),
        (root as any).locator(`[role="link"]:visible`).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, 'iu') }),
    ];
}

function buildLocatorsInRoot(root: Page | Frame, selector: string): Locator[] {
    const trimmed = normalizeCandidateSelector(selector);
    if (!trimmed) return [];

    const { core, href } = splitCandidateSelectorMetadata(trimmed);
    const roleMatch = core.match(/^role=([a-zA-Z0-9_-]+)\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\]$/);
    if (roleMatch) {
        const name = unescapeSelectorValue(roleMatch[2] || roleMatch[3] || roleMatch[4] || '');
        return [
            ...hrefLocatorsInRoot(root, href, name),
            (root as any).getByRole(roleMatch[1] as any, { name, exact: true }),
            ...exactTextLocatorsInRoot(root, name),
            (root as any).getByRole(roleMatch[1] as any, { name, exact: false }),
        ];
    }

    const hrefOnlyLocators = hrefLocatorsInRoot(root, href);
    if (hrefOnlyLocators.length && (!core || core === trimmed)) return hrefOnlyLocators;

    const refMatch = core.match(/^ref=(e?\d{1,3})$/i);
    if (refMatch) {
        const rawRef = refMatch[1].toLowerCase();
        const ref = rawRef.startsWith('e') ? rawRef : `e${rawRef}`;
        return [
            (root as any).locator(`aria-ref=${ref}`),
            (root as any).locator(`[data-kira-browser-ref="${cssStringValue(ref)}"]`),
        ];
    }

    const domRefMatch = core.match(/^domref=(k?\d{1,3})$/i);
    if (domRefMatch) {
        const rawRef = domRefMatch[1].toLowerCase();
        const ref = rawRef.startsWith('k') ? rawRef : `k${rawRef}`;
        return [(root as any).locator(`[data-kira-browser-ref="${cssStringValue(ref)}"]`)];
    }

    const indexMatch = core.match(/^index=(\d+)$/);
    if (indexMatch) {
        const index = Math.max(0, Number(indexMatch[1]) - 1);
        return [(root as any).locator(VISIBLE_INTERACTIVE_ELEMENT_SELECTOR).nth(index)];
    }

    const textExactMatch = core.match(/^text=([\s\S]+)$/);
    if (textExactMatch) {
        const value = unescapeSelectorValue(textExactMatch[1]);
        return [
            ...hrefLocatorsInRoot(root, href, value),
            ...exactTextLocatorsInRoot(root, value),
            (root as any).getByText(value, { exact: false }),
        ];
    }

    const prefixes: Array<[RegExp, (value: string) => Locator]> = [
        [/^css=([\s\S]+)$/, (value) => (root as any).locator(value)],
        [/^label=([\s\S]+)$/, (value) => (root as any).getByLabel(value, { exact: false })],
        [/^placeholder=([\s\S]+)$/, (value) => (root as any).getByPlaceholder(value, { exact: false })],
        [/^testid=([\s\S]+)$/, (value) => (root as any).getByTestId(value)],
    ];

    for (const [pattern, factory] of prefixes) {
        const match = core.match(pattern);
        if (match) {
            const value = unescapeSelectorValue(match[1]);
            return href && !/^css=/i.test(core) && !/^testid=/i.test(core)
                ? [...hrefLocatorsInRoot(root, href, value), factory(value)]
                : [factory(value)];
        }
    }

    const cssTextHint = cssSelectorTextHint(core);
    const hintLocators = cssTextHint
        ? [
            (root as any).getByRole('button', { name: cssTextHint, exact: false }),
            (root as any).getByRole('link', { name: cssTextHint, exact: false }),
            (root as any).getByLabel(cssTextHint, { exact: false }),
            (root as any).getByText(cssTextHint, { exact: false }),
        ]
        : [];

    const semanticLocators = [
        ...hrefLocatorsInRoot(root, href, core),
        (root as any).getByRole('button', { name: core, exact: false }),
        (root as any).getByRole('link', { name: core, exact: false }),
        (root as any).getByLabel(core, { exact: false }),
        (root as any).getByPlaceholder(core, { exact: false }),
        (root as any).getByText(core, { exact: false }),
    ];
    const looksLikeCss = /^[.#\[]/.test(core) || /[>+~:]/.test(core) || /^(a|button|input|textarea|select|form|div|span)\b/i.test(core);
    return looksLikeCss
        ? [(root as any).locator(core), ...hintLocators, ...semanticLocators]
        : [...semanticLocators, ...hintLocators, (root as any).locator(core)];
}

function buildLocators(page: Page, selector: string): Locator[] {
    const trimmed = normalizeCandidateSelector(selector);
    const frameMatch = trimmed.match(/^frame=([^>]+?)\s*>>\s*([\s\S]+)$/);
    if (frameMatch) {
        const frame = resolveFrame(page, frameMatch[1].trim());
        return frame ? buildLocatorsInRoot(frame, frameMatch[2].trim()) : [];
    }

    return buildLocatorsInRoot(page, trimmed);
}

async function tryLocators<T>(
    page: Page,
    selector: string,
    action: (locator: Locator) => Promise<T>
): Promise<T> {
    const locators = buildLocators(page, selector);
    let lastError: unknown;

    for (const locator of locators) {
        try {
            const count = await locator.count().catch(() => -1);
            if (count === 0) continue;
            const first = locator.first();
            await first.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            return await action(first);
        } catch (e) {
            lastError = e;
        }
    }

    throw lastError ?? new Error(`Не найден элемент: ${selector}`);
}

async function clickPointLikeUser(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.move(x, y, { steps: 4 + Math.floor(Math.random() * 5) });
    await page.waitForTimeout(35 + Math.floor(Math.random() * 75)).catch(() => {});
    await page.mouse.down();
    await page.waitForTimeout(25 + Math.floor(Math.random() * 55)).catch(() => {});
    await page.mouse.up();
}

async function clickLocatorLikeUser(page: Page, target: Locator | any): Promise<void> {
    await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
        await target.hover?.({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(25 + Math.floor(Math.random() * 65)).catch(() => {});
        await target.click({ timeout: ACTION_TIMEOUT_MS, delay: 25 + Math.floor(Math.random() * 55) });
        return;
    } catch (primaryErr) {
        const box = await target.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
            try {
                const x = box.x + box.width * (0.43 + Math.random() * 0.14);
                const y = box.y + box.height * (0.43 + Math.random() * 0.14);
                await clickPointLikeUser(page, x, y);
                return;
            } catch {
                // Fall through to the force-click fallback below.
            }
        }
        try {
            await target.click({ timeout: ACTION_TIMEOUT_MS, force: true });
        } catch {
            throw primaryErr;
        }
    }
}

type SelfHealingActionResult =
    | { status: 'healed'; comment: string }
    | { status: 'none'; reason: string };

function selectorIntentText(decision: BrowserAction): string {
    const raw = [
        decision.selector || '',
        decision.value || '',
        decision.comment || '',
        decision.summary || '',
    ].join(' ');
    return cleanWhitespace(raw
        .replace(/\b(?:css|text|label|placeholder|role|testid|index|visual)=/giu, ' ')
        .replace(/\[[^\]]*name\s*=\s*["']?([^"'\]]+)["']?[^\]]*\]/giu, ' $1 ')
        .replace(/\[[^\]]*(?:aria-label|placeholder|title|name|data-testid|data-test)\s*=\s*["']?([^"'\]]+)["']?[^\]]*\]/giu, ' $1 ')
        .replace(/[.#:[\]>"'=]/gu, ' '));
}

async function trySelfHealingAction(page: Page, decision: BrowserAction): Promise<SelfHealingActionResult> {
    if (!['click', 'fill', 'select_option', 'check', 'uncheck', 'hover'].includes(decision.action)) {
        return { status: 'none', reason: 'action_not_supported' };
    }
    const intent = selectorIntentText(decision).slice(0, 260);
    if (!intent || intent.length < 2) return { status: 'none', reason: 'empty_intent' };

    const querySelector =
        decision.action === 'fill'
            ? 'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"],[aria-label],[placeholder]'
            : decision.action === 'select_option'
                ? 'select,[role="combobox"],[aria-label]'
                : decision.action === 'check' || decision.action === 'uncheck'
                    ? 'input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],label,[aria-label]'
                    : CLICKABLE_CONTROL_SELECTOR;

    const handle = await page.evaluateHandle(({ selector, rawIntent }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const stem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            return value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
        };
        const tokens = normalize(rawIntent)
            .split(/[^a-zа-яё0-9#№]+/iu)
            .map(stem)
            .filter((token) => token.length >= 2)
            .filter((token, index, arr) => arr.indexOf(token) === index)
            .slice(0, 14);
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const surfaceOf = (el: Element) => {
            const input = el as HTMLInputElement;
            const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
            const parentText = compact(el.closest('label')?.textContent || '');
            const optionText = el.tagName.toLowerCase() === 'select'
                ? Array.from((el as HTMLSelectElement).options).map((option) => compact(option.text || option.value)).join(' ')
                : '';
            const imgText = Array.from(el.querySelectorAll('img'))
                .map((img) => compact(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('src')?.split('/').pop()))
                .filter(Boolean)
                .join(' ');
            return compact([
                labelText,
                parentText,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('title'),
                el.getAttribute('name'),
                el.getAttribute('id'),
                el.getAttribute('data-testid'),
                el.getAttribute('data-test'),
                el.getAttribute('class'),
                (el as HTMLElement).innerText || el.textContent,
                (input.type || '').toLowerCase(),
                optionText,
                imgText,
            ].filter(Boolean).join(' '));
        };
        const normalizedIntent = normalize(rawIntent);
        const candidates = Array.from(document.querySelectorAll(selector))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
            .map((el) => {
                const surface = surfaceOf(el);
                const normalizedSurface = normalize(surface);
                const rect = el.getBoundingClientRect();
                const surfaceTokens = normalizedSurface.split(/[^a-zа-яё0-9#№]+/iu).map(stem).filter((token) => token.length >= 2);
                const hits = tokens.filter((token) =>
                    surfaceTokens.some((candidate) => candidate === token || candidate.startsWith(token) || token.startsWith(candidate))
                ).length;
                let score = hits * 28;
                if (normalizedSurface === normalizedIntent) score += 140;
                if (normalizedIntent && normalizedSurface.includes(normalizedIntent)) score += 90;
                if (el.getAttribute('aria-label') && normalize(el.getAttribute('aria-label') || '') === normalizedIntent) score += 90;
                if (el.getAttribute('placeholder') && normalize(el.getAttribute('placeholder') || '') === normalizedIntent) score += 70;
                if (el.getAttribute('data-testid') && normalizedIntent.includes(normalize(el.getAttribute('data-testid') || ''))) score += 45;
                if (rect.top >= -10 && rect.left >= -10 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 12;
                if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true') score -= 120;
                score -= Math.min(34, Math.floor(normalizedSurface.length / 180));
                return { el, score, surface: surface.slice(0, 220) };
            })
            .filter((item) => item.score >= 42)
            .sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
    }, { selector: querySelector, rawIntent: intent });

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        return { status: 'none', reason: `no_similar_target_for:${intent.slice(0, 80)}` };
    }

    try {
        if (decision.action === 'click') {
            await clickLocatorLikeUser(page, element);
            return { status: 'healed', comment: `Нашла похожий видимый элемент и нажала его: ${intent.slice(0, 120)}` };
        }
        if (decision.action === 'hover') {
            await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await element.hover({ timeout: ACTION_TIMEOUT_MS });
            return { status: 'healed', comment: `Нашла похожий видимый элемент и навела курсор: ${intent.slice(0, 120)}` };
        }
        if (decision.action === 'fill') {
            const value = decision.value || '';
            try {
                await element.fill(value, { timeout: ACTION_TIMEOUT_MS });
            } catch {
                await clickLocatorLikeUser(page, element);
                await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
                await page.keyboard.type(value, { delay: 20 });
            }
            return { status: 'healed', comment: `Нашла подходящее поле по подписи и заполнила его: ${intent.slice(0, 120)}` };
        }
        if (decision.action === 'select_option') {
            try {
                await element.selectOption(decision.value || '', { timeout: ACTION_TIMEOUT_MS });
            } catch {
                await element.selectOption({ label: decision.value || '' }, { timeout: ACTION_TIMEOUT_MS });
            }
            return { status: 'healed', comment: `Нашла подходящий список по подписи и выбрала вариант: ${(decision.value || '').slice(0, 80)}` };
        }
        if (decision.action === 'check') {
            await element.check({ timeout: ACTION_TIMEOUT_MS });
            return { status: 'healed', comment: `Нашла подходящий переключатель по подписи и отметила его: ${intent.slice(0, 120)}` };
        }
        if (decision.action === 'uncheck') {
            await element.uncheck({ timeout: ACTION_TIMEOUT_MS });
            return { status: 'healed', comment: `Нашла подходящий переключатель по подписи и сняла отметку: ${intent.slice(0, 120)}` };
        }
        return { status: 'none', reason: 'unsupported_after_target_found' };
    } finally {
        await handle.dispose();
    }
}

async function clickVisualControlByIndex(page: Page, visualIndex: number): Promise<void> {
    const handle = await page.evaluateHandle(({ selector, targetIndex }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const roleOf = (el: Element) => {
            const explicit = compact(el.getAttribute('role'));
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
            return tag;
        };
        const visualHintsOf = (el: Element) => [
            ...Array.from(el.querySelectorAll('img')).map((img) => compact(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('src')?.split('/').pop())),
            ...Array.from(el.querySelectorAll('svg title')).map((node) => compact(node.textContent)),
            compact(el.id),
            compact(el.getAttribute('class')),
            compact(el.getAttribute('data-testid')),
            compact(el.getAttribute('data-test')),
        ].filter(Boolean);
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
            const value = ['submit', 'button', 'reset'].includes((input.type || '').toLowerCase()) ? compact(input.value) : '';
            return compact(labelText || el.getAttribute('aria-label') || el.getAttribute('title') || value || (el as HTMLElement).innerText || el.textContent || visualHintsOf(el).join(' '));
        };
        const isActionable = (el: Element) => {
            const tag = el.tagName.toLowerCase();
            const type = ((el as HTMLInputElement).type || '').toLowerCase();
            const role = roleOf(el).toLowerCase();
            const style = window.getComputedStyle(el);
            if (tag === 'a' || tag === 'button') return true;
            if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return true;
            if (['button', 'link', 'menuitem', 'tab'].includes(role)) return true;
            if (el.getAttribute('onclick')) return true;
            if (style.cursor === 'pointer' && (textOf(el) || visualHintsOf(el).length)) return true;
            return false;
        };
        const controls = Array.from(document.querySelectorAll(selector))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el) && isActionable(el));
        return controls[targetIndex] ?? null;
    }, { selector: CLICKABLE_CONTROL_SELECTOR, targetIndex: visualIndex });

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        throw new Error(`Не найден визуальный элемент visual=${visualIndex + 1}`);
    }

    try {
        await clickLocatorLikeUser(page, element);
    } finally {
        await handle.dispose();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function clickVisualCandidate(page: Page, candidate: VisualClickCandidate): Promise<void> {
    for (const selector of candidate.selectors.slice(0, 4)) {
        try {
            await tryLocators(page, selector, (locator) => clickLocatorLikeUser(page, locator));
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            return;
        } catch {
            // Try the next selector, then the visual index/coordinates.
        }
    }

    await clickVisualControlByIndex(page, candidate.controlIndex);
}

async function findOnPage(page: Page, query: string): Promise<PageFindResult> {
    const cleanQuery = cleanWhitespace(query).slice(0, 160);
    if (!cleanQuery) throw new Error('Пустой запрос поиска по странице');

    const result = await page.evaluate((rawQuery) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const tokenStem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            value = value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
            return value;
        };
        const tokens = normalize(rawQuery)
            .split(/[^a-zа-яё0-9#№]+/iu)
            .map(tokenStem)
            .filter((token) => token.length >= 2);
        const query = normalize(rawQuery);
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const roleOf = (el: Element) => {
            const explicit = compact(el.getAttribute('role'));
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return 'link';
            if (tag === 'button') return 'button';
            if (/^h[1-6]$/iu.test(tag)) return 'heading';
            if (tag === 'input' || tag === 'textarea') return 'textbox';
            if (tag === 'select') return 'select';
            return tag;
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
            const imgText = Array.from(el.querySelectorAll('img'))
                .map((img) => compact(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('src')?.split('/').pop()))
                .filter(Boolean)
                .join(' ');
            const svgText = Array.from(el.querySelectorAll('svg title'))
                .map((node) => compact(node.textContent))
                .filter(Boolean)
                .join(' ');
            const value = ['submit', 'button', 'reset'].includes((input.type || '').toLowerCase()) ? compact(input.value) : '';
            return compact([
                labelText,
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('title'),
                value,
                (el as HTMLElement).innerText || el.textContent,
                imgText,
                svgText,
                el.id,
                el.getAttribute('data-testid'),
                el.getAttribute('data-test'),
                el.getAttribute('name'),
            ].filter(Boolean).join(' '));
        };
        const actionable = (el: Element) => {
            const tag = el.tagName.toLowerCase();
            const role = roleOf(el).toLowerCase();
            const type = ((el as HTMLInputElement).type || '').toLowerCase();
            return tag === 'a' ||
                tag === 'button' ||
                (tag === 'input' && ['button', 'submit', 'reset', 'text', 'search', 'email', 'tel'].includes(type)) ||
                tag === 'textarea' ||
                tag === 'select' ||
                ['button', 'link', 'menuitem', 'tab', 'textbox', 'searchbox', 'combobox'].includes(role);
        };
        const selector = [
            'a',
            'button',
            'input',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="menuitem"]',
            '[role="tab"]',
            '[role="textbox"]',
            '[role="searchbox"]',
            '[aria-label]',
            '[placeholder]',
            '[data-testid]',
            '[data-test]',
            'label',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            '[role="heading"]',
            'li',
            'article',
            'section',
            'tr',
            'td',
            'p',
            'span',
            'div',
        ].join(',');
        const candidates = Array.from(document.querySelectorAll(selector))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
            .map((el) => {
                const text = textOf(el);
                const normalized = normalize(text);
                if (!normalized) return null;
                const rect = el.getBoundingClientRect();
                const role = roleOf(el);
                const tag = el.tagName.toLowerCase();
                const broadContainer =
                    (tag === 'div' || tag === 'section') &&
                    (normalized.length > 900 || rect.width > window.innerWidth * 1.15 || rect.height > window.innerHeight * 2.2);
                if (broadContainer && !normalized.includes(query)) return null;

                let score = 0;
                if (normalized === query) score += 150;
                if (normalized.includes(query)) score += 95 + Math.min(40, query.length);
                const textTokens = normalized.split(/[^a-zа-яё0-9#№]+/iu).map(tokenStem).filter((token) => token.length >= 2);
                const hits = tokens.filter((token) =>
                    textTokens.some((candidate) => candidate === token || candidate.startsWith(token) || token.startsWith(candidate))
                ).length;
                if (tokens.length && hits === tokens.length) score += 60;
                else score += hits * 16;
                if (actionable(el)) score += 24;
                if (role === 'heading') score += 18;
                if (tag === 'label') score += 14;
                if (['input', 'textarea', 'select'].includes(tag)) score += 18;
                if (rect.top >= 0 && rect.top < window.innerHeight && rect.left >= 0 && rect.left < window.innerWidth) score += 8;
                score -= Math.min(35, Math.floor(normalized.length / 180));
                if (rect.width * rect.height > window.innerWidth * window.innerHeight * 0.55) score -= 28;

                return {
                    el,
                    score,
                    text: text.slice(0, 420),
                    tag,
                    role,
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                };
            })
            .filter((item): item is { el: Element; score: number; text: string; tag: string; role: string; bbox: string } => Boolean(item && item.score >= 20))
            .sort((a, b) => b.score - a.score);

        const best = candidates[0];
        if (!best) return null;
        document.querySelectorAll('[data-kira-find-highlight="true"]').forEach((node) => {
            const html = node as HTMLElement;
            html.style.outline = '';
            html.style.outlineOffset = '';
            html.removeAttribute('data-kira-find-highlight');
        });
        const target = best.el as HTMLElement;
        target.setAttribute('data-kira-find-highlight', 'true');
        target.style.outline = '3px solid #ff9800';
        target.style.outlineOffset = '3px';
        target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (typeof target.focus === 'function' && actionable(target)) target.focus({ preventScroll: true });
        const nextRect = target.getBoundingClientRect();
        return {
            query: rawQuery,
            text: best.text,
            tag: best.tag,
            role: best.role,
            bbox: `${Math.round(nextRect.x)},${Math.round(nextRect.y)},${Math.round(nextRect.width)},${Math.round(nextRect.height)}`,
            score: best.score,
        };
    }, cleanQuery);

    if (!result) throw new Error(`На странице не найдено: ${cleanQuery}`);
    await page.waitForTimeout(350);
    return result;
}

async function fillSearchInput(locator: Locator, page: Page, query: string): Promise<void> {
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    try {
        await locator.fill(query, { timeout: ACTION_TIMEOUT_MS });
    } catch {
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.type(query, { delay: 20 });
    }
    await page.keyboard.press('Enter');
}

async function runSiteSearch(page: Page, query: string): Promise<string> {
    const cleanQuery = cleanWhitespace(query).slice(0, 220);
    if (!cleanQuery) throw new Error('Пустой запрос поиска по сайту');

    const inputSelectors = [
        'input[type="search"]',
        'input[name="q"]',
        'input[name="query"]',
        'input[name*="search" i]',
        'input[name*="поиск" i]',
        'input[placeholder*="search" i]',
        'input[placeholder*="поиск" i]',
        'input[aria-label*="search" i]',
        'input[aria-label*="поиск" i]',
        'textarea[name="q"]',
        '[role="searchbox"]',
        '[contenteditable="true"][aria-label*="search" i]',
        '[contenteditable="true"][aria-label*="поиск" i]',
    ];

    const tryInputSelectors = async (): Promise<string | null> => {
        for (const selector of inputSelectors) {
            const locator = page.locator(selector).first();
            const count = await locator.count().catch(() => 0);
            if (!count) continue;
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) continue;
            await fillSearchInput(locator, page, cleanQuery);
            return selector;
        }
        return null;
    };

    let used = await tryInputSelectors();
    if (!used) {
        const toggles: Locator[] = [
            page.getByRole('button', { name: /поиск|search|найти/i }),
            page.getByRole('link', { name: /поиск|search|найти/i }),
            page.locator('button[aria-label*="search" i],button[aria-label*="поиск" i],a[aria-label*="search" i],a[aria-label*="поиск" i]'),
            page.locator('[data-testid*="search" i],[data-test*="search" i],[class*="search" i],[id*="search" i]'),
        ];
        for (const toggle of toggles) {
            const count = await toggle.count().catch(() => 0);
            if (!count) continue;
            const first = toggle.first();
            const visible = await first.isVisible().catch(() => false);
            if (!visible) continue;
            await clickLocatorLikeUser(page, first);
            await page.waitForTimeout(350);
            used = await tryInputSelectors();
            if (used) break;
        }
    }

    if (!used) throw new Error('Не найдено поле поиска на сайте');

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return `site_search "${cleanQuery}" через ${used}`;
}

interface DateIntent {
    raw: string;
    iso?: string;
    day?: number;
    month?: number;
    year?: number;
    labels: string[];
}

function parseDateIntent(raw: string): DateIntent {
    const text = cleanWhitespace(raw);
    const months: Record<string, number> = {
        январь: 1,
        января: 1,
        jan: 1,
        january: 1,
        февраль: 2,
        февраля: 2,
        feb: 2,
        february: 2,
        март: 3,
        марта: 3,
        mar: 3,
        march: 3,
        апрель: 4,
        апреля: 4,
        apr: 4,
        april: 4,
        май: 5,
        мая: 5,
        may: 5,
        июнь: 6,
        июня: 6,
        jun: 6,
        june: 6,
        июль: 7,
        июля: 7,
        jul: 7,
        july: 7,
        август: 8,
        августа: 8,
        aug: 8,
        august: 8,
        сентябрь: 9,
        сентября: 9,
        sep: 9,
        september: 9,
        октябрь: 10,
        октября: 10,
        oct: 10,
        october: 10,
        ноябрь: 11,
        ноября: 11,
        nov: 11,
        november: 11,
        декабрь: 12,
        декабря: 12,
        dec: 12,
        december: 12,
    };
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const fromDate = (date: Date): DateIntent => {
        const day = date.getDate();
        const month = date.getMonth() + 1;
        const year = date.getFullYear();
        const iso = `${year}-${pad(month)}-${pad(day)}`;
        const ruLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
        const ruShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
        return {
            raw: text,
            iso,
            day,
            month,
            year,
            labels: [text, iso, `${day}.${month}.${year}`, `${pad(day)}.${pad(month)}.${year}`, ruLong, ruShort, String(day)]
                .map(cleanWhitespace)
                .filter(Boolean),
        };
    };
    const relative = normalizeSearchText(text);
    if (/^сегодня$/iu.test(relative)) return fromDate(now);
    if (/^завтра$/iu.test(relative)) {
        const date = new Date(now);
        date.setDate(date.getDate() + 1);
        return fromDate(date);
    }
    if (/послезавтра/iu.test(relative)) {
        const date = new Date(now);
        date.setDate(date.getDate() + 2);
        return fromDate(date);
    }

    const isoMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/u);
    if (isoMatch) return fromDate(new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));

    const dotted = text.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/u);
    if (dotted) {
        const year = dotted[3] ? Number(dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3]) : now.getFullYear();
        return fromDate(new Date(year, Number(dotted[2]) - 1, Number(dotted[1])));
    }

    const monthPattern = new RegExp(`(\\d{1,2})\\s+(${Object.keys(months).map(escapeRegExp).join('|')})(?:\\s+(\\d{4}))?`, 'iu');
    const monthMatch = text.match(monthPattern);
    if (monthMatch) {
        const month = months[normalizeSearchText(monthMatch[2])];
        const year = monthMatch[3] ? Number(monthMatch[3]) : now.getFullYear();
        return fromDate(new Date(year, month - 1, Number(monthMatch[1])));
    }

    const dayOnly = text.match(/\b(\d{1,2})\b/u);
    return {
        raw: text,
        day: dayOnly ? Number(dayOnly[1]) : undefined,
        labels: [text, dayOnly?.[1] || ''].filter(Boolean),
    };
}

async function selectDateOnPage(page: Page, rawDate: string, selector?: string): Promise<string> {
    const intent = parseDateIntent(rawDate);
    if (!intent.raw && !intent.iso && !intent.day) throw new Error('Пустая дата для выбора');

    if (selector) {
        const locators = buildLocators(page, selector);
        for (const locator of locators) {
            const count = await locator.count().catch(() => 0);
            if (!count) continue;
            const first = locator.first();
            const tagType = await first.evaluate((el) => ({
                tag: el.tagName.toLowerCase(),
                type: (el as HTMLInputElement).type || '',
            })).catch(() => ({ tag: '', type: '' }));
            if (intent.iso && tagType.tag === 'input' && tagType.type === 'date') {
                await first.fill(intent.iso, { timeout: ACTION_TIMEOUT_MS });
                return `выбрана дата ${intent.iso} через input[type=date]`;
            }
            await clickLocatorLikeUser(page, first);
            await page.waitForTimeout(350);
            break;
        }
    }

    if (intent.iso) {
        const dateInputs = page.locator('input[type="date"]:visible');
        const count = await dateInputs.count().catch(() => 0);
        if (count > 0) {
            await dateInputs.first().fill(intent.iso, { timeout: ACTION_TIMEOUT_MS });
            return `выбрана дата ${intent.iso} через видимое поле даты`;
        }
    }

    const handle = await page.evaluateHandle((dateIntent) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const disabled = (el: Element) =>
            (el as HTMLButtonElement).disabled ||
            el.getAttribute('aria-disabled') === 'true' ||
            el.hasAttribute('disabled') ||
            /disabled|unavailable|past|inactive/iu.test(`${el.getAttribute('class') || ''} ${el.getAttribute('aria-label') || ''}`);
        const surfaceOf = (el: Element) => compact([
            (el as HTMLElement).innerText || el.textContent,
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('data-date'),
            el.getAttribute('data-day'),
            el.getAttribute('data-value'),
            el.getAttribute('datetime'),
            el.getAttribute('value'),
        ].filter(Boolean).join(' '));
        const labels = (dateIntent.labels || []).map(normalize).filter(Boolean);
        const iso = dateIntent.iso ? normalize(dateIntent.iso) : '';
        const day = dateIntent.day ? String(dateIntent.day) : '';
        const month = dateIntent.month ? String(dateIntent.month).padStart(2, '0') : '';
        const year = dateIntent.year ? String(dateIntent.year) : '';
        const roots = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[class*="date" i]',
            '[class*="calendar" i]',
            '[class*="datepicker" i]',
            '[id*="date" i]',
            '[id*="calendar" i]',
            'body',
        ].join(','))).filter(isVisible);
        const root = roots[0] || document.body;
        const candidates = Array.from(root.querySelectorAll([
            'button',
            'td',
            'th',
            'a',
            '[role="button"]',
            '[role="gridcell"]',
            '[aria-label]',
            '[data-date]',
            '[data-day]',
            '[datetime]',
        ].join(',')))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
            .map((el) => {
                const text = compact((el as HTMLElement).innerText || el.textContent);
                const surface = normalize(surfaceOf(el));
                const rect = el.getBoundingClientRect();
                let score = 0;
                if (disabled(el)) score -= 300;
                if (iso && surface.includes(iso)) score += 220;
                if (iso && normalize(el.getAttribute('data-date') || el.getAttribute('datetime') || '') === iso) score += 260;
                for (const label of labels) {
                    if (!label) continue;
                    if (surface === label) score += 130;
                    else if (surface.includes(label)) score += 95;
                }
                if (day && normalize(text) === day) score += 70;
                if (day && normalize(el.getAttribute('data-day') || '') === day) score += 90;
                if (month && year && surface.includes(`${year}-${month}`)) score += 50;
                if (/(gridcell|button|cell)/iu.test(el.getAttribute('role') || el.tagName)) score += 16;
                if (rect.top >= -20 && rect.left >= -20 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 10;
                if (text.length > 18 && !iso) score -= 18;
                return {
                    el,
                    score,
                    text: surfaceOf(el).slice(0, 180),
                };
            })
            .filter((item) => item.score >= 70)
            .sort((a, b) => b.score - a.score);
        return candidates[0]?.el || null;
    }, intent);

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        throw new Error(`Не удалось найти дату "${intent.raw}" в календаре`);
    }

    try {
        await clickLocatorLikeUser(page, element);
    } finally {
        await handle.dispose();
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    return `выбрана дата ${intent.iso || intent.raw}`;
}

function browserArtifactPath(state: BrowserRunState, filename: string): string {
    const dir = path.join(os.tmpdir(), 'kira-browser-downloads', state.id);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${Date.now()}_${safeFileName(filename)}`);
}

async function saveCurrentPagePdf(state: BrowserRunState, filenameHint?: string): Promise<string> {
    const title = cleanWhitespace(filenameHint || await state.page.title().catch(() => '') || 'page').slice(0, 80);
    const filename = safeFileName(`${title || 'page'}.pdf`);
    const filePath = browserArtifactPath(state, filename);
    await state.page.pdf({
        path: filePath,
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' },
    });
    state.downloads.push({ filename, filePath, url: state.page.url() });
    state.notes.push(`Сохранён PDF страницы: ${filename}`);
    pushEvidence(state, 'download', `Сохранён PDF страницы: ${filename}`, state.page.url());
    pushPageEvent(state, `[artifact:pdf] ${filename}`);
    return filename;
}

async function saveCurrentScreenshot(state: BrowserRunState, filenameHint?: string): Promise<string> {
    const title = cleanWhitespace(filenameHint || await state.page.title().catch(() => '') || 'screenshot').slice(0, 80);
    const filename = safeFileName(`${title || 'screenshot'}.jpg`);
    const filePath = browserArtifactPath(state, filename);
    fs.writeFileSync(filePath, await takeJpeg(state.page));
    state.downloads.push({ filename, filePath, url: state.page.url() });
    state.notes.push(`Сохранён скриншот страницы: ${filename}`);
    pushEvidence(state, 'download', `Сохранён скриншот страницы: ${filename}`, state.page.url());
    pushPageEvent(state, `[artifact:screenshot] ${filename}`);
    return filename;
}

async function switchBrowserTab(state: BrowserRunState, target?: string): Promise<string> {
    const pages = state.browserCtx.pages().filter((page) => !page.isClosed());
    if (!pages.length) throw new Error('Нет открытых вкладок');

    const raw = cleanWhitespace(target || 'last').toLowerCase();
    const currentIndex = Math.max(0, pages.indexOf(state.page));
    let nextIndex = pages.length - 1;

    if (/^\d+$/.test(raw)) {
        nextIndex = Math.max(0, Math.min(pages.length - 1, Number(raw) - 1));
    } else if (/^(current|текущ)/iu.test(raw)) {
        nextIndex = currentIndex;
    } else if (/^(next|след)/iu.test(raw)) {
        nextIndex = (currentIndex + 1) % pages.length;
    } else if (/^(prev|previous|пред|назад)/iu.test(raw)) {
        nextIndex = (currentIndex - 1 + pages.length) % pages.length;
    } else if (/^(first|первая)/iu.test(raw)) {
        nextIndex = 0;
    } else if (!/^(last|послед)/iu.test(raw)) {
        const matches = await Promise.all(pages.map(async (candidate, index) => {
            const title = await candidate.title().catch(() => '');
            const surface = normalizeSearchText(`${title} ${candidate.url()}`);
            return { index, hit: surface.includes(normalizeSearchText(raw)) };
        }));
        const match = matches.find((item) => item.hit);
        if (match) nextIndex = match.index;
    }

    const next = pages[nextIndex];
    await next.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    state.page = next;
    attachPageObserversToPage(state, next);
    const title = await next.title().catch(() => '');
    pushPageEvent(state, `[browser] switched to tab#${nextIndex + 1} ${next.url()}`);
    return `tab#${nextIndex + 1} ${title || next.url()}`;
}

async function closeBrowserTab(state: BrowserRunState, target?: string): Promise<string> {
    const pages = state.browserCtx.pages().filter((page) => !page.isClosed());
    if (pages.length <= 1) throw new Error('Нельзя закрыть единственную вкладку браузера');

    const raw = cleanWhitespace(target || 'current').toLowerCase();
    let closeIndex = pages.indexOf(state.page);
    if (/^\d+$/.test(raw)) closeIndex = Math.max(0, Math.min(pages.length - 1, Number(raw) - 1));
    else if (/^(last|послед)/iu.test(raw)) closeIndex = pages.length - 1;
    else if (/^(first|первая)/iu.test(raw)) closeIndex = 0;
    else if (!/^(current|текущ)/iu.test(raw)) {
        const matches = await Promise.all(pages.map(async (candidate, index) => {
            const title = await candidate.title().catch(() => '');
            const surface = normalizeSearchText(`${title} ${candidate.url()}`);
            return { index, hit: surface.includes(normalizeSearchText(raw)) };
        }));
        const match = matches.find((item) => item.hit);
        if (match) closeIndex = match.index;
    }
    if (closeIndex < 0) closeIndex = pages.length - 1;

    const closing = pages[closeIndex];
    const closingUrl = closing.url();
    await closing.close().catch(() => {});
    const remaining = state.browserCtx.pages().filter((page) => !page.isClosed());
    state.page = remaining[Math.min(closeIndex, remaining.length - 1)] || remaining[remaining.length - 1];
    if (state.page) {
        await state.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        attachPageObserversToPage(state, state.page);
    }
    pushPageEvent(state, `[browser] closed tab#${closeIndex + 1} ${closingUrl}`);
    return `закрыта tab#${closeIndex + 1}`;
}

function isDismissibleTechnicalOverlayText(text: string): boolean {
    const normalized = normalizeSearchText(text);
    if (!normalized) return false;
    const hasTechnicalTopic =
        /(cookie|cookies|куки|файл(?:ов|ы)?\s+cookie|consent|соглас(?:ие|ия|иться)?\s+на\s+cookie|newsletter|подписк|уведомлен|notification|геолокац|location|adblock|рекламн(?:ый|ое)\s+баннер)/iu.test(normalized);
    if (!hasTechnicalTopic) return false;

    const hasHighImpactTopic =
        /(оплат|платеж|платёж|покупк|заказ|бронир|брон[ьи]|заявк|регистрац|паспорт|документ|удал|delete|cancel\s+booking|confirm\s+order|submit\s+order)/iu.test(normalized);
    return !hasHighImpactTopic;
}

function hasDismissibleTechnicalOverlay(observation: PageObservation): boolean {
    const modalSurface = [observation.modalText, observation.blockerSignals].filter(Boolean).join('\n');
    if (isDismissibleTechnicalOverlayText(modalSurface)) return true;

    const pageSurface = [observation.pageText, observation.interactiveText].filter(Boolean).join('\n');
    return /(?:сайт\s+использует\s+cookie|использовани[ея]\s+файлов\s+cookie|we\s+use\s+cookies|accept\s+cookies)/iu.test(pageSurface) &&
        /(хорошо|понятно|принять|accept|agree|ok|закрыть|close)/iu.test(pageSurface);
}

async function dismissOverlays(page: Page): Promise<string> {
    const clicked = await page.evaluate(() => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const overlayText = (el: Element) => normalize((el as HTMLElement).innerText || el.textContent || '');
        const overlayRoots = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog',
            '[class*="modal" i]',
            '[class*="popup" i]',
            '[class*="overlay" i]',
            '[class*="cookie" i]',
            '[class*="consent" i]',
            '[id*="cookie" i]',
            '[id*="consent" i]',
        ].join(','))).filter(isVisible);
        const technicalTextRoots = Array.from(document.querySelectorAll('body *'))
            .filter((el, index) => index < 2500 && isVisible(el))
            .map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                    el,
                    text: overlayText(el),
                    area: rect.width * rect.height,
                    fixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
                };
            })
            .filter((item) =>
                /(cookie|cookies|куки|файл(?:ов|ы)?\s+cookie|consent|соглас)/iu.test(item.text) &&
                (item.fixed || item.area < window.innerWidth * window.innerHeight * 0.55) &&
                item.el !== document.body &&
                item.el !== document.documentElement
            )
            .sort((a, b) => a.area - b.area)
            .map((item) => item.el)
            .slice(0, 6);
        const roots = [...overlayRoots, ...technicalTextRoots];
        if (!roots.length) roots.push(document.body);
        const controls = roots.flatMap((root) =>
            Array.from(root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],[onclick],[tabindex],[class*="button" i],[class*="btn" i]'))
                .filter(isVisible)
                .map((el) => ({ el, label: normalize(textOf(el)), rootText: overlayText(root) }))
        );
        const preferred = controls.find((item) =>
            /^(принять|accept|agree|ok|ок|понятно|хорошо|закрыть|close|skip|later|не сейчас|нет спасибо|no thanks)$/iu.test(item.label)
        ) || controls.find((item) =>
            /(cookie|куки|consent|соглас|подписк|newsletter|уведомлен|notification|геолокац|location|реклам|adblock)/iu.test(item.rootText) &&
            /(принять|accept|agree|ok|ок|хорошо|понятно|закрыть|close|later|skip|не сейчас|no thanks|нет)/iu.test(item.label)
        ) || controls.find((item) =>
            /^(×|x|✕|× close|close|закрыть)$/iu.test(item.label)
        );

        if (!preferred) return '';
        (preferred.el as HTMLElement).click();
        return textOf(preferred.el).slice(0, 120);
    });

    const forceHideTechnicalOverlays = async (): Promise<number> => page.evaluate(() => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const technicalPattern = /(cookie|cookies|куки|файл(?:ов|ы)?\s+cookie|consent|соглас|newsletter|подписк|уведомлен|notification|геолокац|location|adblock)/iu;
        const highImpactPattern = /(оплат|платеж|платёж|покупк|заказ|бронир|брон[ьи]|заявк|регистрац|паспорт|документ|удал|delete|confirm\s+order|submit\s+order)/iu;
        const selectorRoots = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog',
            '[class*="modal" i]',
            '[class*="popup" i]',
            '[class*="overlay" i]',
            '[class*="cookie" i]',
            '[class*="consent" i]',
            '[id*="cookie" i]',
            '[id*="consent" i]',
            '[class*="notification" i]',
            '[id*="notification" i]',
        ].join(','))).filter(isVisible);
        const textRoots = Array.from(document.querySelectorAll('body *'))
            .filter((el, index) => index < 2500 && isVisible(el))
            .map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                    el,
                    text: normalize((el as HTMLElement).innerText || el.textContent || ''),
                    area: rect.width * rect.height,
                    fixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
                };
            })
            .filter((item) =>
                technicalPattern.test(item.text) &&
                !highImpactPattern.test(item.text) &&
                item.el !== document.body &&
                item.el !== document.documentElement &&
                item.text.length < 1200 &&
                (item.fixed || item.area < window.innerWidth * window.innerHeight * 0.6)
            )
            .sort((a, b) => a.area - b.area)
            .map((item) => item.el)
            .slice(0, 8);
        const roots = [...selectorRoots, ...textRoots]
            .filter((el, index, arr) => arr.indexOf(el) === index);
        let hidden = 0;
        for (const root of roots) {
            const text = normalize((root as HTMLElement).innerText || root.textContent || '');
            if (!technicalPattern.test(text) || highImpactPattern.test(text)) continue;
            const htmlRoot = root as HTMLElement;
            htmlRoot.setAttribute('aria-hidden', 'true');
            htmlRoot.style.setProperty('display', 'none', 'important');
            htmlRoot.style.setProperty('visibility', 'hidden', 'important');
            htmlRoot.style.setProperty('pointer-events', 'none', 'important');
            hidden += 1;
        }
        return hidden;
    });

    const remainingTechnicalOverlayCount = async (): Promise<number> => page.evaluate(() => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const technicalPattern = /(cookie|cookies|куки|файл(?:ов|ы)?\s+cookie|consent|соглас|newsletter|подписк|уведомлен|notification|геолокац|location|adblock)/iu;
        const selectorRoots = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog',
            '[class*="modal" i]',
            '[class*="popup" i]',
            '[class*="overlay" i]',
            '[class*="cookie" i]',
            '[class*="consent" i]',
            '[id*="cookie" i]',
            '[id*="consent" i]',
            '[class*="notification" i]',
            '[id*="notification" i]',
        ].join(',')));
        const textRoots = Array.from(document.querySelectorAll('body *'))
            .filter((el, index) => index < 2500 && isVisible(el))
            .map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                    el,
                    text: normalize((el as HTMLElement).innerText || el.textContent || ''),
                    area: rect.width * rect.height,
                    fixed: ['fixed', 'sticky'].includes(window.getComputedStyle(el).position),
                };
            })
            .filter((item) =>
                technicalPattern.test(item.text) &&
                item.el !== document.body &&
                item.el !== document.documentElement &&
                item.text.length < 1200 &&
                (item.fixed || item.area < window.innerWidth * window.innerHeight * 0.6)
            )
            .map((item) => item.el);
        return [...selectorRoots, ...textRoots]
            .filter((el, index, arr) => arr.indexOf(el) === index)
            .filter((el) => isVisible(el) && technicalPattern.test(normalize((el as HTMLElement).innerText || el.textContent || ''))).length;
    });

    if (!clicked) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(250);
        const hidden = await forceHideTechnicalOverlays().catch(() => 0);
        return hidden
            ? `overlay-кнопка не найдена, техническое окно скрыто (${hidden})`
            : 'overlay-кнопка не найдена, нажата Escape';
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(350);
    const remaining = await remainingTechnicalOverlayCount().catch(() => 0);
    if (remaining > 0) {
        const hidden = await forceHideTechnicalOverlays().catch(() => 0);
        if (hidden > 0) return `нажата кнопка overlay: ${clicked}; оставшееся техническое окно скрыто (${hidden})`;
    }
    return `нажата кнопка overlay: ${clicked}`;
}

async function describeVisualControlTarget(page: Page, visualIndex: number): Promise<Record<string, unknown>> {
    return page.evaluate(({ selector, targetIndex }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const roleOf = (el: Element) => {
            const explicit = compact(el.getAttribute('role'));
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
            return tag;
        };
        const textOf = (el: Element) => compact(
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            (el as HTMLElement).innerText ||
            el.textContent ||
            Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('alt') || img.getAttribute('src')?.split('/').pop()).filter(Boolean).join(' ')
        );
        const isActionable = (el: Element) => {
            const tag = el.tagName.toLowerCase();
            const type = ((el as HTMLInputElement).type || '').toLowerCase();
            const role = roleOf(el).toLowerCase();
            const style = window.getComputedStyle(el);
            return tag === 'a' ||
                tag === 'button' ||
                (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) ||
                ['button', 'link', 'menuitem', 'tab'].includes(role) ||
                Boolean(el.getAttribute('onclick')) ||
                style.cursor === 'pointer';
        };
        const controls = Array.from(document.querySelectorAll(selector))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el) && isActionable(el));
        const el = controls[targetIndex] as HTMLElement | undefined;
        if (!el) return { action: 'click', selector: `visual=${targetIndex + 1}`, locatorCount: 0 };
        const rect = el.getBoundingClientRect();
        const anchor = el instanceof HTMLAnchorElement ? el : el.closest('a');
        return {
            action: 'click',
            selector: `visual=${targetIndex + 1}`,
            locatorCount: 1,
            visible: true,
            tag: el.tagName.toLowerCase(),
            role: roleOf(el),
            text: textOf(el).slice(0, 220),
            href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
            rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        };
    }, { selector: CLICKABLE_CONTROL_SELECTOR, targetIndex: visualIndex }).catch((err) => ({
        action: 'click',
        selector: `visual=${visualIndex + 1}`,
        targetError: safeErrorMessage(err),
    }));
}

async function describeActionTarget(page: Page, decision: BrowserAction): Promise<Record<string, unknown>> {
    const selector = actionTargetSelector(decision);
    if (!selector || !['click', 'fill', 'fill_credential', 'select_option', 'check', 'uncheck', 'hover'].includes(decision.action)) {
        return { action: decision.action };
    }

    const visualMatch = selector.match(/^visual=(\d{1,3})$/i);
    if (decision.action === 'click' && visualMatch) {
        return describeVisualControlTarget(page, Math.max(0, Number(visualMatch[1]) - 1));
    }

    const locators = buildLocators(page, selector).slice(0, 5);
    const hrefFromSelector = hrefFromCandidateSelector(selector, page.url());
    for (let locatorIndex = 0; locatorIndex < locators.length; locatorIndex += 1) {
        const locator = locators[locatorIndex];
        const count = await locator.count().catch(() => -1);
        if (count <= 0) continue;

        const first = locator.first();
        const visible = await first.isVisible().catch(() => false);
        const targetInfo = await first.evaluate((el) => {
            const compact = (value: string | null | undefined) =>
                String(value ?? '').replace(/\s+/g, ' ').trim();
            const rect = (el as HTMLElement).getBoundingClientRect();
            const anchor = el instanceof HTMLAnchorElement ? el : el.closest('a');
            return {
                tag: el.tagName.toLowerCase(),
                text: compact((el as HTMLElement).innerText || el.textContent || (el as HTMLInputElement).value).slice(0, 220),
                href: anchor instanceof HTMLAnchorElement ? anchor.href : '',
                rect: `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
            };
        }).catch(() => ({ tag: '', text: '', href: '', rect: '' }));

        return {
            action: decision.action,
            selector: selector.slice(0, 220),
            hrefFromSelector: hrefFromSelector ? safeLogUrl(hrefFromSelector) : undefined,
            locatorIndex,
            locatorCount: count,
            visible,
            tag: targetInfo.tag,
            text: targetInfo.text,
            href: targetInfo.href ? safeLogUrl(targetInfo.href) : undefined,
            rect: targetInfo.rect,
        };
    }

    return {
        action: decision.action,
        selector: selector.slice(0, 220),
        hrefFromSelector: hrefFromSelector ? safeLogUrl(hrefFromSelector) : undefined,
        locatorVariants: locators.length,
        locatorCount: 0,
    };
}

async function doAction(page: Page, decision: BrowserAction, credentials: CredentialMaterial | null, state?: BrowserRunState): Promise<string | void> {
    const sel = decision.selector ?? '';
    const val = decision.value ?? '';
    const targetSelector = actionTargetSelector(decision);

    switch (decision.action) {
        case 'navigate': {
            await gotoBrowserPage(page, val);
            if (state) await recoverFromBlockedBrowserNavigation(state, 'navigate');
            break;
        }
        case 'click': {
            const beforeUrl = page.url();
            const hrefFallback = hrefFromCandidateSelector(targetSelector, beforeUrl);
            const visualMatch = targetSelector.match(/^visual=(\d{1,3})$/i);
            if (visualMatch) {
                await clickVisualControlByIndex(page, Math.max(0, Number(visualMatch[1]) - 1));
            } else {
                await tryLocators(page, targetSelector, (locator) => clickLocatorLikeUser(page, locator));
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            const afterUrl = page.url();
            if (hrefFallback && !urlsEquivalent(hrefFallback, beforeUrl) && urlsEquivalent(afterUrl, beforeUrl)) {
                browserLog('click_href_fallback', {
                    beforeUrl: safeLogUrl(beforeUrl),
                    href: safeLogUrl(hrefFallback),
                    selector: targetSelector.slice(0, 180),
                });
                await gotoBrowserPage(page, hrefFallback);
            }
            if (state) await recoverFromBlockedBrowserNavigation(state, 'click');
            break;
        }
        case 'switch_tab': {
            if (!state) throw new Error('Нет состояния браузера для переключения вкладки');
            return await switchBrowserTab(state, val || sel);
        }
        case 'close_tab': {
            if (!state) throw new Error('Нет состояния браузера для закрытия вкладки');
            return await closeBrowserTab(state, val || sel);
        }
        case 'dismiss_overlays': {
            return await dismissOverlays(page);
        }
        case 'save_page_pdf': {
            if (!state) throw new Error('Нет состояния браузера для сохранения PDF');
            return `сохранён PDF: ${await saveCurrentPagePdf(state, val || sel || undefined)}`;
        }
        case 'save_screenshot': {
            if (!state) throw new Error('Нет состояния браузера для сохранения скриншота');
            return `сохранён скриншот: ${await saveCurrentScreenshot(state, val || sel || undefined)}`;
        }
        case 'fill': {
            let confirmedValue = '';
            await tryLocators(page, sel, async (locator) => {
                confirmedValue = await reliableFillLocator(page, locator, val);
            });
            return `Поле заполнено и проверено: ${redactSecrets(confirmedValue || val).slice(0, 120)}`;
        }
        case 'fill_credential': {
            const secretValue = credentialValue(credentials, val);
            if (!secretValue) throw new Error(`Нет сохранённого значения для ${val || 'credential'}`);
            await tryLocators(page, sel, async (locator) => {
                await reliableFillLocator(page, locator, secretValue);
            });
            return `Поле учётных данных заполнено и проверено: ${val || 'credential'}`;
        }
        case 'type': {
            await page.keyboard.type(val, { delay: 35 });
            break;
        }
        case 'press_key': {
            await page.keyboard.press(val || 'Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
            if (state) await recoverFromBlockedBrowserNavigation(state, 'press_key');
            break;
        }
        case 'select_option': {
            let selectedValue = '';
            await tryLocators(page, sel, async (locator) => {
                selectedValue = await reliableSelectElement(locator.first(), val);
            });
            return `Выбран вариант и проверено значение: ${redactSecrets(selectedValue || val).slice(0, 120)}`;
        }
        case 'select_date': {
            const dateValue = val || decision.summary || decision.comment || '';
            return await selectDateOnPage(page, dateValue, sel || undefined);
        }
        case 'check': {
            await tryLocators(page, sel, (locator) => locator.check({ timeout: ACTION_TIMEOUT_MS }));
            break;
        }
        case 'uncheck': {
            await tryLocators(page, sel, (locator) => locator.uncheck({ timeout: ACTION_TIMEOUT_MS }));
            break;
        }
        case 'hover': {
            await tryLocators(page, targetSelector, (locator) => locator.hover({ timeout: ACTION_TIMEOUT_MS }));
            await page.waitForTimeout(400);
            break;
        }
        case 'scroll': {
            const dy = val === 'up' ? -700 : 700;
            await page.evaluate((d: number) => window.scrollBy(0, d), dy);
            await page.waitForTimeout(300);
            break;
        }
        case 'wait': {
            return await executeSmartWait(page, decision);
        }
        case 'go_back': {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }).catch(() => {});
            break;
        }
    }
}

interface BrowserWaitCondition {
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
}

function normalizeWaitLoadState(value?: string): BrowserWaitCondition['loadState'] | undefined {
    const normalized = cleanWhitespace(value || '').toLowerCase();
    if (normalized === 'load' || normalized === 'domcontentloaded' || normalized === 'networkidle') {
        return normalized;
    }
    return undefined;
}

function parseBrowserWaitCondition(decision: BrowserAction): BrowserWaitCondition {
    const raw = cleanWhitespace([decision.value, decision.summary, decision.comment].filter(Boolean).join(' '));
    const condition: BrowserWaitCondition = {};
    if (decision.selector) condition.selector = decision.selector;

    const pairRe = /\b(textGone|text_gone|gone|text|selector|css|url|loadState|load_state|load|timeMs|timeoutMs|ms|time)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;,\n]+))/giu;
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(raw))) {
        const key = match[1].toLowerCase();
        const value = cleanWhitespace(match[2] || match[3] || match[4] || '');
        if (!value) continue;
        if (key === 'textgone' || key === 'text_gone' || key === 'gone') condition.textGone = value;
        else if (key === 'text') condition.text = value;
        else if (key === 'selector' || key === 'css') condition.selector = key === 'css' && !/^css=/iu.test(value) ? `css=${value}` : value;
        else if (key === 'url') condition.url = value;
        else if (key === 'loadstate' || key === 'load_state' || key === 'load') condition.loadState = normalizeWaitLoadState(value);
        else if (key === 'timems' || key === 'timeoutms' || key === 'ms' || key === 'time') {
            const numeric = Number(value.replace(/[^\d.]/g, ''));
            if (Number.isFinite(numeric) && numeric > 0) {
                condition.timeMs = Math.max(100, Math.min(30_000, Math.floor(numeric)));
            }
        }
    }

    if (!condition.text && !condition.textGone && !condition.selector && !condition.url && raw && !/=/.test(raw)) {
        condition.text = raw;
    }
    return condition;
}

async function waitForBrowserSelector(page: Page, selector: string, timeoutMs: number): Promise<void> {
    const locators = buildLocators(page, selector);
    let lastError: unknown;
    for (const locator of locators) {
        try {
            await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError ?? new Error(`Не дождалась selector: ${selector}`);
}

async function waitForBrowserUrl(page: Page, pattern: string, timeoutMs: number): Promise<void> {
    const normalizedPattern = cleanWhitespace(pattern);
    if (!normalizedPattern) return;
    await page.waitForURL((url) => {
        const current = url.toString();
        if (normalizedPattern.includes('*')) {
            const re = new RegExp(`^${escapeRegExp(normalizedPattern).replace(/\\\*/g, '.*')}$`, 'iu');
            return re.test(current);
        }
        return current.includes(normalizedPattern);
    }, { timeout: timeoutMs });
}

async function executeSmartWait(page: Page, decision: BrowserAction): Promise<string> {
    const condition = parseBrowserWaitCondition(decision);
    const timeoutMs = Math.max(500, Math.min(ACTION_TIMEOUT_MS, condition.timeMs || ACTION_TIMEOUT_MS));
    const waitedFor: string[] = [];

    if (condition.loadState) {
        await page.waitForLoadState(condition.loadState, { timeout: timeoutMs }).catch(() => {});
        waitedFor.push(`loadState=${condition.loadState}`);
    }
    if (condition.selector) {
        await waitForBrowserSelector(page, condition.selector, timeoutMs);
        waitedFor.push(`selector=${condition.selector.slice(0, 120)}`);
    }
    if (condition.text) {
        await page.getByText(condition.text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
        waitedFor.push(`text="${condition.text.slice(0, 120)}"`);
    }
    if (condition.textGone) {
        await page.getByText(condition.textGone, { exact: false }).first().waitFor({ state: 'hidden', timeout: timeoutMs });
        waitedFor.push(`textGone="${condition.textGone.slice(0, 120)}"`);
    }
    if (condition.url) {
        await waitForBrowserUrl(page, condition.url, timeoutMs);
        waitedFor.push(`url=${condition.url.slice(0, 120)}`);
    }
    if (!waitedFor.length) {
        await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
        await page.waitForTimeout(Math.min(condition.timeMs || 700, 2000));
        waitedFor.push('networkidle/time');
    } else if (condition.timeMs) {
        await page.waitForTimeout(Math.min(condition.timeMs, 2000));
    }

    return `Дождалась условия: ${waitedFor.join(', ')}`;
}

interface BrowserLaunchResources {
    browser: Browser;
    browserCtx: BrowserContext;
    page: Page;
    persistentProfile: boolean;
    profileDir?: string;
}

async function createBrowserLaunchResources(userId: number, chatId?: number): Promise<BrowserLaunchResources> {
    const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    const launchOptions = {
        headless: browserHeadlessMode(),
        executablePath: chromiumExecutablePath || undefined,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=site-per-process',
            '--window-size=1365,900',
        ],
    };
    const contextOptions = {
        viewport: { width: 1365, height: 900 },
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        permissions: [],
        acceptDownloads: true,
    };

    if (persistentBrowserProfileEnabled()) {
        const profileDir = browserProfileDirForRun(userId, chatId);
        fs.mkdirSync(profileDir, { recursive: true });
        const browserCtx = await chromium.launchPersistentContext(profileDir, {
            ...launchOptions,
            ...contextOptions,
        });
        await installBrowserContextDefaults(browserCtx);
        const browser = browserCtx.browser();
        if (!browser) {
            await browserCtx.close().catch(() => {});
            throw new Error('Не удалось получить Browser для persistent profile.');
        }
        const page = browserCtx.pages().find((candidate) => !candidate.isClosed()) ?? await browserCtx.newPage();
        installBrowserPageDefaults(page);
        return { browser, browserCtx, page, persistentProfile: true, profileDir };
    }

    const browser = await chromium.launch(launchOptions);
    const browserCtx = await browser.newContext(contextOptions);
    await installBrowserContextDefaults(browserCtx);
    const page = await browserCtx.newPage();
    installBrowserPageDefaults(page);
    return { browser, browserCtx, page, persistentProfile: false };
}

async function installBrowserContextDefaults(browserCtx: BrowserContext): Promise<void> {
    await browserCtx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    }).catch(() => {});
    browserCtx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    browserCtx.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

function installBrowserPageDefaults(page: Page): void {
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

async function createBrowserRun(
    ctx: BotContext,
    userId: number,
    originalTask: string,
    memoryContext?: string,
    recentUserContext?: string
): Promise<BrowserRunState> {
    const {
        browser,
        browserCtx,
        page,
        persistentProfile,
        profileDir,
    } = await createBrowserLaunchResources(userId, ctx.chat?.id);

    const explicitSavedCreds = BrowserCredentialService.parseAndSave(userId, originalTask);
    const credentialCandidates = [
        ...extractCredentialCandidatesFromText(originalTask, 'user'),
        ...extractCredentialCandidatesFromText(memoryContext, 'memory'),
    ];
    if (explicitSavedCreds) {
        const saved = BrowserCredentialService.get(userId, explicitSavedCreds.domain);
        if (saved) {
            credentialCandidates.unshift({
                source: 'saved',
                domain: explicitSavedCreds.domain,
                login: saved.login,
                password: saved.password,
            });
        }
    }
    const memoryCredentials =
        explicitSavedCreds
            ? { source: 'saved' as const, domain: explicitSavedCreds.domain, login: explicitSavedCreds.login, password: BrowserCredentialService.get(userId, explicitSavedCreds.domain)?.password }
            : chooseCredentialCandidate(credentialCandidates) ?? null;
    const state: BrowserRunState = {
        id: randomUUID(),
        userId,
        chatId: ctx.chat?.id,
        browser,
        browserCtx,
        persistentProfile,
        profileDir,
        page,
        originalTask,
        memoryContext,
        recentUserContext,
        memoryCredentials,
        credentialCandidates,
        activeCredentials: memoryCredentials,
        history: [],
        notes: [],
        memoryLookupQueries: [],
        pageEvents: [],
        networkSnippets: [],
        evidenceStash: [],
        visibleListingItems: [],
        formAutofillAttempts: [],
        loopCheckpointSignatures: [],
        downloads: [],
        dialogs: [],
        armedDialogResponse: undefined,
        lastComment: '',
        lastUserAnswer: '',
        lastScreenshotDomain: '',
        lastCredentialDomain: '',
        sessionSavedForDomain: '',
        followUpOriginDomain: '',
        iterationCount: 0,
        consecutiveActionFailures: 0,
        highImpactConfirmed: false,
        taskContract: undefined,
        taskContractSource: undefined,
        lastUnderstandingUrl: '',
        lastUnderstandingIteration: -1,
        pendingBookingMemorySnapshot: undefined,
        confirmedBookingMemorySnapshot: undefined,
        rejectedBookingMemorySnapshots: [],
        cancelRequested: false,
        cancelAcknowledged: false,
        expiresAt: Date.now() + PENDING_BROWSER_TTL_MS,
    };
    state.trajectory = createBrowserTrajectoryRecorder(state);
    recordBrowserTrajectoryEvent(state, 'lifecycle.start', {
        originalTask: originalTask.slice(0, 1200),
        memoryContextChars: memoryContext?.length ?? 0,
        recentUserContextChars: recentUserContext?.length ?? 0,
        credentialCandidates: credentialCandidates.length,
        persistentProfile,
        profileKey: profileDir ? path.basename(profileDir) : undefined,
    });
    attachPageObservers(state);
    registerActiveBrowserRun(ctx, state);
    return state;
}

function buildResumedTask(state: BrowserRunState, message: string, answer?: string): string {
    const userAnswer = answer || browserTaskAnswerFromMessage(message) || message;
    return [
        state.originalTask,
        '',
        `Ответ пользователя: ${userAnswer || '(ответ не распознан)'}`,
        'Используй ответ как уточнение пользователя для продолжения браузерной задачи.',
    ].join('\n');
}

function shouldBlockGuessedFollowUpNavigation(state: BrowserRunState, decision: BrowserAction): string | null {
    if (!state.followUpOriginDomain || decision.action !== 'navigate') return null;
    const targetDomain = extractDomain(decision.value || '');
    if (!targetDomain || domainsCompatible(targetDomain, state.followUpOriginDomain)) return null;

    const currentDomain = extractDomain(state.page.url());
    if (!domainsCompatible(currentDomain, state.followUpOriginDomain)) return null;

    const hasMeaningfulPageAction = state.history.some((record) =>
        record.result === 'ok' &&
        !record.label.startsWith('restore_previous_url') &&
        !record.label.startsWith('memory_lookup') &&
        record.label !== 'note'
    );
    if (hasMeaningfulPageAction) return null;

    return `Follow-up восстановлен на ${state.followUpOriginDomain}; первый переход на внешний домен ${targetDomain} выглядит как догадка. Выбери действие на текущей странице по selector/context/href.`;
}

function shouldBlockMisdirectedShoppingTarget(task: string, decision: BrowserAction, target: Record<string, unknown>): string | null {
    if (decision.action !== 'click' && decision.action !== 'navigate') return null;

    const taskText = normalizeSearchText(task);
    const decisionText = normalizeSearchText([
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
    ].filter(Boolean).join(' '));
    const href = String(target.href || target.hrefFromSelector || decision.value || '');
    const targetText = normalizeSearchText(String(target.text || ''));
    const targetSurface = [targetText, decisionText, href].join(' ');
    const constraints = shoppingIntentConstraints(task);

    const isBrowseOrFilterTask = /(найди|подбери|посмотри|выбери|ищу|поиск|фильтр|размер|плать|одеж|обув|товар|find|search|browse|filter|size|dress|clothes|shoes)/iu
        .test(taskText);
    const userWantsCheckout = /(купить|покуп|заказ|оформ|корзин|оплат|checkout|cart|buy|purchase|order|payment)/iu
        .test(taskText);
    if (!isBrowseOrFilterTask || userWantsCheckout) return null;

    const hrefIsCheckoutOrAuth = /\/checkout(?:\/|$)|\/cart(?:\/|$)|\/basket(?:\/|$)|\/login(?:\/|$)|\/auth(?:\/|$)|\/customer\/account/iu
        .test(href);
    const targetLooksCheckoutOrAuth = /^(?:корзина|войти|логин|login|cart|basket|checkout)$/iu.test(targetText);
    const decisionExpectedCatalogAction = /(фильтр|размер|категор|раздел|плать|одеж|обув|найти|поиск|выбер|перехож|filter|size|category|dress|search|browse)/iu
        .test(decisionText);

    if (hrefIsCheckoutOrAuth || (targetLooksCheckoutOrAuth && decisionExpectedCatalogAction)) {
        return [
            'Клик ведет в корзину/логин/checkout, но задача сейчас про поиск или фильтрацию товара.',
            'Не нажимай иконки корзины/входа как фильтр: выбери видимый фильтр, категорию или товарный блок на текущей странице.',
        ].join(' ');
    }

    if (constraints.needsLight && hasDarkColorConflict(targetSurface) && /(выбира|подбира|беру|подходит|карточк|товар|брюк|футболк|рубашк|поло|shirt|pants|trousers)/iu.test(decisionText)) {
        return [
            'Пользователь просит светлые вещи, а выбранная цель/обоснование содержит тёмный цвет.',
            'Не выбирай тёмные товары для светлого комплекта: используй фильтр цвета, поиск по светлым оттенкам или открой другую карточку.',
        ].join(' ');
    }

    const productChoiceIntent =
        /(выбира[ею]|подбира[ею]|открыва[ею]|смотр[юи]|добавля[ею]|бер[еу]|подходит|подходящ)/iu.test(decisionText) &&
        /(товар|карточк|вариант|комплект|образ|позици|модель|product|item|card|variant|option|offer|listing)/iu.test(decisionText) &&
        !/(категор|раздел|меню|фильтр|сортиров|поиск|перехож|перейти|navigate|category|section|menu|filter|sort|search)/iu.test(decisionText);
    const targetLooksTopNavigation =
        /(?:[?&]sitelink=topmenu|\/(?:men|women)-home(?:\/|$)|\/(?:category|catalog|collections?)(?:\/|$))/iu.test(href) ||
        /^(?:идеи|новинки|одежда|обувь|аксессуары|бренды|премиум|спорт|красота|дом|скидки|женщинам|мужчинам|детям)$/iu.test(targetText);

    if (productChoiceIntent && targetLooksTopNavigation) {
        return [
            'Клик должен выбрать конкретный товар/карточку, но фактическая цель находится в верхнем меню каталога.',
            'Не используй индексный selector для товара: найди товарную карточку в structure/affordance graph по названию, бренду, цене или href и нажми ссылку внутри этой карточки.',
        ].join(' ');
    }

    return null;
}

function isShoppingBrowseTask(task: string): boolean {
    const text = normalizeSearchText(task);
    const shoppingDomain =
        /(комплект|образ|лук|одеж|обув|товар|вещ[ьи]|бренд|размер|цвет|материал|магазин|каталог|маркетплейс|корзин|заказ|купить|покуп|clothes|shoes|outfit|look|product|item|store|shop|catalog|marketplace|cart|checkout|buy|purchase|order)/iu.test(text);
    const browseIntent =
        /(подбери|найди|выбери|посмотри|ищу|порекомендуй|сравни|browse|find|pick|choose|select|recommend|compare)/iu.test(text);
    return shoppingDomain && browseIntent;
}

function isEvidenceDrivenSelectionTask(task: string): boolean {
    const text = normalizeSearchText(task);
    const asksToChooseOrResearch = /(подбери|найди|выбери|посмотри|порекомендуй|сравни|составь|изучи|проверь|оцени|вариант|варианты|лучши|подходящ|комплект|список|research|find|search|pick|choose|select|recommend|compare|shortlist|suggest)/iu.test(text);
    const needsConcreteOutput = /(ссылк|url|адрес|цен|дат|врем|мест|отзыв|рейтинг|услов|характерист|цвет|размер|материал|документ|файл|таблиц|товар|услуг|ресторан|отел|билет|рейс|ваканс|квартир|машин|курс|article|product|service|hotel|restaurant|ticket|flight|job|document|price|link)/iu.test(text);
    return asksToChooseOrResearch || needsConcreteOutput;
}

function taskExecutionRubricForPrompt(task: string): string {
    if (!isEvidenceDrivenSelectionTask(task)) {
        return 'Обычная браузерная задача: завершай только при видимом подтверждении, сохранённом файле, отправленной форме или другом проверяемом результате.';
    }
    const taskText = normalizeSearchText(task);
    const likelyCatalog = /(товар|магазин|каталог|одеж|обув|техник|маркет|цена|product|shop|store|catalog|marketplace)/iu.test(taskText);
    const likelyLocalChoice = /(ресторан|кафе|бар|отел|гостиниц|место|адрес|рядом|район|restaurant|hotel|place|near)/iu.test(taskText);
    const likelyTimedChoice = /(билет|рейс|поезд|мероприят|сеанс|дата|время|слот|ticket|flight|train|event|showtime|date|time)/iu.test(taskText);
    const likelyDocumentResearch = /(документ|отчет|отчёт|таблиц|статья|новост|исслед|pdf|document|report|article|paper|spreadsheet)/iu.test(taskText);
    const domainHints = [
        likelyCatalog ? 'Каталог/товары: проверь свойства карточек, цену, наличие, варианты, прямые ссылки и соответствие каждому критерию.' : '',
        likelyLocalChoice ? 'Места/услуги: проверь адрес/район, рейтинг/отзывы, часы работы, цену/условия и ссылку на источник.' : '',
        likelyTimedChoice ? 'Билеты/слоты/расписание: проверь дату, время, место/маршрут, цену, доступность и ссылку.' : '',
        likelyDocumentResearch ? 'Документы/исследование: проверь источник, дату, ключевые факты, цитируемые поля/таблицы и ссылку/файл.' : '',
    ].filter(Boolean);
    return [
        'Evidence-driven задача: сначала извлеки критерии пользователя, затем собери факты по каждому критерию и только потом заверши.',
        'Нельзя считать успехом навигацию к списку результатов. Нужны конкретные выбранные варианты или проверенный вывод.',
        'Проверь несколько кандидатов, если на странице есть выбор. Отбрасывай варианты, которые противоречат ограничениям пользователя.',
        'В done укажи для каждого варианта: название, ключевые свойства по критериям, источник/URL и короткую причину выбора.',
        ...domainHints,
    ].join('\n');
}

function explorationSummaryForPrompt(state: BrowserRunState | undefined, observation?: PageObservation): string {
    if (!state) return '(нет состояния исследования)';
    const recent = state.history.slice(-18);
    const count = (predicate: (record: ActionRecord) => boolean) => recent.filter(predicate).length;
    const labels = recent.map((record) => record.label).join('\n');
    const summary = [
        `actions=${recent.length}`,
        `navigate=${count((record) => record.label.startsWith('navigate'))}`,
        `click=${count((record) => record.label.startsWith('click'))}`,
        `scroll=${count((record) => record.label.startsWith('scroll'))}`,
        `find_on_page=${count((record) => record.label.startsWith('find_on_page'))}`,
        `site_search=${count((record) => record.label.startsWith('site_search'))}`,
        `filters_or_sort=${/(filter|фильтр|sort|сорт|select_option|check|uncheck|примен)/iu.test(labels)}`,
        `evidence=${state.evidenceStash.length}`,
        `network=${state.networkSnippets.length}`,
    ].join('; ');
    const scroll = observation?.scrollDiagnosticsText ? `\n${observation.scrollDiagnosticsText}` : '';
    return `${summary}${scroll}`;
}

function universalCompletionBlockReason(
    task: string,
    summary: string,
    state: BrowserRunState,
    observation: PageObservation
): string | null {
    if (!isEvidenceDrivenSelectionTask(task)) return null;
    const surface = cleanWhitespace(summary || '');
    const taskText = normalizeSearchText(task);
    const summaryText = normalizeSearchText(surface);
    if (!surface) return 'Итог пустой: для такой задачи нужен проверенный результат по критериям пользователя.';
    if (isListingOnlyShoppingSuccessText(surface) || /(переш[её]л[аи]?|открыл[аи]?|вижу|видн[ыо]|страниц[аеы]\s+(?:поиск|каталог|список|результат)|opened|navigated|visible results?)/iu.test(summaryText)) {
        return 'Навигация к списку или факт видимых результатов не выполняют задачу. Нужно выбрать/проверить конкретные варианты или дать проверенный вывод.';
    }
    if (taskExplicitlyRequestsLinks(task) && !textHasUrl(surface)) {
        return 'Пользователь просит ссылки/URL, но итог не содержит ссылок на источники или карточки.';
    }
    const asksForChoice = /(подбери|выбери|порекомендуй|сравни|вариант|лучши|подходящ|recommend|compare|pick|choose|shortlist|suggest)/iu.test(taskText);
    const hasConcreteFact = textHasUrl(surface) ||
        /\b\d[\d\s.,:/-]*(?:₽|руб|₸|\$|€|%|км|мин|час|дн|м²|м2)?\b/iu.test(surface) ||
        /(адрес|цена|дата|время|рейтинг|отзыв|материал|цвет|размер|налич|url|ссылка|source|источник)/iu.test(summaryText);
    const explainsChoice = /(подходит|потому|так как|за сч[её]т|причин|рекоменд|лучше|выбран|соответств|because|reason|fits|matches)/iu.test(summaryText);
    if (asksForChoice && (!hasConcreteFact || !explainsChoice)) {
        return 'Для подбора/сравнения итог должен содержать конкретные факты по вариантам и объяснение, почему они подходят критериям пользователя.';
    }
    const explored = state.history.some((record) =>
        /(?:site_search|find_on_page|scroll|click|select_option|check|uncheck|filter|sort|поиск|фильтр|сорт)/iu.test(record.label)
    );
    const hasMorePage = /canScrollDown=true/iu.test(observation.scrollDiagnosticsText || '');
    if (asksForChoice && hasMorePage && !explored && state.evidenceStash.length < 2) {
        return 'Страница ещё не исследована: есть контент ниже, но агент не использовал поиск, фильтры, скролл или открытие деталей перед итогом.';
    }
    return null;
}

function taskExplicitlyRequestsLinks(task: string): boolean {
    const text = normalizeSearchText(task);
    return /(ссылк|url|link|линк|пришли\s+ссыл|скинь\s+ссыл|дай\s+ссыл|source|источник)/iu.test(text);
}

function userWantsShoppingCheckout(task: string): boolean {
    const text = normalizeSearchText(task);
    return /(купи|купить|покуп|добавь\s+в\s+корзин|корзин|оформи|заказ|оплат|checkout|cart|buy|purchase|order|payment)/iu.test(text);
}

interface ShoppingIntentConstraints {
    outfit: boolean;
    needsTop: boolean;
    needsBottom: boolean;
    needsLight: boolean;
    needsSummerLight: boolean;
    needsStyleRationale: boolean;
    needsCompatibility: boolean;
}

function shoppingIntentConstraints(task: string): ShoppingIntentConstraints {
    const text = normalizeSearchText(task);
    const outfit = /(комплект|образ|лук|outfit|look|верх\s+и\s+низ|верх.*низ|низ.*верх|сочетал|подходил|подходили\s+друг\s+другу)/iu.test(text);
    return {
        outfit,
        needsTop: outfit || /(верх|футболк|поло|рубашк|сорочк|лонгслив|майк|джемпер|свитшот|худи|пиджак|куртк|shirt|top|polo)/iu.test(text),
        needsBottom: outfit || /(низ|брюк|чинос|джинс|шорт|trousers|pants|chinos|jeans|shorts)/iu.test(text),
        needsLight: /(светл|бел|молочн|айвори|ivory|кремов|беж|песочн|пастел|light|white|beige|cream|ecru)/iu.test(text),
        needsSummerLight: /(летн|лето|л[её]гк|дышащ|жарк|linen|л[её]н|хлопок|cotton|summer|lightweight)/iu.test(text),
        needsStyleRationale: /(итальян|стил|relaxed|расслаблен|smart\s*casual|old\s*money|минимал|mediterranean)/iu.test(text),
        needsCompatibility: outfit || /(подходил[и]?|сочетал[и]?|комбинировал|гармони|вместе|друг\s+другу|compatible|match)/iu.test(text),
    };
}

function taskRequiresProductLinks(task: string): boolean {
    const text = normalizeSearchText(task);
    return /(ссылк|url|link|линк|пришли|скинь|дай|заказ|заказать|купить|покуп|на\s+сайте|сайт|интернет[-\s]?магазин|marketplace|маркетплейс)/iu.test(text);
}

function textHasUrl(text: string): boolean {
    return /https?:\/\/[^\s<>)"']{6,}/iu.test(text);
}

function textHasProductUrl(text: string): boolean {
    return /https?:\/\/[^\s<>)"']*(?:\/p\/|\/product(?:s)?\/|\/item\/)[^\s<>)"']*/iu.test(text);
}

function countProductUrls(text: string): number {
    return (text.match(/https?:\/\/[^\s<>)"']*(?:\/p\/|\/product(?:s)?\/|\/item\/)[^\s<>)"']*/giu) || []).length;
}

function hasConcreteShoppingSelection(text: string): boolean {
    const normalized = normalizeSearchText(text);
    const hasClothesTerm = /(костюм|комплект|образ|рубашк|сорочк|поло|футболк|лонгслив|брюк|джинс|чинос|шорт|пиджак|жилет|кардиган|джемпер|свитер|свитшот|худи|куртк|ветровк|бомбер|туфл|лофер|ботинк|кроссов|кед|плать|юбк|блуз|пальто|accessor|shirt|pants|trousers|jacket|cardigan|shoes|sneakers|suit|outfit)/iu.test(normalized);
    const hasSpecificity = /(?:\b[A-Z][A-Za-z0-9' -]{2,}\b|name=|brand=|\b\d[\d\s\u00a0]{1,9}\s*(?:₽|руб|₸|\$|€)|https?:\/\/)/iu.test(text);
    const hasChoiceLanguage = /(подобран|выбран|рекоменд|итогов|подойдут|вариант|комплект|образ|сочетан)/iu.test(normalized);
    return hasClothesTerm && (hasSpecificity || hasChoiceLanguage || textHasProductUrl(text));
}

function isListingOnlyShoppingSuccessText(text: string): boolean {
    const normalized = normalizeSearchText(text);
    return /(successfully\s+navigated|visible\s+products|brand\s+page|listing|category\s+page|catalog|переш[её]л[аи]?\s+на\s+страниц|страниц[аеы]\s+бренд|страниц[аеы]\s+каталог|каталог|видн[ыо]\s+товар|товары\s+видны|открыт[аы]?\s+страниц)/iu.test(normalized);
}

function hasShoppingTopEvidence(text: string): boolean {
    return /(верх|футболк|поло|рубашк|сорочк|лонгслив|майк|топ|джемпер|свитшот|худи|пиджак|куртк|shirt|t-shirt|tee|polo|top)/iu.test(text);
}

function hasShoppingBottomEvidence(text: string): boolean {
    return /(низ|брюк|чинос|джинс|шорт|trousers|pants|chinos|jeans|shorts|slacks)/iu.test(text);
}

function hasLightColorEvidence(text: string): boolean {
    return /(светл|бел|молочн|айвори|ivory|кремов|экрю|ecru|беж|песочн|пастел|голуб|светло[-\s]?(?:сер|син|зелен|корич)|light|white|beige|cream|sand|stone|off[-\s]?white|khaki)/iu.test(text);
}

function hasDarkColorConflict(text: string): boolean {
    return /(черн|ч[её]рн|black|т[её]мно[-\s]?(?:син|сер|зелен|корич)|темн|dark|navy|графит|антрацит|charcoal)/iu.test(text);
}

function hasSummerMaterialEvidence(text: string): boolean {
    return /(л[её]гк|летн|дышащ|тонк|лен\b|лён|льнян|хлопок|cotton|linen|viscose|вискоз|relaxed|свободн|oversize|summer|lightweight)/iu.test(text);
}

function hasStyleRationaleEvidence(text: string): boolean {
    return /(итальян|средиземномор|mediterranean|relaxed|расслаблен|smart\s*casual|casual|чинос|поло|рубашк|лен|лён|лофер|минимал|нейтральн|палитр|силуэт|посадк|стил)/iu.test(text);
}

function hasCompatibilityEvidence(text: string): boolean {
    return /(сочет|подход[яи]|гармони|комплект|образ|палитр|нейтральн|единый\s+стил|вместе|compatible|match|pair)/iu.test(text);
}

function shoppingCompletionBlockReason(task: string, summary: string, observation?: PageObservation): string | null {
    if (!isShoppingBrowseTask(task)) return null;
    const surface = cleanWhitespace(summary || '');
    const constraints = shoppingIntentConstraints(task);
    if (!surface) return 'Для товарного подбора нельзя завершать задачу пустым итогом.';

    if (isListingOnlyShoppingSuccessText(surface) && !hasConcreteShoppingSelection(surface)) {
        return 'Каталог, страница бренда или факт видимых товаров не являются выполненной задачей подбора. Нужно выбрать конкретные товары и вернуть их в итог.';
    }

    if (!hasConcreteShoppingSelection(surface)) {
        return 'Итог товарного подбора должен содержать конкретные выбранные товары, а не только навигационный статус страницы.';
    }

    if (constraints.needsTop && !hasShoppingTopEvidence(surface)) {
        return 'Пользователь просит комплект/верх, но в итоге нет конкретного выбранного верха. Продолжай искать верхнюю вещь и дай ссылку на карточку.';
    }

    if (constraints.needsBottom && !hasShoppingBottomEvidence(surface)) {
        return 'Пользователь просит комплект/низ, но в итоге нет конкретного выбранного низа. Продолжай искать брюки/чинос/шорты и дай ссылку на карточку.';
    }

    if ((constraints.needsTop || constraints.needsBottom) && taskRequiresProductLinks(task) && countProductUrls(surface) < 2) {
        return 'Для комплекта верх+низ нужно минимум две прямые ссылки на карточки товаров, по одной на каждую вещь.';
    }

    if (constraints.needsLight) {
        if (hasDarkColorConflict(surface)) {
            return 'Пользователь просит светлые вещи, а итог содержит тёмный/чёрный цвет. Такой товар нужно заменить и продолжить подбор.';
        }
        if (!hasLightColorEvidence(surface)) {
            const productHint = observation?.productCardsText
                ? ` Проверь цвет по карточкам/скриншоту и фильтру "Цвет"; текущие карточки: ${observation.productCardsText.slice(0, 450)}`
                : ' Используй фильтр цвета или открой карточку товара, чтобы подтвердить цвет.';
            return `Для светлого комплекта в итоге должен быть указан доказанный светлый цвет каждой выбранной вещи.${productHint}`;
        }
    }

    if (constraints.needsSummerLight && !hasSummerMaterialEvidence(surface)) {
        return 'Пользователь просит лёгкий летний вариант, но в итоге нет доказательства летнего материала/фасона. Укажи лён/хлопок/лёгкую посадку или продолжай искать.';
    }

    if (constraints.needsStyleRationale && !hasStyleRationaleEvidence(surface)) {
        return 'Пользователь задал стиль, но итог не объясняет, почему выбранные вещи ему соответствуют. Нужна краткая стилистическая причина по каждому предмету или комплекту.';
    }

    if (constraints.needsCompatibility && !hasCompatibilityEvidence(surface)) {
        return 'Для комплекта нужно явно объяснить, почему верх и низ сочетаются: палитра, силуэт, сезонность и общий стиль.';
    }

    if (taskRequiresProductLinks(task) && !textHasProductUrl(surface) && !textHasUrl(surface)) {
        const productHint = observation?.productCardsText
            ? ` В наблюдении уже есть прямые ссылки на карточки товаров; используй их в done: ${observation.productCardsText.slice(0, 500)}`
            : ' Открой карточки или извлеки href из товарных карточек, затем верни done со ссылками.';
        return `Для этой e-commerce задачи итог обязан содержать прямые ссылки на товары.${productHint}`;
    }

    return null;
}

function browserTaskPageContextForSession(observation: PageObservation): string | undefined {
    const parts = [
        observation.scrollDiagnosticsText ? `Scroll diagnostics:\n${observation.scrollDiagnosticsText.slice(0, 1000)}` : '',
        observation.filterControlsText ? `Filter/facet map:\n${observation.filterControlsText.slice(0, 1800)}` : '',
        observation.structuredDataText ? `Structured data/meta:\n${observation.structuredDataText.slice(0, 2000)}` : '',
        observation.semanticMapText ? `Semantic page map:\n${observation.semanticMapText.slice(0, 2200)}` : '',
        observation.productCardsText ? `Товарные карточки и ссылки:\n${observation.productCardsText.slice(0, 2500)}` : '',
        observation.tableText ? `Таблицы и гриды:\n${observation.tableText.slice(0, 2200)}` : '',
        observation.formBrainText ? `Form brain:\n${observation.formBrainText.slice(0, 1800)}` : '',
        observation.pageText ? `Видимый текст:\n${observation.pageText.slice(0, 2000)}` : '',
    ].filter(Boolean);
    return parts.length ? parts.join('\n\n') : undefined;
}

function shouldCompleteShoppingBrowseFromNote(task: string, note: string): boolean {
    if (!isShoppingBrowseTask(task) || userWantsShoppingCheckout(task)) return false;
    if (shoppingCompletionBlockReason(task, note)) return false;

    const text = normalizeSearchText(note);
    const hasFinalSelection = /(подобран|выбран|рекоменд|итогов|комплект|образ|вариант)/iu.test(text);
    const hasProductTerms = /(товар|карточк|комплект|образ|футболк|поло|рубашк|шорт|брюк|джинс|чинос|кроссов|кед|лофер|ботинк|куртк|ветровк|бомбер|жилет|свитшот|худи|пиджак|product|item|outfit|shirt|pants|shoes|jacket)/iu.test(text);
    return hasFinalSelection && hasProductTerms;
}

function isInternalUiAmbiguityQuestion(question: string): boolean {
    const text = normalizeSearchText(question);
    const asksUiChoice = /(какой|какую|что|куда|где|выбери|выбрать|нажать|кликнуть|ориентир)/iu.test(text) &&
        /(ui|dom|блок|кнопк|ссылк|элемент|област|карточк|пункт|селектор|страниц|следующ[ийе]\s+шаг|selector|button|link|card|block|element)/iu.test(text);
    const asksForExternalData = /(код|captcha|капч|sms|смс|otp|парол|логин|телефон|email|почт|адрес|имя|дата|время|размер|подтверди|оплат|платеж|платёж|паспорт|документ)/iu.test(text);
    return asksUiChoice && !asksForExternalData;
}

function shouldStayOnVisibleBookingForm(task: string, observation: PageObservation, decision: BrowserAction): string | null {
    if (decision.action !== 'navigate' && decision.action !== 'go_back') return null;
    if (!/(запиш|запис|зарегистр|регистрац|заброни|брон|book|reserve|register|sign\s*up|форма|заявк)/iu.test(task)) {
        return null;
    }
    if (!isBookingOrLeadFormSurface(observation) || !hasVisibleBookingContactFields(observation)) return null;

    return [
        'На текущей странице уже видна форма записи/заявки.',
        'Не уходи со страницы и не возвращайся в расписание: сначала определи недостающие поля, спроси пользователя или заполни известные значения.',
    ].join(' ');
}

function looksLikeActionControlLabel(label: string): boolean {
    return /(запис|регист|брон|заброн|перей|выбер|выбрать|отправ|добав|куп|оплат|подтверд|откры|далее|продолж|сохран|созда|редакт|удал|скач|поиск|найти|примен|фильтр|sign|submit|select|continue|next|add|buy|book|save|edit|delete|open|view|details|search|apply|filter|send|choose|reserve|register|join|start|ok|yes|no)/iu.test(label);
}

function quotedControlLabelFromText(text: string): string {
    const surface = cleanWhitespace(text).slice(0, 2000);
    if (!surface) return '';

    const patterns: Array<{ pattern: RegExp; requireAction: boolean }> = [
        { pattern: /(?:кнопк[а-яё]*|button)\s+[«"“']([^«»“”"'\n]{2,90})[»"”']/iu, requireAction: false },
        { pattern: /(?:ссылк[а-яё]*|link)\s+[«"“']([^«»“”"'\n]{2,90})[»"”']/iu, requireAction: false },
        { pattern: /(?:элемент[а-яё]*|пункт[а-яё]*|вариант[а-яё]*|option|item|control)\s+[«"“']([^«»“”"'\n]{2,90})[»"”']/iu, requireAction: true },
        { pattern: /(?:несколько|одинаков[а-яё]*|похож[а-яё]*|дублирующ[а-яё]*|multiple|duplicate)[^«"“'\n]{0,100}[«"“']([^«»“”"'\n]{2,90})[»"”']/iu, requireAction: true },
    ];

    for (const { pattern, requireAction } of patterns) {
        const match = surface.match(pattern);
        const label = cleanWhitespace(match?.[1] || '');
        if (!label || label.length > 90 || RUSSIAN_DATE_RE.test(label)) continue;
        if (requireAction && !looksLikeActionControlLabel(label)) continue;
        return label;
    }

    return '';
}

function clickLabelFromDecision(decision: BrowserAction): string {
    if (decision.action !== 'click' && decision.action !== 'ask_user') return '';

    const inferred = quotedControlLabelFromText([
        decision.summary,
        decision.comment,
        decision.value,
        decision.selector,
    ].filter(Boolean).join('\n'));

    if (decision.action !== 'click') return inferred;

    const raw = normalizeCandidateSelector(decision.selector || decision.value || '');
    if (!raw || /^index=\d+$/i.test(raw) || /^css=/i.test(raw) || /^testid=/i.test(raw)) return inferred;

    const { core } = splitCandidateSelectorMetadata(raw);

    const roleMatch = core.match(/^role=[a-zA-Z0-9_-]+\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\]$/);
    const roleName = roleMatch?.[1] || roleMatch?.[2] || roleMatch?.[3] || '';
    if (roleName) return cleanWhitespace(unescapeSelectorValue(roleName));

    const textMatch = core.match(/^text=([\s\S]+)$/);
    if (textMatch?.[1]) return cleanWhitespace(unescapeSelectorValue(textMatch[1]));

    const labelMatch = core.match(/^(?:label|placeholder)=([\s\S]+)$/);
    if (labelMatch?.[1]) return cleanWhitespace(unescapeSelectorValue(labelMatch[1]));

    const cssHint = cssSelectorTextHint(core);
    if (cssHint) return cssHint;

    const looksLikeSelector = /^[.#\[]/.test(core) || /[>+~:]/.test(core) || /^(a|button|input|textarea|select|form|div|span)\b/i.test(core);
    if (looksLikeSelector || core.length > 90) return inferred;

    return cleanWhitespace(core);
}

function meaningfulHint(value: string, clickLabel: string): string {
    const cleaned = cleanWhitespace(value)
        .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
        .replace(/\s+(?:пожалуйста|плиз|please)$/iu, '')
        .trim();
    const normalized = normalizeSearchText(cleaned);
    const labelNorm = normalizeSearchText(clickLabel);
    if (!cleaned || normalized.length < 3) return '';
    if (normalized === labelNorm || labelNorm.includes(normalized)) return '';
    if (/^(на|в|к|и|или|это|эту|этот|там|тут|кнопк[аеуи]?|ссылк[аеуи]?|карточк[ауи]?|игр[ауые]?|сайт|страниц[ауе]?)$/iu.test(normalized)) return '';
    if (/^(записаться|перейти|отправить|подтвердить|выбрать|далее|продолжить)$/iu.test(normalized)) return '';
    return cleaned.slice(0, 90);
}

function cleanContextHintCandidate(raw: string): string {
    return cleanWhitespace(raw)
        .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
        .replace(/^(?:это|эту|этот|его|е[её]|там|тут)\s+/iu, '')
        .replace(/^(?:строк[аеуие]?|карточк[аеуие]?|блок[аеуие]?|запис[ьи]?|элемент[аеуие]?|пункт[еауи]?|вариант[еауи]?|ряд[уе]?|row|card|block|item|record)\s+/iu, '')
        .replace(/\s+(?:и|а|and|then)\s+(?:нажми|кликни|выбери|открой|удали|заполни|press|click|select|open|delete|fill)(?:\s+.*)?$/iu, '')
        .replace(/\s+(?:нажми|кликни|выбери|открой|удали|заполни|press|click|select|open|delete|fill)(?:\s+.*)?$/iu, '')
        .trim();
}

function extractContextualClickHints(task: string, decision: BrowserAction, clickLabel: string): string[] {
    const surface = [
        task,
        decision.comment,
        decision.summary,
        decision.value,
        decision.selector,
    ].filter(Boolean).join('\n').slice(0, 7000);
    const hints: string[] = [];
    const add = (value?: string) => {
        const hint = meaningfulHint(value || '', clickLabel);
        if (!hint) return;
        const normalized = normalizeSearchText(hint);
        if (!hints.some((existing) => normalizeSearchText(existing) === normalized)) {
            hints.push(hint);
        }
    };

    const explicitTarget = extractTaskTextTarget(surface);
    if (explicitTarget?.name) {
        const extractedHints = uniqueStrings([explicitTarget.name, explicitTarget.dateText].filter((hint): hint is string => Boolean(hint))).slice(0, 8);
        browserLog('contextual_hints_explicit_target', {
            clickLabel,
            target: explicitTarget.name,
            dateText: explicitTarget.dateText,
            hints: extractedHints.join(', '),
        });
        return extractedHints;
    }

    for (const match of surface.matchAll(/[«“"]([^«»“”"\n]{3,90})[»”"]/gu)) {
        add(match[1]);
    }
    for (const match of surface.matchAll(/'([^'\n]{3,90})'/gu)) {
        add(match[1]);
    }
    for (const match of surface.matchAll(new RegExp(RUSSIAN_DATE_RE.source, 'giu'))) {
        add(match[0]);
    }

    const actionPatterns = [
        /(?:запиши|запис(?:аться|ываемся|ать)?|зарегистрируй|забронируй|выбери|открой|перейди|нажми|кликни)\s+(?:меня|нас|нам|мне|себя|это|эту|этот|его|е[её])?\s*(?:(?:на|в|к|по)\s+)?(?:(?:кнопк[аеуи]?|ссылк[аеуи]?|элемент[еау]?|вариант|button|link|control)\s+)?([^.\n!?;,]{3,90})/giu,
        /(?:нужн[ао]?|выбран[ао]?|подходящ[аяийее]+|target|цель)\s*:?\s*([^.\n!?;,]{3,90})/giu,
    ];
    for (const pattern of actionPatterns) {
        for (const match of surface.matchAll(pattern)) {
            add(cleanTaskTargetName(match[1] || ''));
        }
    }

    const objectContextPatterns = [
        /(?:в|на|у|для|по)\s+(?:строк[еауи]?|карточк[еауи]?|блок[еауи]?|ряду|запис[иь]|элемент[еауи]?|пункт[еауи]?|вариант[еауи]?|заказ[еауи]?|товар[еауи]?|пользовател[еяю]?|клиент[еау]?|проект[еау]?|задач[еауи]?|позици[иею])\s*[:#№-]?\s*([^.\n!?;,]{3,90})/giu,
        /(?:напротив|рядом\s+с|около|возле)\s+([^.\n!?;,]{3,90})/giu,
        /(?:row|card|block|item|record|order|product|user|customer|project|task)\s*[:#-]?\s*([^.\n!?;,]{3,90})/giu,
    ];
    for (const pattern of objectContextPatterns) {
        for (const match of surface.matchAll(pattern)) {
            add(cleanContextHintCandidate(match[1] || ''));
        }
    }

    return hints.slice(0, 8);
}

function compactContextLabel(context: string, fallback: string): string {
    const compact = cleanWhitespace(context);
    let lines = context
        .split(/\n+|(?<=[.!?])\s+/u)
        .map((line) => cleanWhitespace(line))
        .filter(Boolean)
        .filter((line, index, arr) => line.length <= 140 && arr.indexOf(line) === index)
        .slice(0, 5);
    if (!lines.length && compact) {
        const titleLike = compact.match(/(?:\d{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s*)?(.{3,140}?)(?:\s+Сложность\b|\s+\d{1,2}:\d{2}\s+начало|\s+Записаться\b|$)/iu)?.[1];
        lines = [cleanWhitespace(titleLike || compact.slice(0, 140))].filter(Boolean);
    }
    return (lines.join(' • ') || fallback).slice(0, 180);
}

function isRussianDateHint(value: string): boolean {
    return RUSSIAN_DATE_RE.test(value);
}

function uniqueStrings(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values.map((item) => cleanWhitespace(item)).filter(Boolean)) {
        const normalized = normalizeSearchText(value);
        if (!result.some((existing) => normalizeSearchText(existing) === normalized)) {
            result.push(value);
        }
    }
    return result;
}

function inferTaskScopedActionIntent(task: string): TaskScopedActionIntent | null {
    const surface = normalizeSearchText(task);
    const highImpact = /(оплат|плат[её]ж|купить|покупк|удал|отменить|cancel|delete|remove|pay|purchase|checkout)/iu.test(surface);

    const intents: Array<{ test: RegExp; labels: string[]; keywords: string[]; description: string }> = [
        {
            test: /(запиш|запис|зарегистр|регистрац|заброни|брон|book|reserve|register|sign\s*up|join)/iu,
            labels: [
                'Записаться',
                'Зарегистрироваться',
                'Забронировать',
                'Перейти',
                'Подробнее',
                'Открыть',
                'Book',
                'Reserve',
                'Register',
                'Sign up',
                'Join',
                'Details',
                'Open',
            ],
            keywords: ['запис', 'регист', 'брон', 'перей', 'подробнее', 'откр', 'book', 'reserve', 'register', 'sign', 'join', 'details', 'open'],
            description: 'запись/регистрация',
        },
        {
            test: /(перей|откр|посмотр|покаж|подробнее|детал|view|details|open|go\s*to)/iu,
            labels: ['Перейти', 'Открыть', 'Подробнее', 'Посмотреть', 'View', 'Details', 'Open'],
            keywords: ['перей', 'откр', 'подробнее', 'посмотр', 'view', 'details', 'open'],
            description: 'открытие/переход',
        },
        {
            test: /(выбер|выбрать|select|choose|pick)/iu,
            labels: ['Выбрать', 'Select', 'Choose'],
            keywords: ['выбер', 'select', 'choose', 'pick'],
            description: 'выбор',
        },
        {
            test: /(добав|add)/iu,
            labels: ['Добавить', 'В корзину', 'Add', 'Add to cart'],
            keywords: ['добав', 'корзин', 'add'],
            description: 'добавление',
        },
        {
            test: /(отправ|сохран|примен|submit|send|save|apply)/iu,
            labels: ['Отправить', 'Сохранить', 'Применить', 'Submit', 'Send', 'Save', 'Apply'],
            keywords: ['отправ', 'сохран', 'примен', 'submit', 'send', 'save', 'apply'],
            description: 'отправка/сохранение',
        },
    ];

    const matched = intents.find((intent) => intent.test.test(surface));
    if (!matched) return null;

    return {
        labels: uniqueStrings(matched.labels),
        keywords: uniqueStrings(matched.keywords),
        description: matched.description,
        highImpact,
    };
}

function taskScopedHints(task: string, intent: TaskScopedActionIntent): string[] {
    const explicitTarget = extractTaskTextTarget(task);
    if (explicitTarget?.name) {
        return uniqueStrings([explicitTarget.name, explicitTarget.dateText].filter((hint): hint is string => Boolean(hint))).slice(0, 8);
    }

    const probeDecision: BrowserAction = {
        action: 'ask_user',
        summary: '',
    };
    return extractContextualClickHints(task, probeDecision, intent.labels[0] || '')
        .filter((hint) => !intent.labels.some((label) => normalizeSearchText(label) === normalizeSearchText(hint)))
        .filter((hint) => {
            const normalized = normalizeSearchText(hint);
            if (/^(запись\/регистрация|записаться(?:\s+на\s+игру)?|зарегистрироваться|забронировать|перейти|подробнее|открыть|выбрать)$/iu.test(normalized)) return false;
            if (/^(да(?:[,\s]+подтверждаю)?|нет|подтверждаю|отмена|продолжай|stop|cancel|ок|okay)$/iu.test(normalized)) return false;
            if (/^(?:button|кнопка|ссылка|элемент|вариант)\b/iu.test(normalized)) return false;
            return true;
        })
        .slice(0, 8);
}

async function documentContainsAnySearchHint(page: Page, hints: string[]): Promise<boolean> {
    const primaryHints = hints.filter((hint) => !isRussianDateHint(hint)).slice(0, 4);
    if (!primaryHints.length) return false;

    return page.evaluate((rawHints) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const genericHintTokens = new Set([
            'игра', 'игру', 'игры', 'игре',
            'квиз', 'квиза', 'квизу',
            'карточка', 'карточку', 'карточке', 'блок', 'блока', 'блоке',
            'кнопка', 'кнопку', 'кнопке', 'ссылка', 'ссылку', 'ссылке',
            'записаться', 'запись', 'запиши', 'зарегистрироваться', 'регистрация',
        ]);
        const tokenStem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            value = value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
            return value;
        };
        const meaningfulTokenStems = (value: string) =>
            normalize(value)
                .split(/[^a-zа-яё0-9#№]+/iu)
                .map((token) => ({ raw: token, stem: tokenStem(token) }))
                .filter((token) => token.raw.length >= 3 && token.stem.length >= 3 && !genericHintTokens.has(token.raw))
                .map((token) => token.stem);
        const stemsOverlap = (left: string, right: string) => {
            if (left.length >= 4 && right.length >= 4) {
                return left === right || left.startsWith(right) || right.startsWith(left);
            }
            return left === right;
        };
        const pageText = normalize(document.body?.innerText || document.body?.textContent || '');
        const pageStems = meaningfulTokenStems(pageText);
        return rawHints
            .map((hint) => normalize(hint))
            .filter((hint) => hint.length >= 3)
            .some((hint) => {
                if (pageText.includes(hint)) return true;
                const hintStems = meaningfulTokenStems(hint);
                return hintStems.length > 0 &&
                    hintStems.every((hintStem) => pageStems.some((pageStem) => stemsOverlap(pageStem, hintStem)));
            });
    }, primaryHints).catch(() => false);
}

async function getTaskScopedActionCandidates(
    page: Page,
    intent: TaskScopedActionIntent,
    hints: string[]
): Promise<TaskScopedActionCandidate[]> {
    const primaryHints = hints.filter((hint) => !isRussianDateHint(hint)).slice(0, 4);
    const secondaryHints = hints.filter((hint) => !primaryHints.includes(hint)).slice(0, 6);
    if (!primaryHints.length) return [];

    return page.evaluate(({ intent: rawIntent, primaryHints: rawPrimaryHints, secondaryHints: rawSecondaryHints }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const genericHintTokens = new Set([
            'игра', 'игру', 'игры', 'игре',
            'квиз', 'квиза', 'квизу',
            'карточка', 'карточку', 'карточке', 'блок', 'блока', 'блоке',
            'кнопка', 'кнопку', 'кнопке', 'ссылка', 'ссылку', 'ссылке',
            'записаться', 'запись', 'запиши', 'зарегистрироваться', 'регистрация',
        ]);
        const tokenStem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            value = value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
            return value;
        };
        const meaningfulTokenStems = (value: string) =>
            normalize(value)
                .split(/[^a-zа-яё0-9#№]+/iu)
                .map((token) => ({ raw: token, stem: tokenStem(token) }))
                .filter((token) => token.raw.length >= 3 && token.stem.length >= 3 && !genericHintTokens.has(token.raw))
                .map((token) => token.stem);
        const stemsOverlap = (left: string, right: string) => {
            if (left.length >= 4 && right.length >= 4) {
                return left === right || left.startsWith(right) || right.startsWith(left);
            }
            return left === right;
        };
        const textMatchesHint = (text: string, hint: { norm: string; stems: string[] }) => {
            const normalizedText = normalize(text);
            if (hint.norm && normalizedText.includes(hint.norm)) return true;
            if (!hint.stems.length) return false;
            const textStems = meaningfulTokenStems(normalizedText);
            return hint.stems.every((hintStem) => textStems.some((textStem) => stemsOverlap(textStem, hintStem)));
        };
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const actionLabels = rawIntent.labels.map((label) => normalize(label)).filter(Boolean);
        const actionKeywords = rawIntent.keywords.map((keyword) => normalize(keyword)).filter(Boolean);
        const scoreAction = (label: string) => {
            const normalizedLabel = normalize(label);
            if (!normalizedLabel) return { score: 0, matched: '' };

            let best = { score: 0, matched: '' };
            for (const actionLabel of actionLabels) {
                if (normalizedLabel === actionLabel) {
                    best = { score: Math.max(best.score, 95), matched: actionLabel };
                } else if (normalizedLabel.includes(actionLabel)) {
                    best = { score: Math.max(best.score, 82), matched: actionLabel };
                } else if (actionLabel.includes(normalizedLabel) && normalizedLabel.length >= 4) {
                    best = { score: Math.max(best.score, 48), matched: actionLabel };
                }
            }
            for (const keyword of actionKeywords) {
                if (normalizedLabel.includes(keyword)) {
                    best = { score: Math.max(best.score, 58), matched: keyword };
                }
            }

            if (rawIntent.description === 'запись/регистрация' && best.score > 0) {
                if (/(запис|регист|заброн|брон|book|reserve|register|sign|join)/iu.test(normalizedLabel)) {
                    best = { ...best, score: best.score + 22 };
                } else if (/(перей|подробнее|откр|details|open|view)/iu.test(normalizedLabel)) {
                    best = { ...best, score: Math.max(1, best.score - 12) };
                }
            }

            return best;
        };

        const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => isVisible(el) && textOf(el));
        const primaryHints = rawPrimaryHints
            .map((hint) => ({ raw: hint, norm: normalize(hint), stems: meaningfulTokenStems(hint) }))
            .filter((hint) => hint.norm.length >= 3 || hint.stems.length > 0);
        const secondaryHints = rawSecondaryHints
            .map((hint) => ({ raw: hint, norm: normalize(hint), stems: meaningfulTokenStems(hint) }))
            .filter((hint) => hint.norm.length >= 3 || hint.stems.length > 0);
        const elements = Array.from(document.querySelectorAll('body *'))
            .filter((el) => isVisible(el)) as HTMLElement[];
        const candidates: TaskScopedActionCandidate[] = [];

        for (const hint of primaryHints) {
            const targetElements = elements
                .map((el) => ({ el, text: compact(el.innerText || el.textContent) }))
                .filter(({ text }) => text && textMatchesHint(text, hint))
                .sort((a, b) => a.text.length - b.text.length)
                .slice(0, 100);

            for (const { el: targetElement } of targetElements) {
                let parent: HTMLElement | null = targetElement;
                for (let depth = 0; parent && depth < 9; depth += 1, parent = parent.parentElement) {
                    const context = compact(parent.innerText || parent.textContent);
                    const normalizedContext = normalize(context);
                    if (!context || !textMatchesHint(context, hint)) continue;

                    const controlsInBlock = controls.filter((control) => parent!.contains(control));
                    if (!controlsInBlock.length) continue;

                    const rect = parent.getBoundingClientRect();
                    const interactiveCount = parent.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').length;
                    const reasonable =
                        context.length <= 2600 &&
                        controlsInBlock.length <= 8 &&
                        interactiveCount <= 30 &&
                        rect.width <= window.innerWidth * 1.08 &&
                        rect.height <= window.innerHeight * 3.2;
                    if (!reasonable) continue;

                    const targetRect = targetElement.getBoundingClientRect();
                    const matchedHints = [hint.raw];
                    let score = 115 - depth * 5 - Math.min(24, Math.floor(context.length / 220)) - Math.max(0, controlsInBlock.length - 1) * 7;

                    for (const secondary of secondaryHints) {
                        if (textMatchesHint(normalizedContext, secondary)) {
                            matchedHints.push(secondary.raw);
                            score += 26;
                        }
                    }

                    const bestControl = controlsInBlock
                        .map((control) => {
                            const label = textOf(control);
                            const action = scoreAction(label);
                            const controlRect = control.getBoundingClientRect();
                            const verticalDistance = Math.abs((controlRect.top + controlRect.bottom) / 2 - (targetRect.top + targetRect.bottom) / 2);
                            let localTargetScore = -120;
                            let localParent: HTMLElement | null = control as HTMLElement;
                            for (let localDepth = 0; localParent && localDepth < 7; localDepth += 1, localParent = localParent.parentElement) {
                                const localText = compact(localParent.innerText || localParent.textContent);
                                if (!localText || !textMatchesHint(localText, hint)) continue;
                                const localRect = localParent.getBoundingClientRect();
                                const localInteractiveCount = localParent.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').length;
                                const compactTargetBlock =
                                    localText.length <= 1200 &&
                                    localInteractiveCount <= 6 &&
                                    localRect.width <= window.innerWidth * 1.05 &&
                                    localRect.height <= window.innerHeight * 1.9;
                                localTargetScore = compactTargetBlock
                                    ? 130 - localDepth * 18 - Math.min(36, Math.floor(localText.length / 130)) - Math.max(0, localInteractiveCount - 1) * 8
                                    : 22 - localDepth * 14 - Math.min(44, Math.floor(localText.length / 220)) - Math.max(0, localInteractiveCount - 1) * 10;
                                break;
                            }
                            return {
                                control,
                                label,
                                action,
                                rank: action.score + localTargetScore - Math.min(28, Math.round(verticalDistance / 25)),
                            };
                        })
                        .filter((item) => item.action.score > 0)
                        .sort((a, b) => b.rank - a.rank)[0];
                    if (!bestControl) continue;

                    const controlIndex = controls.indexOf(bestControl.control);
                    if (controlIndex < 0) continue;

                    candidates.push({
                        controlIndex,
                        controlLabel: bestControl.label,
                        context: context.slice(0, 900),
                        matchedHints,
                        matchedAction: bestControl.action.matched,
                        score: score + bestControl.rank,
                    });
                    break;
                }
            }
        }

        const seen = new Set<number>();
        return candidates
            .sort((a, b) => b.score - a.score)
            .filter((candidate) => {
                if (seen.has(candidate.controlIndex)) return false;
                seen.add(candidate.controlIndex);
                return true;
            })
            .slice(0, 8);
    }, { intent, primaryHints, secondaryHints });
}

async function clickVisibleControlByIndex(page: Page, controlIndex: number): Promise<void> {
    const handle = await page.evaluateHandle(({ targetIndex }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => isVisible(el) && textOf(el));
        return controls[targetIndex] ?? null;
    }, { targetIndex: controlIndex });

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        throw new Error(`Не найден интерактивный элемент index=${controlIndex}`);
    }

    try {
        await clickLocatorLikeUser(page, element);
    } finally {
        await handle.dispose();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function getVisualClickCandidates(page: Page): Promise<VisualClickCandidate[]> {
    return page.evaluate((clickableSelector) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const cssEscape = (value: string) => {
            const css = (window as any).CSS;
            if (css?.escape) return css.escape(value);
            return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
        };
        const attrEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const unique = (values: string[]) => {
            const result: string[] = [];
            for (const value of values.map(compact).filter(Boolean)) {
                const key = value.toLocaleLowerCase('ru-RU');
                if (!result.some((existing) => existing.toLocaleLowerCase('ru-RU') === key)) result.push(value);
            }
            return result;
        };
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };
        const codeHintsOf = (el: Element) => {
            const href = el instanceof HTMLAnchorElement ? el.href : '';
            const raw = [
                el.id,
                el.getAttribute('class'),
                el.getAttribute('data-testid'),
                el.getAttribute('data-test'),
                el.getAttribute('name'),
                href ? href.split('/').pop() : '',
            ].filter(Boolean).join(' ');
            return unique(
                raw
                    .replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, '')
                    .split(/[^a-zа-яё0-9#№]+/iu)
                    .filter((part) => part.length >= 3 && part.length <= 40)
            ).slice(0, 8);
        };
        const visualHintsOf = (el: Element) => {
            const imgHints = Array.from(el.matches('img') ? [el as HTMLImageElement] : el.querySelectorAll('img'))
                .map((img) => [
                    img.getAttribute('alt'),
                    img.getAttribute('title'),
                    img.getAttribute('aria-label'),
                    img.getAttribute('src')?.split('/').pop()?.replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, ''),
                ].filter(Boolean).join(' '))
                .filter(Boolean);
            const svgHints = Array.from(el.querySelectorAll('svg, svg *'))
                .flatMap((node) => [
                    (node as Element).getAttribute('aria-label'),
                    (node as Element).getAttribute('title'),
                    compact((node as Element).querySelector('title')?.textContent),
                    (node as Element).getAttribute('href'),
                    (node as Element).getAttribute('xlink:href'),
                    (node as Element).getAttribute('class'),
                ])
                .filter(Boolean) as string[];
            const style = window.getComputedStyle(el);
            const background = style.backgroundImage && style.backgroundImage !== 'none'
                ? style.backgroundImage.replace(/^url\(["']?|["']?\)$/giu, '').split('/').pop()?.replace(/\.[a-z0-9]{2,5}(?:[?#].*)?$/iu, '')
                : '';
            return unique([...imgHints, ...svgHints, background || '', ...codeHintsOf(el)]).slice(0, 12);
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            const labelText = Array.from(input.labels ?? []).map((label) => compact(label.innerText)).join(' ');
            const value = ['submit', 'button', 'reset'].includes((input.type || '').toLowerCase()) ? compact(input.value) : '';
            return compact(labelText || el.getAttribute('aria-label') || el.getAttribute('title') || value || (el as HTMLElement).innerText || el.textContent || visualHintsOf(el).join(' '));
        };
        const roleOf = (el: Element) => {
            const explicitRole = compact(el.getAttribute('role'));
            if (explicitRole) return explicitRole;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
            return tag;
        };
        const selectorFor = (el: Element, label: string, role: string) => {
            const tag = el.tagName.toLowerCase();
            const selectors: string[] = [];
            const id = compact(el.getAttribute('id'));
            const testId = compact(el.getAttribute('data-testid'));
            const dataTest = compact(el.getAttribute('data-test'));
            const name = compact(el.getAttribute('name'));
            const aria = compact(el.getAttribute('aria-label'));
            const title = compact(el.getAttribute('title'));
            const hrefAttr = el instanceof HTMLAnchorElement ? compact(el.getAttribute('href')) : '';
            const href = el instanceof HTMLAnchorElement ? compact(hrefAttr || el.href) : '';
            if (testId) selectors.push(`testid=${testId}`);
            if (dataTest) selectors.push(`css=${tag}[data-test="${attrEscape(dataTest)}"]`);
            if (id) selectors.push(`css=#${cssEscape(id)}`);
            if (name) selectors.push(`css=${tag}[name="${attrEscape(name)}"]`);
            if (aria) selectors.push(`css=${tag}[aria-label="${attrEscape(aria)}"]`);
            if (title) selectors.push(`css=${tag}[title="${attrEscape(title)}"]`);
            if (href) selectors.push(`css=a[href="${attrEscape(href)}"]`);
            if (hrefAttr && hrefAttr !== href) selectors.push(`css=a[href="${attrEscape(hrefAttr)}"]`);
            if (label && ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'].includes(role)) {
                selectors.push(`role=${role}[name="${attrEscape(label.slice(0, 80))}"]`);
            }
            if (label && !/^(img|svg|icon|button|link)$/iu.test(label)) selectors.push(`text=${label.slice(0, 90)}`);
            return unique(selectors).slice(0, 5);
        };
        const isActionable = (el: Element) => {
            const tag = el.tagName.toLowerCase();
            const type = ((el as HTMLInputElement).type || '').toLowerCase();
            const role = roleOf(el).toLowerCase();
            const style = window.getComputedStyle(el);
            if (tag === 'a' || tag === 'button') return true;
            if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) return true;
            if (['button', 'link', 'menuitem', 'tab'].includes(role)) return true;
            if (el.getAttribute('onclick')) return true;
            if (style.cursor === 'pointer' && (textOf(el) || visualHintsOf(el).length)) return true;
            return false;
        };
        const buttonTexts = (root: Element) =>
            Array.from(root.querySelectorAll(clickableSelector))
                .filter(isVisible)
                .map(textOf)
                .filter(Boolean);
        const contextFor = (el: Element) => {
            let parent: HTMLElement | null = el as HTMLElement;
            let best = '';
            let modalLike = false;
            let zIndex = 0;
            let position = '';
            for (let depth = 0; parent && depth < 7; depth += 1, parent = parent.parentElement) {
                const text = compact(parent.innerText || parent.textContent);
                const rect = parent.getBoundingClientRect();
                const style = window.getComputedStyle(parent);
                const controls = buttonTexts(parent);
                const classAndId = compact(`${parent.id || ''} ${parent.className?.toString?.() || ''}`);
                const parsedZ = Number.parseInt(style.zIndex || '0', 10);
                const localZ = Number.isFinite(parsedZ) ? parsedZ : 0;
                const localModalLike =
                    /(modal|popup|dialog|overlay|confirm|alert|swal|fancybox)/iu.test(classAndId) ||
                    style.position === 'fixed' ||
                    (style.position === 'absolute' && localZ >= 10) ||
                    (controls.length >= 2 && controls.length <= 6 && /(?:\?|подтверд|confirm|сможете|можете|отказ|cancel|бронир|booking)/iu.test(text));

                if (localModalLike) {
                    modalLike = true;
                    zIndex = Math.max(zIndex, localZ);
                    position = position || style.position;
                }
                if (
                    text &&
                    text.length >= 4 &&
                    text.length <= 900 &&
                    controls.length <= 8 &&
                    rect.width <= window.innerWidth * 0.98 &&
                    rect.height <= window.innerHeight * 0.95
                ) {
                    best = text;
                    zIndex = Math.max(zIndex, localZ);
                    position = position || style.position;
                    if (localModalLike || depth >= 2) break;
                }
            }
            return { context: best, modalLike, zIndex, position };
        };
        const nearbyTextFor = (el: Element) => unique([
            compact((el.previousElementSibling as HTMLElement | null)?.innerText || el.previousElementSibling?.textContent),
            compact((el.nextElementSibling as HTMLElement | null)?.innerText || el.nextElementSibling?.textContent),
            compact(el.closest('label')?.textContent),
            compact(el.closest('li,article,section,tr,[role="row"],[class*="card" i],[class*="item" i]')?.querySelector('h1,h2,h3,h4,[role="heading"],strong,b')?.textContent),
        ]).join(' | ');
        const controls = Array.from(document.querySelectorAll(clickableSelector))
            .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el) && isActionable(el));

        return controls
            .map((el, controlIndex) => {
                const rect = el.getBoundingClientRect();
                const label = textOf(el);
                const role = roleOf(el);
                const selectors = selectorFor(el, label, role);
                const visual = unique(visualHintsOf(el)).join(' | ');
                const nearbyText = nearbyTextFor(el);
                const { context, modalLike, zIndex, position } = contextFor(el);
                const normalizedLabel = normalize(label);
                const normalizedVisual = normalize([visual, nearbyText, selectors.join(' ')].join(' '));
                const area = Math.round(rect.width * rect.height);
                let score = 0;
                if (modalLike) score += 80;
                if (/^(да|нет|ok|ок|yes|no|подтвердить|отмена|cancel|continue|продолжить)$/iu.test(normalizedLabel)) score += 36;
                if (/(запис|регист|брон|отправ|подтверд|продолж|submit|send|confirm|book|reserve|register|yes|no)/iu.test(`${normalizedLabel} ${normalizedVisual}`)) score += 24;
                if (zIndex >= 10) score += 18;
                if (position === 'fixed') score += 16;
                if (position === 'absolute') score += 8;
                if (visual) score += 10;
                if (selectors.length) score += 8;
                if (rect.top >= -10 && rect.left >= -10 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 12;
                if (label.length > 120) score -= 26;
                if (area > window.innerWidth * window.innerHeight * 0.25) score -= 30;

                return {
                    controlIndex,
                    label: label.slice(0, 160),
                    role,
                    selector: `visual=${controlIndex + 1}`,
                    selectors,
                    visual: visual.slice(0, 220),
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                    center: `${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)}`,
                    context: context.slice(0, 700),
                    nearbyText: nearbyText.slice(0, 240),
                    position,
                    zIndex,
                    modalLike,
                    score,
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 48);
    }, CLICKABLE_CONTROL_SELECTOR);
}

function rankVisualClickCandidates(candidates: VisualClickCandidate[], clickLabel: string): VisualClickCandidate[] {
    const normalizedClick = normalizeSearchText(clickLabel);
    return candidates
        .map((candidate) => {
            const normalizedLabel = normalizeSearchText(candidate.label);
            const normalizedSurface = normalizeSearchText([
                candidate.label,
                candidate.visual,
                candidate.nearbyText,
                candidate.context,
                candidate.selector,
                candidate.selectors.join(' '),
            ].join(' '));
            let score = candidate.score;
            if (normalizedClick && normalizedLabel === normalizedClick) score += 140;
            else if (normalizedClick && (normalizedLabel.includes(normalizedClick) || normalizedClick.includes(normalizedLabel))) score += 70;
            else if (normalizedClick && normalizedSurface.includes(normalizedClick)) score += 58;
            else if (normalizedClick && normalizedClick.split(/\s+/).filter((token) => token.length >= 3).some((token) => normalizedSurface.includes(token))) score += 24;
            if (candidate.modalLike) score += 40;
            if (candidate.context && /(?:\?|подтверд|confirm|сможете|можете|отказ|cancel|бронир|booking)/iu.test(candidate.context)) score += 24;
            return { candidate, score };
        })
        .sort((a, b) => b.score - a.score)
        .map((item) => item.candidate)
        .slice(0, 32);
}

async function chooseVisualClickCandidateWithLlm(
    task: string,
    decision: BrowserAction,
    observation: PageObservation,
    guardNote: string,
    candidates: VisualClickCandidate[]
): Promise<{ candidate: VisualClickCandidate; confidence: number; reason: string } | null> {
    if (!candidates.length) return null;
    const clickLabel = clickLabelFromDecision(decision) || actionTargetSelector(decision);
    const payload = {
        task: redactSecrets(task).slice(0, 1600),
        clickIntent: {
            label: clickLabel,
            selector: redactSecrets(decision.selector || '').slice(0, 220),
            value: redactSecrets(decision.value || '').slice(0, 220),
            comment: redactSecrets(decision.comment || '').slice(0, 260),
        },
        guardNote: redactSecrets(guardNote).slice(0, 500),
        page: {
            modalText: redactSecrets(observation.modalText || '').slice(0, 1400),
            visibleText: redactSecrets(observation.pageText || '').slice(0, 1800),
            structureText: redactSecrets(observation.structureText || '').slice(0, 1800),
            visualCodeMap: redactSecrets(observation.visualMapText || '').slice(0, 2200),
        },
        candidates: candidates.map((candidate, index) => ({
            index,
            label: candidate.label,
            role: candidate.role,
            selector: candidate.selector,
            altSelectors: candidate.selectors,
            visual: redactSecrets(candidate.visual).slice(0, 220),
            bbox: candidate.bbox,
            center: candidate.center,
            modalLike: candidate.modalLike,
            position: candidate.position,
            zIndex: candidate.zIndex,
            nearbyText: redactSecrets(candidate.nearbyText).slice(0, 240),
            context: redactSecrets(candidate.context).slice(0, 650),
        })),
    };

    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await createChatCompletionForTask('browserVision', {
                max_tokens: 300,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content: [
                            'Ты visual layout resolver для браузерного агента.',
                            'Детерминированный DOM guard заблокировал click, потому что не смог связать элемент с целевым блоком.',
                            'Твоя задача: по скриншоту и списку видимых элементов выбрать candidate.index, если нужный элемент очевиден визуально.',
                            'Для иконочных/image-only кнопок опирайся на visual/code hints, bbox/center, altSelectors, соседний текст и фактическую картинку на скриншоте.',
                            'Особенно учитывай видимые modal/popup/confirm окна поверх страницы: кнопки внутри такого окна можно выбирать по вопросу самого окна, даже если рядом нет исходной карточки/товара/мероприятия.',
                            'Не выбирай элемент, если это платеж, удаление, юридическое согласие, ввод документов, captcha/OTP, или если на скриншоте/в bbox связь неочевидна.',
                            'Верни только JSON: {"choice":0,"confidence":0.0,"reason":"..."}; если нельзя уверенно выбрать, choice=null.',
                        ].join(' '),
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: JSON.stringify(payload) },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/jpeg;base64,${observation.screenshotB64}`,
                                    detail: 'high',
                                },
                            },
                        ],
                    },
                ],
            });
            const parsed = parseLLMJson<{ choice?: number | null; confidence?: number; reason?: string }>(
                response.choices[0]?.message?.content?.trim() || ''
            );
            const choice = parsed?.choice;
            const confidence = Number(parsed?.confidence ?? 0);
            const reason = cleanWhitespace(parsed?.reason || '');
            if (Number.isInteger(choice) && choice! >= 0 && choice! < candidates.length && confidence >= 0.72) {
                return { candidate: candidates[choice!], confidence, reason };
            }
            browserLog('visual_layout_no_choice', {
                choice,
                confidence,
                reason: reason.slice(0, 220),
                clickLabel,
            });
            return null;
        } catch (err: any) {
            lastError = err;
            devLog('browserAgent: visual layout resolver failed:', err?.message ?? err);
            if (!isTransientLlmError(err) || attempt === 1) break;
            await sleepMs(600);
        }
    }

    if (lastError) browserLog('visual_layout_error', { reason: safeErrorMessage(lastError) });
    return null;
}

async function maybeUseVisualLayoutClick(
    page: Page,
    task: string,
    decision: BrowserAction,
    observation: PageObservation,
    guardNote: string
): Promise<VisualLayoutClickResult> {
    if (decision.action !== 'click' || !observation.screenshotB64) return { status: 'none', reason: 'not_click' };

    const clickLabel = clickLabelFromDecision(decision) || actionTargetSelector(decision);
    const candidates = rankVisualClickCandidates(await getVisualClickCandidates(page), clickLabel);
    browserLog('visual_layout_probe', {
        clickLabel,
        candidates: candidates.length,
        top: candidates[0] ? summarizeCandidate({ label: candidates[0].label, context: candidates[0].context, score: candidates[0].score }) : undefined,
    });
    if (!candidates.length) return { status: 'none', reason: 'no_candidates' };

    const choice = await chooseVisualClickCandidateWithLlm(task, decision, observation, guardNote, candidates);
    if (!choice) return { status: 'none', reason: 'llm_no_confident_choice' };

    browserLog('visual_layout_choice', {
        label: choice.candidate.label,
        controlIndex: choice.candidate.controlIndex,
        bbox: choice.candidate.bbox,
        confidence: choice.confidence,
        modalLike: choice.candidate.modalLike,
        reason: choice.reason.slice(0, 240),
    });

    try {
        await clickVisualCandidate(page, choice.candidate);
        return {
            status: 'clicked',
            label: choice.candidate.label,
            controlIndex: choice.candidate.controlIndex,
            reason: choice.reason,
        };
    } catch (err) {
        return { status: 'failed', reason: safeErrorMessage(err) };
    }
}

function choicesFromTaskScopedCandidates(candidates: TaskScopedActionCandidate[]): BrowserUserChoice[] {
    return candidates.slice(0, 4).map((candidate) => {
        const contextLabel = compactContextLabel(candidate.context, `${candidate.controlLabel}: ${candidate.matchedHints.join(', ')}`);
        const hintPrefix = candidate.matchedHints.length ? `${candidate.matchedHints.join(', ')} — ` : '';
        const label = `${hintPrefix}${contextLabel}`.slice(0, 180);
        return {
            label: `Выбрать: ${label}`,
            answer: `Нажми «${candidate.controlLabel}» в блоке: ${label}.`,
        };
    });
}

async function chooseTaskScopedCandidateWithLlm(
    task: string,
    intent: TaskScopedActionIntent,
    hints: string[],
    candidates: TaskScopedActionCandidate[]
): Promise<TaskScopedActionCandidate | null> {
    if (candidates.length < 2) return candidates[0] ?? null;

    const payload = {
        task: redactSecrets(task).slice(0, 1800),
        intent: intent.description,
        targetHints: hints.slice(0, 8),
        candidates: candidates.slice(0, 6).map((candidate, index) => ({
            index,
            controlLabel: candidate.controlLabel,
            matchedHints: candidate.matchedHints,
            score: candidate.score,
            context: redactSecrets(candidate.context).slice(0, 900),
        })),
    };

    try {
        const response = await createChatCompletionForTask('browserPlanning', {
            max_completion_tokens: 240,
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Ты выбираешь один блок интерфейса для браузерного агента.',
                        'Нужно выбрать candidate.index, если контекст кандидата явно соответствует объекту/дате/условию из задачи пользователя.',
                        'Не выбирай по одной только одинаковой кнопке действия. Сравнивай название объекта, номер, дату, место, строку таблицы, карточку и соседний текст.',
                        'Если ни один кандидат явно не лучше или данные противоречат задаче, верни choice=null.',
                        'Ответ строго JSON: {"choice":0,"confidence":0.0,"reason":"..."}',
                    ].join(' '),
                },
                { role: 'user', content: JSON.stringify(payload) },
            ],
        });
        const parsed = parseLLMJson<{ choice?: number | null; confidence?: number; reason?: string }>(
            response.choices[0]?.message?.content?.trim() || ''
        );
        const choice = parsed?.choice;
        const confidence = Number(parsed?.confidence ?? 0);
        if (Number.isInteger(choice) && choice! >= 0 && choice! < Math.min(candidates.length, 6) && confidence >= 0.62) {
            return candidates[choice!];
        }
        devLog('browserAgent: task-scoped candidate remained ambiguous:', parsed);
    } catch (err) {
        devLog('browserAgent: task-scoped candidate LLM choice failed:', safeErrorMessage(err));
    }

    return null;
}

async function maybeUseTaskScopedAction(page: Page, task: string): Promise<TaskScopedActionResult> {
    const intent = inferTaskScopedActionIntent(task);
    if (!intent) return { status: 'none', reason: 'action_intent_not_found' };
    if (intent.highImpact) return { status: 'none', reason: 'high_impact_action' };

    const hints = taskScopedHints(task, intent);
    browserLog('task_scoped_probe', { intent: intent.description, hints: hints.join(', ') });
    if (!hints.some((hint) => !isRussianDateHint(hint))) {
        return { status: 'none', reason: 'target_hint_not_found' };
    }

    try {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidates = await getTaskScopedActionCandidates(page, intent, hints);
            browserLog('task_scoped_candidates', {
                attempt: attempt + 1,
                count: candidates.length,
                best: summarizeCandidate(candidates[0]),
                second: summarizeCandidate(candidates[1]),
            });
            if (candidates.length) {
                const best = candidates[0];
                const second = candidates[1];
                if (!second || (best.score >= 145 && best.score >= second.score + 12)) {
                    await clickVisibleControlByIndex(page, best.controlIndex);
                    return {
                        status: 'clicked',
                        label: compactContextLabel(best.context, best.controlLabel),
                        controlLabel: best.controlLabel,
                    };
                }

                const llmChoice = await chooseTaskScopedCandidateWithLlm(task, intent, hints, candidates);
                if (llmChoice) {
                    await clickVisibleControlByIndex(page, llmChoice.controlIndex);
                    return {
                        status: 'clicked',
                        label: compactContextLabel(llmChoice.context, llmChoice.controlLabel),
                        controlLabel: llmChoice.controlLabel,
                    };
                }

                return { status: 'none', reason: 'ambiguous_task_scoped_internal' };
            }

            const targetPresentInDom = await documentContainsAnySearchHint(page, hints);
            if (!targetPresentInDom) {
                browserLog('task_scoped_stop', { reason: 'target_hint_not_present_in_dom', hints: hints.join(', ') });
                return { status: 'none', reason: 'target_hint_not_present_in_dom' };
            }

            const canScroll = await page.evaluate(() => window.scrollY + window.innerHeight < document.body.scrollHeight - 20).catch(() => false);
            if (!canScroll) break;
            await page.evaluate(() => window.scrollBy(0, Math.max(650, Math.floor(window.innerHeight * 0.85)))).catch(() => {});
            await page.waitForTimeout(450);
        }

        return { status: 'none', reason: 'target_block_action_not_found' };
    } catch (err) {
        browserLog('task_scoped_failed', { reason: safeErrorMessage(err) });
        return { status: 'failed', reason: safeErrorMessage(err) };
    }
}

async function getTargetBlockClickCandidates(
    page: Page,
    clickLabel: string,
    hints: string[]
): Promise<ContextualClickCandidate[]> {
    const primaryHints = hints.filter((hint) => !isRussianDateHint(hint)).slice(0, 4);
    const secondaryHints = hints.filter((hint) => !primaryHints.includes(hint)).slice(0, 6);
    if (!primaryHints.length) return [];

    return page.evaluate(({ targetLabel, primaryHints: rawPrimaryHints, secondaryHints: rawSecondaryHints }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const genericHintTokens = new Set([
            'игра', 'игру', 'игры', 'игре',
            'квиз', 'квиза', 'квизу',
            'карточка', 'карточку', 'карточке', 'блок', 'блока', 'блоке',
            'кнопка', 'кнопку', 'кнопке', 'ссылка', 'ссылку', 'ссылке',
            'записаться', 'запись', 'запиши', 'зарегистрироваться', 'регистрация',
        ]);
        const tokenStem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            value = value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
            return value;
        };
        const meaningfulTokenStems = (value: string) =>
            normalize(value)
                .split(/[^a-zа-яё0-9#№]+/iu)
                .map((token) => ({ raw: token, stem: tokenStem(token) }))
                .filter((token) => token.raw.length >= 3 && token.stem.length >= 3 && !genericHintTokens.has(token.raw))
                .map((token) => token.stem);
        const stemsOverlap = (left: string, right: string) => {
            if (left.length >= 4 && right.length >= 4) {
                return left === right || left.startsWith(right) || right.startsWith(left);
            }
            return left === right;
        };
        const textMatchesHint = (text: string, hint: { norm: string; stems: string[] }) => {
            const normalizedText = normalize(text);
            if (hint.norm && normalizedText.includes(hint.norm)) return true;
            if (!hint.stems.length) return false;
            const textStems = meaningfulTokenStems(normalizedText);
            return hint.stems.every((hintStem) => textStems.some((textStem) => stemsOverlap(textStem, hintStem)));
        };
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const labelMatches = (label: string) => {
            const labelNorm = normalize(label);
            const targetNorm = normalize(targetLabel);
            if (!labelNorm || !targetNorm) return false;
            return labelNorm === targetNorm || labelNorm.includes(targetNorm) || targetNorm.includes(labelNorm);
        };
        const allControls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => isVisible(el) && labelMatches(textOf(el)));
        const primaryHints = rawPrimaryHints
            .map((hint) => ({ raw: hint, norm: normalize(hint), stems: meaningfulTokenStems(hint) }))
            .filter((hint) => hint.norm.length >= 3 || hint.stems.length > 0);
        const secondaryHints = rawSecondaryHints
            .map((hint) => ({ raw: hint, norm: normalize(hint), stems: meaningfulTokenStems(hint) }))
            .filter((hint) => hint.norm.length >= 3 || hint.stems.length > 0);

        const elements = Array.from(document.querySelectorAll('body *'))
            .filter((el) => isVisible(el)) as HTMLElement[];
        const candidates: ContextualClickCandidate[] = [];

        for (const hint of primaryHints) {
            const targetElements = elements
                .map((el) => ({ el, text: compact(el.innerText || el.textContent) }))
                .filter(({ text }) => text && textMatchesHint(text, hint))
                .sort((a, b) => a.text.length - b.text.length)
                .slice(0, 80);

            for (const { el: targetElement } of targetElements) {
                let parent: HTMLElement | null = targetElement;
                for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
                    const context = compact(parent.innerText || parent.textContent);
                    if (!context || !textMatchesHint(context, hint)) continue;

                    const controlsInBlock = allControls.filter((control) => parent!.contains(control));
                    if (!controlsInBlock.length) continue;

                    const rect = parent.getBoundingClientRect();
                    const interactiveCount = parent.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').length;
                    const reasonable =
                        context.length <= 2200 &&
                        controlsInBlock.length <= 4 &&
                        interactiveCount <= 24 &&
                        rect.width <= window.innerWidth * 1.05 &&
                        rect.height <= window.innerHeight * 2.8;
                    if (!reasonable) continue;

                    const matchedHints = [hint.raw];
                    let score = 90 - depth * 4 - Math.min(18, Math.floor(context.length / 250)) - (controlsInBlock.length - 1) * 12;
                    const normalizedContext = normalize(context);
                    for (const secondary of secondaryHints) {
                        if (textMatchesHint(normalizedContext, secondary)) {
                            matchedHints.push(secondary.raw);
                            score += 24;
                        }
                    }

                    const targetRect = targetElement.getBoundingClientRect();
                    const bestControl = controlsInBlock
                        .map((control) => {
                            const controlRect = control.getBoundingClientRect();
                            const verticalDistance = Math.abs((controlRect.top + controlRect.bottom) / 2 - (targetRect.top + targetRect.bottom) / 2);
                            return { control, verticalDistance };
                        })
                        .sort((a, b) => a.verticalDistance - b.verticalDistance)[0]?.control;
                    const controlIndex = bestControl ? allControls.indexOf(bestControl) : -1;
                    if (controlIndex < 0) continue;

                    candidates.push({
                        controlIndex,
                        label: textOf(bestControl),
                        context: context.slice(0, 900),
                        matchedHints,
                        score,
                    });
                    break;
                }
            }
        }

        const seen = new Set<number>();
        return candidates
            .sort((a, b) => b.score - a.score)
            .filter((candidate) => {
                if (seen.has(candidate.controlIndex)) return false;
                seen.add(candidate.controlIndex);
                return true;
            })
            .slice(0, 8);
    }, { targetLabel: clickLabel, primaryHints, secondaryHints });
}

async function maybeUseTargetBlockClick(
    page: Page,
    task: string,
    decision: BrowserAction
): Promise<ContextualClickResult> {
    const clickLabel = clickLabelFromDecision(decision);
    if (!clickLabel) return { status: 'none', reason: 'click_label_not_found' };

    const hints = extractContextualClickHints(task, decision, clickLabel)
        .filter((hint) => !isRussianDateHint(hint))
        .filter((hint) => normalizeSearchText(hint) !== normalizeSearchText(clickLabel));
    browserLog('target_block_probe', { clickLabel, hints: hints.join(', ') });
    if (!hints.length) {
        return { status: 'none', reason: 'target_hint_not_found' };
    }

    try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const candidates = await getTargetBlockClickCandidates(page, clickLabel, hints);
            browserLog('target_block_candidates', {
                attempt: attempt + 1,
                clickLabel,
                count: candidates.length,
                best: summarizeCandidate(candidates[0]),
                second: summarizeCandidate(candidates[1]),
            });
            if (candidates.length) {
                const best = candidates[0];
                const second = candidates[1];
                if (!second || (best.score >= 40 && best.score >= second.score + 10)) {
                    await clickContextualControlByIndex(page, clickLabel, best.controlIndex);
                    return {
                        status: 'clicked',
                        label: compactContextLabel(best.context, best.label),
                    };
                }
                const llmChoice = await chooseContextualCandidateWithLlm(
                    task,
                    clickLabel,
                    hints,
                    candidates,
                    'target block candidates have similar scores'
                );
                if (llmChoice) {
                    await clickContextualControlByIndex(page, clickLabel, llmChoice.controlIndex);
                    return {
                        status: 'clicked',
                        label: compactContextLabel(llmChoice.context, llmChoice.label),
                    };
                }
                return { status: 'none', reason: 'ambiguous_target_block_internal' };
            }

            const canScroll = await page.evaluate(() => window.scrollY + window.innerHeight < document.body.scrollHeight - 20).catch(() => false);
            if (!canScroll) break;
            await page.evaluate(() => window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8)))).catch(() => {});
            await page.waitForTimeout(450);
        }

        return { status: 'none', reason: 'target_block_not_found' };
    } catch (err) {
        browserLog('target_block_failed', { clickLabel, reason: safeErrorMessage(err) });
        return { status: 'failed', reason: safeErrorMessage(err) };
    }
}

async function getContextualClickCandidates(
    page: Page,
    clickLabel: string,
    hints: string[]
): Promise<ContextualClickCandidate[]> {
    return page.evaluate(({ targetLabel, rawHints }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const genericHintTokens = new Set([
            'игра', 'игру', 'игры', 'игре',
            'квиз', 'квиза', 'квизу',
            'карточка', 'карточку', 'карточке', 'блок', 'блока', 'блоке',
            'кнопка', 'кнопку', 'кнопке', 'ссылка', 'ссылку', 'ссылке',
            'записаться', 'запись', 'запиши', 'зарегистрироваться', 'регистрация',
        ]);
        const tokenStem = (token: string) => {
            let value = normalize(token).replace(/^['"«»“”#№]+|['"«»“”#№]+$/gu, '');
            if (value.length <= 4 || /^\d+$/u.test(value)) return value;
            value = value
                .replace(/(?:ыми|ими|ого|его|ому|ему|ами|ями|иях|ьях|ах|ях)$/u, '')
                .replace(/(?:ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ую|юю|ом|ем|ых|их)$/u, '')
                .replace(/(?:а|я|у|ю|е|ы|и|о)$/u, '');
            return value;
        };
        const meaningfulTokenStems = (value: string) =>
            normalize(value)
                .split(/[^a-zа-яё0-9#№]+/iu)
                .map((token) => ({ raw: token, stem: tokenStem(token) }))
                .filter((token) => token.raw.length >= 3 && token.stem.length >= 3 && !genericHintTokens.has(token.raw))
                .map((token) => token.stem);
        const stemsOverlap = (left: string, right: string) => {
            if (left.length >= 4 && right.length >= 4) {
                return left === right || left.startsWith(right) || right.startsWith(left);
            }
            return left === right;
        };
        const textMatchesHint = (normalizedContext: string, hint: { norm: string; stems: string[] }) => {
            if (hint.norm && normalizedContext.includes(hint.norm)) return true;
            if (!hint.stems.length) return false;
            const textStems = meaningfulTokenStems(normalizedContext);
            return hint.stems.every((hintStem) => textStems.some((textStem) => stemsOverlap(textStem, hintStem)));
        };
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const labelMatches = (label: string) => {
            const labelNorm = normalize(label);
            const targetNorm = normalize(targetLabel);
            if (!labelNorm || !targetNorm) return false;
            return labelNorm === targetNorm || labelNorm.includes(targetNorm) || targetNorm.includes(labelNorm);
        };
        const hintTokens = rawHints.map((hint) => ({
            raw: hint,
            norm: normalize(hint),
            tokens: normalize(hint).split(/[^a-zа-яё0-9#№]+/iu).filter((token) => token.length >= 3),
            stems: meaningfulTokenStems(hint),
        })).filter((hint) => hint.norm.length >= 3 || hint.stems.length > 0);

        const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => isVisible(el) && labelMatches(textOf(el)));

        const scoreContext = (normalizedContext: string, contextLength: number, depth: number) => {
            const matchedHints: string[] = [];
            let score = 0;
            for (const hint of hintTokens) {
                if (normalizedContext.includes(hint.norm)) {
                    score += 35 + Math.min(20, hint.norm.length);
                    matchedHints.push(hint.raw);
                    continue;
                }
                if (textMatchesHint(normalizedContext, hint)) {
                    score += 30 + Math.min(18, hint.stems.join('').length);
                    matchedHints.push(hint.raw);
                    continue;
                }
                if (!hint.tokens.length) continue;
                const hits = hint.tokens.filter((token) => normalizedContext.includes(token)).length;
                if (hits === hint.tokens.length) {
                    score += 16;
                    matchedHints.push(hint.raw);
                } else if (hits > 0) {
                    score += hits * 4;
                }
            }
            score -= Math.min(12, Math.floor(contextLength / 300));
            score -= depth * 2;
            return { score, matchedHints };
        };

        return controls.map((control, controlIndex) => {
            const label = textOf(control);
            let parent = control.parentElement;
            let context = '';
            let bestScore = Number.NEGATIVE_INFINITY;
            let bestMatchedHints: string[] = [];
            for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
                const text = compact(parent.innerText || parent.textContent);
                if (!text || text === label) continue;

                const rect = parent.getBoundingClientRect();
                const interactiveCount = parent.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]').length;
                const reasonable =
                    text.length <= 1800 &&
                    interactiveCount <= 18 &&
                    rect.width <= window.innerWidth * 0.98 &&
                    rect.height <= window.innerHeight * 2.4;

                if (!reasonable) continue;

                const scored = scoreContext(normalize(text), text.length, depth);
                if (scored.score > bestScore || !context) {
                    context = text;
                    bestScore = scored.score;
                    bestMatchedHints = scored.matchedHints;
                }
            }
            if (!context) {
                context = compact((control.parentElement as HTMLElement | null)?.innerText || label);
                const scored = scoreContext(normalize(context), context.length, 0);
                bestScore = scored.score;
                bestMatchedHints = scored.matchedHints;
            }

            return {
                controlIndex,
                label,
                context: context.slice(0, 900),
                matchedHints: bestMatchedHints,
                score: bestScore,
            };
        }).sort((a, b) => b.score - a.score).slice(0, 8);
    }, { targetLabel: clickLabel, rawHints: hints });
}

async function clickContextualControlByIndex(page: Page, clickLabel: string, controlIndex: number): Promise<void> {
    const handle = await page.evaluateHandle(({ targetLabel, targetIndex }) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const targetNorm = normalize(targetLabel);
        const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => {
                const labelNorm = normalize(textOf(el));
                return isVisible(el) && labelNorm && targetNorm && (labelNorm === targetNorm || labelNorm.includes(targetNorm) || targetNorm.includes(labelNorm));
            });
        return controls[targetIndex] ?? null;
    }, { targetLabel: clickLabel, targetIndex: controlIndex });

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        throw new Error(`Не найден контекстный элемент "${clickLabel}" index=${controlIndex}`);
    }

    try {
        await clickLocatorLikeUser(page, element);
    } finally {
        await handle.dispose();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

function choicesFromContextualCandidates(candidates: ContextualClickCandidate[]): BrowserUserChoice[] {
    return candidates.slice(0, 4).map((candidate) => {
        const hintLabel = candidate.matchedHints.length ? `${candidate.label}: ${candidate.matchedHints.join(', ')}` : candidate.label;
        const label = compactContextLabel(candidate.context, hintLabel);
        return {
            label: `Выбрать: ${label}`,
            answer: `Нажми «${candidate.label}» в блоке: ${label}.`,
        };
    });
}

async function chooseContextualCandidateWithLlm(
    task: string,
    clickLabel: string,
    hints: string[],
    candidates: ContextualClickCandidate[],
    reason: string
): Promise<ContextualClickCandidate | null> {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const payload = {
        task: redactSecrets(task).slice(0, 1800),
        clickLabel,
        targetHints: hints.slice(0, 8),
        ambiguityReason: reason,
        candidates: candidates.slice(0, 6).map((candidate, index) => ({
            index,
            label: candidate.label,
            matchedHints: candidate.matchedHints,
            score: candidate.score,
            context: redactSecrets(candidate.context).slice(0, 900),
        })),
    };

    try {
        const response = await createChatCompletionForTask('browserPlanning', {
            max_completion_tokens: 260,
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: [
                        'Ты внутренний арбитр браузерного агента.',
                        'Пользователя нельзя спрашивать про DOM/UI-неоднозначность: нужно либо выбрать лучший кандидат, либо вернуть null, чтобы агент сменил стратегию.',
                        'Выбирай candidate.index только если контекст явно помогает выполнить исходную задачу.',
                        'Не выбирай элемент только потому, что совпадает текст кнопки; учитывай цель, соседний текст, хлебные крошки, карточку, категорию и риск зациклиться.',
                        'Если варианты одинаковые, ведут в меню вместо товара/формы, или выбор не приближает к цели, верни choice=null.',
                        'Ответ строго JSON: {"choice":0,"confidence":0.0,"reason":"..."}',
                    ].join(' '),
                },
                { role: 'user', content: JSON.stringify(payload) },
            ],
        });
        const parsed = parseLLMJson<{ choice?: number | null; confidence?: number; reason?: string }>(
            response.choices[0]?.message?.content?.trim() || ''
        );
        const choice = parsed?.choice;
        const confidence = Number(parsed?.confidence ?? 0);
        const llmReason = cleanWhitespace(parsed?.reason || '');
        browserLog('contextual_llm_choice', {
            clickLabel,
            choice,
            confidence,
            reason: llmReason.slice(0, 240),
        });
        if (Number.isInteger(choice) && choice! >= 0 && choice! < Math.min(candidates.length, 6) && confidence >= 0.64) {
            return candidates[choice!];
        }
    } catch (err) {
        browserLog('contextual_llm_choice_failed', {
            clickLabel,
            reason: safeErrorMessage(err),
        });
    }

    return null;
}

async function maybeUseContextualClick(
    page: Page,
    task: string,
    decision: BrowserAction
): Promise<ContextualClickResult> {
    const clickLabel = clickLabelFromDecision(decision);
    if (!clickLabel) return { status: 'none', reason: 'click_label_not_found' };

    const hints = extractContextualClickHints(task, decision, clickLabel)
        .filter((hint) => normalizeSearchText(hint) !== normalizeSearchText(clickLabel));
    browserLog('contextual_probe', { clickLabel, hints: hints.join(', ') });
    if (!hints.length) return { status: 'none', reason: 'context_hints_not_found' };

    try {
        const candidates = await getContextualClickCandidates(page, clickLabel, hints);
        browserLog('contextual_candidates', {
            clickLabel,
            count: candidates.length,
            best: summarizeCandidate(candidates[0]),
            second: summarizeCandidate(candidates[1]),
        });
        if (candidates.length < 2) return { status: 'none', reason: 'not_a_duplicate_click' };

        const best = candidates[0];
        const second = candidates[1];
        if (best.score >= 18 && best.score >= second.score + 8) {
            await clickContextualControlByIndex(page, clickLabel, best.controlIndex);
            return {
                status: 'clicked',
                label: compactContextLabel(best.context, best.label),
            };
        }

        if (best.score > 0) {
            const scoredCandidates = candidates.filter((candidate) => candidate.score > 0);
            const llmChoice = await chooseContextualCandidateWithLlm(
                task,
                clickLabel,
                hints,
                scoredCandidates,
                'duplicate contextual controls'
            );
            if (llmChoice) {
                await clickContextualControlByIndex(page, clickLabel, llmChoice.controlIndex);
                return {
                    status: 'clicked',
                    label: compactContextLabel(llmChoice.context, llmChoice.label),
                };
            }
            return { status: 'none', reason: 'ambiguous_contextual_click_internal' };
        }

        return { status: 'none', reason: 'no_contextual_score' };
    } catch (err) {
        browserLog('contextual_failed', { clickLabel, reason: safeErrorMessage(err) });
        return { status: 'failed', reason: safeErrorMessage(err) };
    }
}

async function guardRawClickAgainstTargetContext(
    page: Page,
    task: string,
    decision: BrowserAction
): Promise<RawClickGuardResult> {
    if (decision.action !== 'click') return { status: 'none', reason: 'not_click' };

    const clickLabel = clickLabelFromDecision(decision);
    if (!clickLabel) return { status: 'none', reason: 'no_click_label' };

    const hints = extractContextualClickHints(task, decision, clickLabel)
        .filter((hint) => !isRussianDateHint(hint))
        .filter((hint) => normalizeSearchText(hint) !== normalizeSearchText(clickLabel));
    if (!hints.length) return { status: 'none', reason: 'no_target_hints' };

    const targetPresent = await documentContainsAnySearchHint(page, hints);
    browserLog('raw_click_guard_probe', { clickLabel, hints: hints.join(', '), targetPresent });
    if (!targetPresent) return { status: 'none', reason: 'target_not_present' };

    try {
        const candidates = await getContextualClickCandidates(page, clickLabel, hints);
        browserLog('raw_click_guard_candidates', {
            clickLabel,
            count: candidates.length,
            best: summarizeCandidate(candidates[0]),
            second: summarizeCandidate(candidates[1]),
        });
        if (!candidates.length) {
            return {
                status: 'blocked',
                note: `Сырой клик "${clickLabel}" заблокирован: на странице есть целевой объект (${hints.join(', ')}), но не найдено кнопки/ссылки "${clickLabel}" в его контекстном блоке. Нужно сначала найти правильный блок или перейти на детальную страницу.`,
            };
        }

        const best = candidates[0];
        const second = candidates[1];
        const bestMatchesTarget = best.score > 0 && best.matchedHints.length > 0;
        if (candidates.length === 1 && bestMatchesTarget) {
            return { status: 'none', reason: 'single_contextual_match' };
        }

        if (candidates.length > 1 && bestMatchesTarget && second && best.score >= second.score + 8) {
            return { status: 'none', reason: 'contextual_match_clear' };
        }

        const choices = choicesFromContextualCandidates(candidates.filter((candidate) => candidate.score > 0));
        return {
            status: 'blocked',
            question: choices.length
                ? `Перед кликом «${clickLabel}» нужно выбрать правильный блок: на странице есть целевой объект (${hints.join(', ')}), а одинаковых/похожих действий несколько.`
                : undefined,
            choices,
            note: choices.length
                ? `Сырой клик "${clickLabel}" заблокирован: есть целевые подсказки (${hints.join(', ')}), но выбор между похожими действиями не был достаточно надёжным.`
                : `Сырой клик "${clickLabel}" заблокирован: ближайший найденный элемент не находится в блоке с целевым объектом (${hints.join(', ')}). Сначала найди блок по тексту/DOM/context, затем действие внутри него.`,
        };
    } catch (err) {
        browserLog('raw_click_guard_failed', { clickLabel, reason: safeErrorMessage(err) });
        return { status: 'failed', reason: safeErrorMessage(err) };
    }
}

const RUSSIAN_DATE_RE = /(?<![\p{L}\p{N}_])\d{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?![\p{L}\p{N}_])/iu;

function cleanTaskTargetName(raw: string): string {
    return cleanWhitespace(raw)
        .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
        .replace(/\s+\d{1,2}\s*(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?![\p{L}\p{N}_]).*$/iu, '')
        .replace(/^(?:это|эту|этот|его|е[её]|объект|блок|карточк[ауи]?|строк[ауи]?|элемент[еау]?|пункт|вариант|кнопк[аеуи]?|ссылк[аеуи]?|button|link|control|товар|заказ|проект|задач[ауи]?|игр[ауыеи]?|квиз[ауе]?|мероприятие|событие)\s+/iu, '')
        .replace(/^(?:перейти|подробнее|открыть|посмотреть|details|open|view)\s+(?:у|в|на|для|по|около|возле|рядом\s+с)\s+/iu, '')
        .replace(/\s+(?:на|в)\s+(?:\d{1,2}\s*)?(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?![\p{L}\p{N}_]).*$/iu, '')
        .replace(/\s+(?:перейти|подробнее|открыть|посмотреть|details|open|view)$/iu, '')
        .replace(/\s*[-–—:]\s*$/u, '')
        .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
        .trim();
}

function extractDateNearTaskTarget(text: string, name: string): string | undefined {
    const escapedName = escapeRegExp(name);
    const nearAfter = text.match(new RegExp(`${escapedName}[\\s\\S]{0,120}?(${RUSSIAN_DATE_RE.source})`, 'iu'))?.[1];
    if (nearAfter) return cleanWhitespace(nearAfter);

    const nearBefore = text.match(new RegExp(`(${RUSSIAN_DATE_RE.source})[\\s\\S]{0,120}?${escapedName}`, 'iu'))?.[1];
    if (nearBefore) return cleanWhitespace(nearBefore);

    return text.match(RUSSIAN_DATE_RE)?.[0] ? cleanWhitespace(text.match(RUSSIAN_DATE_RE)![0]) : undefined;
}

function extractTaskTextTarget(text: string): TaskTextTarget | null {
    const source = text.slice(0, 7000);
    const answer = browserTaskUserAnswerFromText(source);
    const searchText = [answer, source].filter(Boolean).join('\n');
    const isGenericTarget = (value: string) => {
        const normalized = normalizeSearchText(value);
        if (/https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}/iu.test(normalized)) return true;
        if (/(?:^|\s)(?:браузер|браузере|сайт|страниц[аеу]?|расписани[еяю]?|homepage|website|page)(?:$|\s)/iu.test(normalized)) return true;
        return /^(запись\/регистрация|запись|регистрация|записаться(?:\s+на\s+игру)?|зарегистрироваться|забронировать|перейти|подробнее|открыть|выбрать|кнопка|ссылка|блок|карточка|вариант|да(?:[,\s]+подтверждаю)?|нет|подтверждаю|отмена|продолжай|stop|cancel|ок|okay)$/iu.test(normalized);
    };

    const registrationPatterns = [
        /(?:запиши|запис(?:аться|ываемся|ать)?|зарегистрируй|зарегистрироваться|забронируй|забронировать|book|reserve|register|sign\s*up|join)\s+(?:меня|нас|нам|мне|себя)?\s*(?:(?:на|в|к|по|для)\s+)?(?:(?:игр[ауыеи]?|квиз[ауе]?|мероприятие|событие|тур|матч|сеанс)\s+)?([^.\n!?;,]{3,90})/giu,
    ];
    const genericPatterns = [
        /(?:нажми|кликни|выбери|открой|перейди|заполни|отправь|сохрани|удали|измени|запиши|забронируй|зарегистрируй|добавь)\s+(?:меня|нас|нам|мне|себя|это|эту|этот|его|е[её])?\s*(?:(?:на|в|к|по|для)\s+)?(?:(?:кнопк[аеуи]?|ссылк[аеуи]?|элемент[еау]?|вариант|button|link|control)\s+)?([^.\n!?;,]{3,90})/giu,
        /(?:в|на|у|для|по)\s+(?:строк[еауи]?|карточк[еауи]?|блок[еауи]?|ряду|запис[иь]|элемент[еауи]?|пункт[еауи]?|вариант[еауи]?|заказ[еауи]?|товар[еауи]?|пользовател[еяю]?|клиент[еау]?|проект[еау]?|задач[еауи]?|позици[иею])\s*[:#№-]?\s*([^.\n!?;,]{3,90})/giu,
        /(?:row|card|block|item|record|order|product|user|customer|project|task)\s*[:#-]?\s*([^.\n!?;,]{3,90})/giu,
    ];

    const toTarget = (raw?: string): TaskTextTarget | null => {
        const name = raw ? cleanTaskTargetName(raw) : '';
        const normalizedName = normalizeSearchText(name);
        if (!name || normalizedName.length < 3) return null;
        if (/^(сайт|страниц|форма|кнопк|ссылк|ближайш|список|таблиц|меню|интерфейс)$/iu.test(normalizedName) || isGenericTarget(name)) return null;
        return {
            name,
            dateText: extractDateNearTaskTarget(searchText, name),
        };
    };

    const quotedTargetFrom = (surface: string): TaskTextTarget | null => {
        for (const match of surface.matchAll(/[«“"]([^«»“”"\n]{3,90})[»”"]/gu)) {
            const target = toTarget(match[1]);
            if (target) return target;
        }
        for (const match of surface.matchAll(/'([^'\n]{3,90})'/gu)) {
            const target = toTarget(match[1]);
            if (target) return target;
        }
        return null;
    };

    const patternTargetFrom = (surface: string): TaskTextTarget | null => {
        for (const patternGroup of [registrationPatterns, genericPatterns]) {
            for (const pattern of patternGroup) {
                pattern.lastIndex = 0;
                for (const match of surface.matchAll(pattern)) {
                    const target = toTarget(match[1]);
                    if (target) return target;
                }
            }
        }
        return null;
    };

    if (answer) {
        const answerTarget = quotedTargetFrom(answer) || patternTargetFrom(answer);
        if (answerTarget) return answerTarget;
    }

    const quotedTarget = quotedTargetFrom(searchText);
    if (quotedTarget) return quotedTarget;

    const patternTarget = patternTargetFrom(searchText);
    if (patternTarget) return patternTarget;

    return null;
}

function normalizeBrowserUserChoice(raw: string | { label?: string; value?: string; answer?: string; message?: string }): BrowserUserChoice | null {
    if (typeof raw === 'string') {
        const text = cleanWhitespace(raw);
        return text ? { label: text, answer: text } : null;
    }

    const label = cleanWhitespace(raw.label || raw.value || raw.answer || raw.message || '');
    const answer = cleanWhitespace(raw.answer || raw.message || raw.value || raw.label || '');
    if (!label || !answer) return null;
    return { label, answer };
}

function choicesFromDecision(decision: BrowserAction): BrowserUserChoice[] {
    return (decision.choices ?? [])
        .map(normalizeBrowserUserChoice)
        .filter((choice): choice is BrowserUserChoice => Boolean(choice))
        .slice(0, 4);
}

function stripTrailingButtons(text: string, buttons: string[]): string {
    let cleaned = cleanWhitespace(text);
    for (const button of [...buttons].reverse()) {
        cleaned = cleaned.replace(new RegExp(`\\s*${escapeRegExp(button)}\\s*$`, 'iu'), '').trim();
    }
    return cleaned;
}

function isSiteNavigationButtonLabel(label: string): boolean {
    return /^(главная|расписание|рейтинг|франшиза|корпоративы|сертификаты|квиз\s*дома|детский\s+день\s+рождения|москва|санкт-петербург|онлайн|online|faq|контакты|вакансии)$/iu.test(cleanWhitespace(label));
}

function modalBlockHasDecisionIntent(question: string, buttons: string[]): boolean {
    const surface = normalizeSearchText([question, ...buttons].join(' '));
    if (isDismissibleTechnicalOverlayText(surface)) return false;
    return /[?？]/u.test(question) ||
        /(подтверд|confirm|сможете|можете|продолжить|continue|отказ|cancel|бронир|booking|заявк|отправ|соглас|cookie|куки|закрыть|да|нет|ok|ок)/iu.test(surface) ||
        buttons.some((button) => /^(да|yes|ok|ок|нет|no|cancel|отмена|закрыть|продолжить|continue|подтвердить)$/iu.test(cleanWhitespace(button)));
}

function looksLikeNavigationOnlyModalBlock(question: string, buttons: string[]): boolean {
    const surface = normalizeSearchText([question, ...buttons].join(' '));
    const navHits = ['главная', 'расписание', 'рейтинг', 'франшиза', 'корпоративы', 'сертификаты', 'квиз дома', 'детский день рождения']
        .filter((term) => surface.includes(term))
        .length;
    const navButtons = buttons.filter(isSiteNavigationButtonLabel).length;
    const shoppingNavHits = ['идеи', 'новинки', 'одежда', 'обувь', 'аксессуары', 'бренды', 'премиум', 'спорт', 'красота', 'дом', 'скидки']
        .filter((term) => surface.includes(term))
        .length;
    const shoppingNavButtons = buttons.filter((button) =>
        /^(идеи|новинки|одежда|обувь|аксессуары|бренды|премиум|спорт|красота|дом|скидки)$/iu.test(cleanWhitespace(button))
    ).length;
    return navHits >= 4 ||
        shoppingNavHits >= 5 ||
        (buttons.length >= 3 && navButtons >= Math.min(buttons.length, 4)) ||
        (buttons.length >= 4 && shoppingNavButtons >= Math.min(buttons.length, 5));
}

function looksLikePromoListingModalBlock(question: string, buttons: string[]): boolean {
    const surface = normalizeSearchText([question, ...buttons].join(' '));
    const buyButtons = buttons.filter((button) =>
        /(?:^|\s)(?:купить|shop|смотреть|перейти|подробнее)(?:$|\s)/iu.test(normalizeSearchText(button))
    ).length;
    const promoHits = ['для образов', 'внимание к каждой детали', 'расслабленные силуэты', 'легкий трикотаж', 'лёгкий трикотаж', 'все для отдыха', 'всё для отдыха', 'свобода движения', 'аксессуары', 'коллекция', 'премиум']
        .filter((term) => surface.includes(term))
        .length;
    return buttons.length >= 2 &&
        buyButtons >= Math.min(buttons.length, 4) &&
        promoHits >= 2 &&
        !/[?？]/u.test(question) &&
        !/(cookie|куки|consent|соглас|подтверд|confirm|отказ|cancel|заявк|брон|оплат|payment|checkout)/iu.test(surface);
}

function isActionableModalButtonBlock(question: string, buttons: string[]): boolean {
    if (!buttons.length) return false;
    if (looksLikeNavigationOnlyModalBlock(question, buttons)) return false;
    if (looksLikePromoListingModalBlock(question, buttons)) return false;
    return modalBlockHasDecisionIntent(question, buttons);
}

function modalButtonBlocks(observation: PageObservation): Array<{ question: string; buttons: string[] }> {
    if (!observation.modalText) return [];

    return observation.modalText
        .split(/\n(?=\s*modal#\d+)/u)
        .map((block) => {
            const buttonsMatch = block.match(/buttons=\[([^\]]+)\]/u);
            if (!buttonsMatch) return null;
            const buttons = buttonsMatch[1]
                .split('|')
                .map((button) => cleanWhitespace(button))
                .filter(Boolean)
                .slice(0, 4);
            if (!buttons.length) return null;

            const textAfterHeader = block.split('\n').slice(1).join(' ');
            const question = stripTrailingButtons(textAfterHeader || block, buttons).slice(0, 260);
            if (!isActionableModalButtonBlock(question, buttons)) return null;
            return { question, buttons };
        })
        .filter((block): block is { question: string; buttons: string[] } => Boolean(block?.question && block.buttons.length));
}

function modalButtonFromUserAnswer(answer: string, observation: PageObservation): string | null {
    const blocks = modalButtonBlocks(observation);
    if (!blocks.length) return null;

    const normalizedAnswer = normalizeSearchText(answer);
    const quotedButton = answer.match(/[«"“']([^«»“”"'\n]{1,40})[»"”']/u)?.[1];
    const allButtons = blocks.flatMap((block) => block.buttons);
    const byExactLabel = (label: string) =>
        allButtons.find((button) => normalizeSearchText(button) === normalizeSearchText(label));

    if (quotedButton) {
        const quotedMatch = byExactLabel(quotedButton);
        if (quotedMatch) return quotedMatch;
    }

    for (const button of allButtons) {
        const normalizedButton = normalizeSearchText(button);
        if (
            normalizedButton &&
            (normalizedAnswer === normalizedButton ||
                normalizedAnswer.includes(` ${normalizedButton} `) ||
                normalizedAnswer.startsWith(`${normalizedButton} `) ||
                normalizedAnswer.endsWith(` ${normalizedButton}`))
        ) {
            return button;
        }
    }

    if (/(?:^|[^\p{L}\p{N}_])(?:нет|no)(?:$|[^\p{L}\p{N}_])|не\s+(?:смогу|могу|получится)|отказ|cancel/iu.test(normalizedAnswer)) {
        return allButtons.find((button) => /^(нет|no|cancel|отмена)$/iu.test(normalizeSearchText(button))) || null;
    }

    if (/(?:^|[^\p{L}\p{N}_])(?:да|yes|ok|ок|подтверждаю|соглас(?:ен|на)?|смогу|могу)(?:$|[^\p{L}\p{N}_])/iu.test(normalizedAnswer)) {
        return allButtons.find((button) => /^(да|yes|ok|ок|подтвердить)$/iu.test(normalizeSearchText(button))) || null;
    }

    return null;
}

function modalButtonLabelFromFreeformAnswer(answer: string): string | null {
    const normalizedAnswer = normalizeSearchText(answer);
    const quotedButton = answer.match(/[«"“']([^«»“”"'\n]{1,40})[»"”']/u)?.[1];
    if (quotedButton && /^(?:да|нет|yes|no|ok|ок|отмена|cancel|подтвердить)$/iu.test(normalizeSearchText(quotedButton))) {
        return quotedButton;
    }

    if (
        /(?:^|[^\p{L}\p{N}_])(?:нет|no)(?:$|[^\p{L}\p{N}_])|не\s+(?:смогу|могу|получится)|отказ|cancel|(?:жми|нажми|кликни|выбери)\s+(?:нет|no)/iu
            .test(normalizedAnswer)
    ) {
        return 'Нет';
    }

    if (
        /(?:^|[^\p{L}\p{N}_])(?:да|yes|ok|ок|подтверждаю|соглас(?:ен|на)?|смогу|могу)(?:$|[^\p{L}\p{N}_])|(?:жми|нажми|кликни|выбери)\s+(?:да|yes|ok|ок)/iu
            .test(normalizedAnswer)
    ) {
        return 'Да';
    }

    return null;
}

function pageLooksLikeModalChoice(observation: PageObservation): boolean {
    const surface = [observation.modalText, observation.pageText, observation.a11yText, observation.interactiveText].join('\n');
    if (isDismissibleTechnicalOverlayText(surface)) return false;
    return /(?:сможете|можете|подтверд|confirm|отказ|cancel|бронир|booking|заявк|позвон|напис|да\s+нет)/iu.test(surface);
}

function modalButtonFromClickDecision(decision: BrowserAction, observation: PageObservation): { button: string; question: string } | null {
    if (decision.action !== 'click') return null;

    const clickLabel = clickLabelFromDecision(decision);
    if (!clickLabel) return null;

    const blocks = modalButtonBlocks(observation);
    if (!blocks.length) return null;

    const normalizedClick = normalizeSearchText(clickLabel);
    for (const block of blocks) {
        const button = block.buttons.find((candidate) => normalizeSearchText(candidate) === normalizedClick) ||
            block.buttons.find((candidate) => {
                const normalizedButton = normalizeSearchText(candidate);
                return normalizedButton && normalizedClick &&
                    (normalizedButton.includes(normalizedClick) || normalizedClick.includes(normalizedButton));
            });
        if (button) return { button, question: block.question };
    }

    return null;
}

async function clickVisibleModalButtonByLabel(page: Page, label: string): Promise<void> {
    const handle = await page.evaluateHandle((targetLabel) => {
        const compact = (value: string | null | undefined) =>
            String(value ?? '').replace(/\s+/g, ' ').trim();
        const normalize = (value: string) => compact(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
        const isVisible = (el: Element) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const textOf = (el: Element) => {
            const input = el as HTMLInputElement;
            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label') || el.getAttribute('title'));
        };
        const modalRoots = Array.from(document.querySelectorAll([
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog',
            '.modal',
            '[class*="modal" i]',
            '[id*="modal" i]',
            '.popup',
            '[class*="popup" i]',
            '[id*="popup" i]',
            '.overlay',
            '[class*="overlay" i]',
            '[id*="overlay" i]',
            '[class*="dialog" i]',
            '[id*="dialog" i]',
            '[class*="confirm" i]',
            '[id*="confirm" i]',
        ].join(','))).filter(isVisible);
        const roots = modalRoots.length ? modalRoots : [document.body];
        const target = normalize(targetLabel);
        const controls = roots.flatMap((root) =>
            Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
                .filter(isVisible)
        );
        return controls.find((control) => normalize(textOf(control)) === target) ||
            controls.find((control) => {
                const labelNorm = normalize(textOf(control));
                return labelNorm && target && (labelNorm.includes(target) || target.includes(labelNorm));
            }) ||
            null;
    }, label);

    const element = handle.asElement();
    if (!element) {
        await handle.dispose();
        throw new Error(`Не найдена кнопка модального окна "${label}"`);
    }

    try {
        await clickLocatorLikeUser(page, element);
    } finally {
        await handle.dispose();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

function choiceLabelForModalButton(button: string, modalQuestion: string): string {
    const normalized = button.toLowerCase();
    const isBookingCancelQuestion =
        /(отказ|отмен|снять|аннулир)/i.test(modalQuestion) &&
        /(брон|бронир|запис|заявк)/i.test(modalQuestion) &&
        /(позвон|напис|связ)/i.test(modalQuestion);

    if (/^(да|yes|ok)$/i.test(normalized)) {
        return isBookingCancelQuestion ? 'Да, смогу предупредить' : `Нажать «${button}»`;
    }
    if (/^(нет|no)$/i.test(normalized)) {
        return isBookingCancelQuestion ? 'Нет, не смогу предупредить' : `Нажать «${button}»`;
    }
    return `Нажать «${button}»`;
}

function answerForModalButton(button: string, modalQuestion: string): string {
    const normalized = button.toLowerCase();
    const isBookingCancelQuestion =
        /(отказ|отмен|снять|аннулир)/i.test(modalQuestion) &&
        /(брон|бронир|запис|заявк)/i.test(modalQuestion) &&
        /(позвон|напис|связ)/i.test(modalQuestion);

    if (isBookingCancelQuestion && /^(да|yes|ok)$/i.test(normalized)) {
        return `Нажми кнопку «${button}» в открытом окне. Это означает: я смогу позвонить или написать, если решу отказаться от бронирования.`;
    }
    if (isBookingCancelQuestion && /^(нет|no)$/i.test(normalized)) {
        return `Нажми кнопку «${button}» в открытом окне. Это означает: я не смогу предупредить, если решу отказаться от бронирования.`;
    }
    return `Нажми кнопку «${button}» в открытом окне.`;
}

function choicesFromModal(observation: PageObservation): { question: string; choices: BrowserUserChoice[] } | null {
    const blocks = modalButtonBlocks(observation);
    for (const block of blocks) {
        const buttons = block.buttons;
        if (buttons.length < 2) continue;
        const modalQuestion = block.question;

        return {
            question: `На сайте появилось окно:\n«${modalQuestion}»\n\nЧто нажать?`,
            choices: buttons.map((button) => ({
                label: choiceLabelForModalButton(button, modalQuestion),
                answer: answerForModalButton(button, modalQuestion),
            })),
        };
    }

    return null;
}

function rememberSuccessfulSitePattern(
    domain: string,
    state: BrowserRunState,
    observation: PageObservation,
    summary?: string
): void {
    const root = rootDomain(domain);
    if (!root || root === 'about:blank') return;

    const existing = loadBrowserSitePatterns();
    const index = existing.findIndex((pattern) => pattern.domain === root && pattern.flow === 'browser_task');
    const modalPatterns = modalButtonBlocks(observation)
        .map((modal) => ({
            question: redactUserDataForPattern(modal.question).slice(0, 220),
            buttons: modal.buttons.map((button) => redactUserDataForPattern(button).slice(0, 60)),
            preferredButton: modal.buttons.find((button) => /^(да|yes|ok|ок|подтвердить|continue|продолжить)$/iu.test(normalizeSearchText(button))),
        }))
        .slice(0, 4);
    const successEvidence = [
        state.pageUnderstanding?.successEvidence || '',
        ...(state.pageUnderstanding?.evidence || []),
        ...state.evidenceStash.filter((item) => item.type === 'success').slice(-4).map((item) => item.text),
        summary || '',
    ]
        .map((item) => redactUserDataForPattern(item))
        .map((item) => cleanWhitespace(item).slice(0, 220))
        .filter(Boolean)
        .slice(0, 6);
    const notes = [
        ...(state.taskLedger?.pending?.length ? [`pending before success: ${state.taskLedger.pending.join(', ')}`] : []),
        ...(state.taskPlan?.length ? [`plan: ${state.taskPlan.map((step) => `${step.id}:${step.status}`).join(', ')}`] : []),
    ].map((item) => redactUserDataForPattern(item).slice(0, 240));

    const next: BrowserSitePattern = {
        domain: root,
        flow: 'browser_task',
        updatedAt: new Date().toISOString(),
        successEvidence: successEvidence.length ? successEvidence : undefined,
        modalPatterns: modalPatterns.length ? modalPatterns : undefined,
        notes: notes.length ? notes : undefined,
    };

    if (index >= 0) existing[index] = { ...existing[index], ...next };
    else existing.unshift(next);
    saveBrowserSitePatterns(existing);
    browserLog('site_pattern_saved', {
        domain: root,
        successEvidence: successEvidence.join(' | ').slice(0, 220),
        modals: modalPatterns.length,
    });
}

function detectedSuccessSummary(state: BrowserRunState, task: string): string | null {
    const hasMeaningfulAction = state.history.some((record) =>
        record.result === 'ok' &&
        !record.label.startsWith('memory_lookup') &&
        record.label !== 'note' &&
        !record.label.startsWith('restore_previous_url')
    );
    if (!hasMeaningfulAction) return null;

    const understanding = state.pageUnderstanding;
    if (
        understanding?.phase === 'success' &&
        understanding.confidence >= 0.74 &&
        (understanding.successEvidence || understanding.evidence.length)
    ) {
        const evidence = understanding.successEvidence || understanding.evidence.join(' ');
        const summary = `Задача выглядит выполненной: ${understanding.whatIsHappening}. ${evidence}`.slice(0, 700);
        const shoppingBlockReason = shoppingCompletionBlockReason(task, summary);
        if (shoppingBlockReason) {
            browserLog('auto_success_blocked', {
                reason: shoppingBlockReason.slice(0, 240),
                phase: understanding.phase,
                evidence: evidence.slice(0, 260),
            });
            return null;
        }
        return summary;
    }

    const outcome = state.lastActionOutcome;
    if (
        outcome &&
        outcome.confidence >= 0.76 &&
        /(success|submitted|form_submitted|booking_created|reservation_created|заявк[ауы]?\s+отправ|брон[ьи]?\s+создан|успеш|готов)/iu.test(outcome.progress)
    ) {
        const summary = `Задача выглядит выполненной после последнего действия: ${outcome.progress}. ${outcome.evidence.join(' ')}`.slice(0, 700);
        const shoppingBlockReason = shoppingCompletionBlockReason(task, summary);
        if (shoppingBlockReason) {
            browserLog('auto_success_blocked', {
                reason: shoppingBlockReason.slice(0, 240),
                progress: outcome.progress,
                evidence: outcome.evidence.join(' | ').slice(0, 260),
            });
            return null;
        }
        return summary;
    }

    return null;
}

function isGenericClarification(text: string): boolean {
    return /(не\s+смогл[ао]?\s+над[её]жно|следующ[ийе]\s+шаг|нужно\s+уточн|неясно|подскажи,\s*что\s+нажать|уточни\s+цель)/iu.test(text);
}

function requiredFormPrompt(observation: PageObservation): { question: string; choices: BrowserUserChoice[] } | null {
    const surface = [observation.pageText, observation.formText].join('\n');
    if (!/(отправить\s+заявк|заявк[аи]|booking|reservation|lead\s+form|количество\s+участников|телефон\s*\*|email\s*\*|phone\s*\*)/iu.test(surface)) return null;

    const requiredFields = bookingFormFieldsFromObservation(observation);
    const emptyRequiredFields = observation.formText
        .split('\n')
        .map((line) => line.match(/-\s+(.+?)\s+\[[^\]]+\].*\[required/iu)?.[1])
        .filter((field): field is string => Boolean(field))
        .map((field) => cleanWhitespace(field.replace(/\*+$/u, '')))
        .filter((field, index, arr) => field && arr.indexOf(field) === index)
        .slice(0, 6);

    if (!requiredFields.length && !emptyRequiredFields.length) return null;

    return {
        question: bookingFormDataQuestion(observation),
        choices: [],
    };
}

function buildBrowserPausePrompt(decision: BrowserAction, observation: PageObservation, task: string): { question: string; choices: BrowserUserChoice[] } {
    const decisionChoices = choicesFromDecision(decision);
    const baseQuestion = cleanWhitespace(decision.summary || decision.comment || 'Нужно уточнение, чтобы продолжить.');

    if (decisionChoices.length >= 2) {
        return { question: baseQuestion, choices: decisionChoices };
    }

    const modalPrompt = choicesFromModal(observation);
    if (modalPrompt) {
        return modalPrompt;
    }

    if (isGenericClarification(baseQuestion)) {
        const formPrompt = requiredFormPrompt(observation);
        if (formPrompt) return formPrompt;
    }

    return { question: baseQuestion, choices: [] };
}

function formatBrowserPauseResponse(question: string, choices: BrowserUserChoice[], kind: 'clarification' | 'manual_step'): string {
    const title = kind === 'manual_step'
        ? 'Нужен ручной шаг, чтобы продолжить в браузере.'
        : 'Нужно уточнение, чтобы продолжить в браузере.';
    const actionHint = choices.length
        ? 'Выбери вариант кнопкой ниже или ответь текстом.'
        : 'Ответь следующим сообщением, что именно сделать или какие данные ввести.';

    return `${title}\n\n${question}\n\n${actionHint} Если хочешь отменить задачу, напиши «отмена».`;
}

// ─── Главный агент ────────────────────────────────────────────────────────────

async function runBrowserAgent(
    ctx: BotContext,
    message: string,
    _isForwarded: boolean = false,
    _forwardFrom: string = '',
    messageHistory: MessageHistory[] = [],
    _classification?: MessageClassification,
    injectedMemoryContext?: string
): Promise<ProcessingResult> {
    const userId = ctx.from?.id ?? 0;
    const recentUserContext = buildRecentUserContext(messageHistory);
    let state: BrowserRunState | undefined;
    let shouldClose = true;
    let taskForLlm = message;
    let memoryForLlm = injectedMemoryContext;

    try {
        const activeState = getActiveBrowserSession(ctx);
        if (!BROWSER_CONTINUATION_RE.test(message) && isBrowserCancellationText(message) && activeState) {
            activeState.cancelRequested = true;
            activeState.cancelAcknowledged = true;
            ctx.session.pendingBrowserTask = undefined;
            ctx.session.activeBrowserTask = undefined;
            await closeBrowserRunState(activeState, 'cancelled').catch(() => {});
            return { responseText: 'Ок, браузерную задачу остановила.' };
        }
        if (!BROWSER_CONTINUATION_RE.test(message) && isBrowserCancellationText(message) && ctx.session.activeBrowserTask) {
            ctx.session.pendingBrowserTask = undefined;
            ctx.session.activeBrowserTask = undefined;
            return { responseText: 'Ок, браузерную задачу остановила.' };
        }

        state = getPausedBrowserSession(ctx, message);
        const continuation = parseBrowserContinuationMessage(message);
        if (state) {
            ensureBrowserRunStateShape(state);
            if (recentUserContext) state.recentUserContext = recentUserContext;
            const pendingBrowserTask = ctx.session.pendingBrowserTask;
            const answer = pendingBrowserTask?.userAnswer || continuation?.answer || browserTaskAnswerFromMessage(message) || message;
            const pendingQuestion = pendingBrowserTask?.question || continuation?.question || '';
            state.lastUserAnswer = answer;
            if (isBrowserCancellationText(answer)) {
                shouldClose = false;
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.activeBrowserTask = undefined;
                await closeBrowserRunState(state, 'cancelled').catch(() => {});
                return { responseText: 'Ок, браузерную задачу отменила.' };
            }
            if (isIterationLimitPauseQuestion(pendingQuestion)) {
                state.iterationCount = 0;
                state.consecutiveActionFailures = 0;
                state.notes.push('Пользователь разрешил продолжить после лимита операций; запускаю новый пакет итераций с текущей страницы.'.slice(0, 500));
                browserLog('iteration_limit_continued', {
                    sessionId: state.id,
                    answer: answer.slice(0, 80),
                    historyLength: state.history.length,
                });
            }
            const confirmedHighImpact =
                isExplicitUserConfirmation(answer) &&
                (pendingBrowserTask?.risk === 'high_impact' || isHighImpactConfirmationPrompt(pendingQuestion));
            if (confirmedHighImpact) {
                state.highImpactConfirmed = true;
                browserLog('high_impact_confirmed', {
                    sessionId: state.id,
                    risk: pendingBrowserTask?.risk,
                    byPrompt: isHighImpactConfirmationPrompt(pendingQuestion),
                    answer: answer.slice(0, 80),
                    question: pendingQuestion.slice(0, 180),
                });
            }

            const dialogResume = armBrowserDialogFromUserAnswer(state, answer, pendingQuestion);
            if (dialogResume === 'rejected') {
                shouldClose = false;
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.activeBrowserTask = undefined;
                await closeBrowserRunState(state, 'cancelled').catch(() => {});
                return { responseText: 'Ок, системное окно не принимаю и браузерную задачу останавливаю.' };
            }
            if (dialogResume === 'armed') {
                browserLog('browser_dialog_armed_from_user', {
                    sessionId: state.id,
                    answer: answer.slice(0, 80),
                    question: pendingQuestion.slice(0, 180),
                });
            } else if (dialogResume === 'ignored' && isBrowserDialogPauseQuestion(pendingQuestion)) {
                const latestDialog = latestSafetyDismissedDialog(state);
                if (latestDialog) {
                    const dialogPrompt = browserDialogPausePromptFromRecord(latestDialog);
                    pauseBrowserRun(ctx, state, dialogPrompt.question, undefined, dialogPrompt.choices);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Нужен ручной шаг: ${dialogPrompt.question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(dialogPrompt.question, dialogPrompt.choices || [], 'manual_step'),
                        keyboard: buildBrowserPauseKeyboard(state.id, dialogPrompt.choices || []),
                    };
                }
            }

            const isBookingMemoryConfirmation =
                Boolean(state.pendingBookingMemorySnapshot) &&
                /нашл[аи]\s+в\s+памят[иь]\s+данн[ыеых]+\s+для\s+форм/iu.test(pendingQuestion);
            if (isBookingMemoryConfirmation) {
                const snapshot = state.pendingBookingMemorySnapshot!;
                if (isExplicitUserConfirmation(answer)) {
                    state.confirmedBookingMemorySnapshot = snapshot;
                    state.pendingBookingMemorySnapshot = undefined;
                    state.lastUserAnswer = [
                        answer,
                        'Пользователь подтвердил использование найденных в памяти данных формы.',
                    ].join('\n');
                    browserLog('booking_form_memory_confirmed', { snapshot });
                } else if (isExplicitUserRejection(answer)) {
                    state.rejectedBookingMemorySnapshots.push(snapshot);
                    state.rejectedBookingMemorySnapshots = state.rejectedBookingMemorySnapshots.slice(-8);
                    state.pendingBookingMemorySnapshot = undefined;
                    const question = 'Ок, не использую найденные в памяти данные для этой формы. Пришли правильные данные одним сообщением, и я продолжу с этого места.';
                    pauseBrowserRun(ctx, state, question);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Нужны данные формы: ${question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(question, [], 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id),
                    };
                }
            }

            const currentObservation = await getPageObservation(state.page, state.pageEvents).catch(() => null);

            if (currentObservation) {
                const modalButton =
                    modalButtonFromUserAnswer(answer, currentObservation) ||
                    (pageLooksLikeModalChoice(currentObservation) ? modalButtonLabelFromFreeformAnswer(answer) : null);
                if (modalButton) {
                    browserLog('modal_choice_from_user_answer', {
                        button: modalButton,
                        answer: answer.slice(0, 80),
                        hasModalText: Boolean(currentObservation.modalText),
                    });
                    try {
                        await clickVisibleModalButtonByLabel(state.page, modalButton);
                        const comment = `Нажала «${modalButton}» в модальном окне по ответу пользователя.`;
                        await sendProgress(ctx, `🌐 ${comment}`);
                        state.history.push({
                            step: state.iterationCount + 1,
                            label: `modal_choice "${modalButton}"`,
                            url: state.page.url(),
                            comment,
                            result: 'ok',
                        });
                        state.lastUserAnswer = '';
                    } catch (err) {
                        browserLog('modal_choice_from_user_answer_failed', {
                            button: modalButton,
                            error: safeErrorMessage(err),
                        });
                    }
                }
            }

            const isBookingFormPause =
                isBookingFormDataQuestionText(pendingQuestion) ||
                Boolean(currentObservation && isBookingOrLeadFormSurface(currentObservation));

            if (isBookingFormPause && userSkipsBookingField(answer, pendingQuestion, 'source')) {
                state.lastUserAnswer = [
                    answer,
                    'Не заполнять поле: откуда узнали о сайте',
                ].join('\n');
                browserLog('booking_form_skip_field', { field: 'source', reason: 'user_answer' });
            }

            if (isBookingFormPause && userAsksWhatDataNeeded(answer)) {
                const question = currentObservation
                    ? bookingFormDataQuestion(currentObservation)
                    : pendingQuestion || 'Для заявки нужны название команды, телефон, email и количество участников.';
                pauseBrowserRun(ctx, state, question);
                shouldClose = false;
                await sendScreenshot(ctx, state.page, `❓ Нужно уточнение: ${question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(question, [], 'clarification'),
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            if (isBookingFormPause && userSaysUsePreviouslyProvidedData(answer)) {
                const updatedMemory = await lookupBookingFormMemory(ctx, state, state.originalTask);
                state.memoryContext = updatedMemory;
                memoryForLlm = [updatedMemory, injectedMemoryContext].filter(Boolean).join('\n\n') || undefined;

                const knownData = mergeBookingFormKnownData([
                    updatedMemory,
                    state.recentUserContext || '',
                    answer,
                ]);
                const missing = bookingFormMissingFields(knownData, currentObservation || undefined);
                if (missing.length) {
                    const found = bookingFormKnownDataSummary(knownData);
                    const question = [
                        found ? `Я проверила память и нашла: ${found}.` : 'Я проверила память, но не нашла достаточно данных для этой формы.',
                        `Не хватает: ${missing.join(', ')}.`,
                        'Пришли недостающие данные одним сообщением, и я продолжу с этого места.',
                    ].join(' ');
                    pauseBrowserRun(ctx, state, question);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Нужно уточнение: ${question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(question, [], 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id),
                    };
                }

                const memoryData = extractBookingFormKnownData(updatedMemory);
                const memorySnapshot = bookingFormDataSnapshot(memoryData);
                if (memorySnapshot && state.confirmedBookingMemorySnapshot !== memorySnapshot) {
                    const question = memoryBookingDataConfirmationQuestion(memoryData);
                    const choices = memoryBookingDataConfirmationChoices();
                    state.pendingBookingMemorySnapshot = memorySnapshot;
                    pauseBrowserRun(ctx, state, question, undefined, choices);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Подтверди данные из памяти: ${question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(question, choices, 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id, choices),
                    };
                }

                state.lastUserAnswer = answer;
            }

            const answerBookingData = extractBookingFormKnownData(answer);
            if (isBookingFormPause && currentObservation && bookingFormKnownDataSummary(answerBookingData)) {
                const fillResult = await maybeFillBookingFormFromKnownData(state.page, state, currentObservation).catch((err) => ({
                    status: 'failed' as const,
                    reason: safeErrorMessage(err),
                }));
                if (fillResult.status === 'filled') {
                    const comment = `Заполняю данные формы из твоего ответа: ${fillResult.fields.join(', ')}`;
                    await sendProgress(ctx, `🌐 ${comment}`);
                    state.history.push({
                        step: state.iterationCount + 1,
                        label: `booking_form_answer_fill ${fillResult.fields.join(', ')}`.slice(0, 140),
                        url: state.page.url(),
                        comment,
                        result: 'ok',
                    });
                    state.consecutiveActionFailures = 0;
                    await state.page.waitForTimeout(300);
                } else if (fillResult.status === 'needs_data') {
                    pauseBrowserRun(ctx, state, fillResult.question);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Нужны данные формы: ${fillResult.question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(fillResult.question, [], 'manual_step'),
                        keyboard: buildBrowserPauseKeyboard(state.id),
                    };
                } else if (fillResult.status === 'needs_confirmation') {
                    pauseBrowserRun(ctx, state, fillResult.question, undefined, fillResult.choices);
                    shouldClose = false;
                    await sendScreenshot(ctx, state.page, `❓ Подтверди данные из памяти: ${fillResult.question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(fillResult.question, fillResult.choices, 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id, fillResult.choices),
                    };
                } else if (fillResult.status === 'failed') {
                    state.notes.push(`Автозаполнение формы из ответа пользователя не сработало: ${fillResult.reason}`);
                }
            }

            const currentDomain = extractDomain(state.page.url());
            const userCredentials = extractCredentialsFromUserText(answer, currentDomain);
            if (userCredentials) {
                const material = {
                    ...userCredentials,
                    domain: userCredentials.domain || currentDomain || undefined,
                };
                state.credentialCandidates.unshift(material);
                state.memoryCredentials = material;
                state.activeCredentials = material;
                if (material.domain && material.login && material.password && /(запомни|сохрани|добавь)/i.test(answer)) {
                    BrowserCredentialService.save(userId, material.domain, material.login, material.password);
                }
            }
            resumeBrowserRun(ctx, state);
            taskForLlm = buildResumedTask(state, message, answer);
            memoryForLlm = await enrichBrowserMemoryContext(
                ctx,
                taskForLlm,
                [state.memoryContext, injectedMemoryContext, recentUserContextBlock(recentUserContext)].filter(Boolean).join('\n\n') || undefined
            );
            state.memoryContext = memoryForLlm;
            state.credentialCandidates.push(...extractCredentialCandidatesFromText(memoryForLlm, 'memory'));
            await sendProgress(ctx, '🌐 Продолжаю браузерную задачу с того же места…');
        } else {
            if (continuation?.originalTask) {
                taskForLlm = [
                    continuation.originalTask,
                    '',
                    `Ответ пользователя: ${continuation.answer || '(ответ не распознан)'}`,
                    'Предыдущая live-сессия браузера недоступна, поэтому восстанови задачу с начала, используя ответ пользователя:',
                    continuation.previousContext ? `Контекст предыдущей браузерной задачи:\n${continuation.previousContext}` : '',
                    continuation.previousUrl ? `Последняя страница: ${continuation.previousUrl}` : '',
                    continuation.previousTitle ? `Заголовок последней страницы: ${continuation.previousTitle}` : '',
                    continuation.question ? `Вопрос, на который отвечал пользователь: ${continuation.question}` : '',
                ].filter(Boolean).join('\n');
                await sendProgress(ctx, '🌐 Восстанавливаю браузерную задачу с начала и использую твой ответ…');
                memoryForLlm = await enrichBrowserMemoryContext(
                    ctx,
                    taskForLlm,
                    [injectedMemoryContext, recentUserContextBlock(recentUserContext)].filter(Boolean).join('\n\n') || undefined
                );
                state = await createBrowserRun(ctx, userId, continuation.originalTask, memoryForLlm, recentUserContext);
                state.lastUserAnswer = continuation.answer || '';
                if (continuation.previousContext) {
                    state.notes.push(`Контекст предыдущей завершённой браузерной задачи: ${continuation.previousContext.slice(0, 500)}`);
                }
                if (continuation.previousTitle) {
                    state.notes.push(`Заголовок последней страницы: ${continuation.previousTitle.slice(0, 180)}`);
                }
                if (continuation.previousUrl) {
                    state.notes.push(`Восстановлена последняя страница предыдущей задачи: ${continuation.previousUrl}`);
                    state.followUpOriginDomain = extractDomain(continuation.previousUrl);
                    try {
                        await gotoBrowserPage(state.page, continuation.previousUrl);
                    } catch (err) {
                        state.history.push({
                            step: 0,
                            label: `restore_previous_url ${continuation.previousUrl}`,
                            url: state.page.url(),
                            comment: 'Не удалось открыть последнюю страницу предыдущей браузерной задачи.',
                            result: 'failed',
                            error: safeErrorMessage(err),
                        });
                    }
                }
                const currentDomain = extractDomainsFromText(taskForLlm)[0];
                const continuationCredentials = extractCredentialsFromUserText(continuation.answer, currentDomain);
                if (continuationCredentials) {
                    state.credentialCandidates.unshift(continuationCredentials);
                    state.memoryCredentials = continuationCredentials;
                    state.activeCredentials = continuationCredentials;
                }
                state.notes.push('Live-сессия браузера была недоступна при продолжении; задача восстановлена с начала по исходному запросу и ответу пользователя.');
            } else {
                await sendProgress(ctx, '🌐 Открываю браузер и готовлю рабочую сессию…');
                memoryForLlm = await enrichBrowserMemoryContext(
                    ctx,
                    message,
                    [injectedMemoryContext, recentUserContextBlock(recentUserContext)].filter(Boolean).join('\n\n') || undefined
                );
                state = await createBrowserRun(ctx, userId, message, memoryForLlm, recentUserContext);
            }
        }

        ensureBrowserRunStateShape(state);
        const taskContractSource = normalizeSearchText([taskForLlm, memoryForLlm || '', recentUserContext || ''].join('\n')).slice(0, 4000);
        if (!state.taskContract || state.taskContractSource !== taskContractSource) {
            await sendProgress(ctx, '🌐 Разбираю задачу на критерии, признаки и способ проверки результата…');
        }
        await maybeUpdateTaskContract(state, taskForLlm, memoryForLlm, recentUserContext);

        for (let i = state.iterationCount; i < MAX_ITERATIONS; i++) {
            if (state.cancelRequested) {
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.activeBrowserTask = undefined;
                return { responseText: 'Ок, браузерную задачу остановила.' };
            }

            await ensureUsableBrowserPage(state);
            let page = state.page;
            let url = page.url();
            let domain = extractDomain(url);

            if (domain && domain !== state.lastCredentialDomain && domain !== 'about:blank') {
                const loaded = await BrowserSessionStore.load(state.browserCtx, state.userId, domain);
                if (loaded) {
                    devLog('browserAgent: loaded session for', domain);
                    console.log(`[BROWSER] session loaded for ${domain}`);
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
                }

                state.activeCredentials = resolveCredentialsForDomain(
                    state.userId,
                    domain,
                    state.credentialCandidates,
                    state.memoryCredentials
                );
                state.lastCredentialDomain = domain;
            }

            await adoptLatestPage(state);
            page = state.page;
            url = state.page.url();
            domain = extractDomain(url);
            const sitePatternsText = browserSitePatternsSummary(domain);
            const observation = await getPageObservation(page, state.pageEvents);
            const title = await page.title().catch(() => '');

            console.log(`[BROWSER] iter ${i + 1}/${MAX_ITERATIONS} | ${url}`);

            const bookingFormVisible = isBookingOrLeadFormSurface(observation) && hasVisibleBookingContactFields(observation);
            browserLog('observation', {
                iter: i + 1,
                url: safeLogUrl(url),
                title: title.slice(0, 120),
                scroll: cleanWhitespace(observation.scrollDiagnosticsText || '').slice(0, 140),
                filterGroups: countSnapshotRows(observation.filterControlsText, /^\s*filter#\d+/gmu),
                interactiveCount: countSnapshotRows(observation.interactiveText, /^\s*#\d+/gmu),
                blockCount: countSnapshotRows(observation.structureText, /^\s*block#\d+/gmu),
                semanticAreas: countSnapshotRows(observation.semanticMapText, /^\s*area#\d+/gmu),
                structuredData: countSnapshotRows(observation.structuredDataText, /^\s*(?:jsonld|important-link|meta)\b/gmu),
                productCount: countSnapshotRows(observation.productCardsText, /^\s*product#\d+/gmu),
                tableCount: countSnapshotRows(observation.tableText, /^\s*table#\d+/gmu),
                affordanceNodes: countSnapshotRows(observation.affordanceGraphText, /^\s*node#\d+/gmu),
                visualControls: countSnapshotRows(observation.visualMapText, /^\s*visual#\d+/gmu),
                formLines: countSnapshotRows(observation.formText, /^\s*field#\d+/gmu),
                formBrainFields: countSnapshotRows(observation.formBrainText, /^\s*field#\d+/gmu),
                evidenceItems: state.evidenceStash.length,
                networkSnippets: state.networkSnippets.length,
                bookingFormVisible,
                blockers: cleanWhitespace(observation.blockerSignals || '').slice(0, 180),
            });
            recordBrowserTrajectoryEvent(state, 'observation', {
                iter: i + 1,
                url: safeLogUrl(url),
                title: title.slice(0, 180),
                scroll: cleanWhitespace(observation.scrollDiagnosticsText || '').slice(0, 260),
                interactiveCount: countSnapshotRows(observation.interactiveText, /^\s*#\d+/gmu),
                blockCount: countSnapshotRows(observation.structureText, /^\s*block#\d+/gmu),
                semanticAreas: countSnapshotRows(observation.semanticMapText, /^\s*area#\d+/gmu),
                structuredData: countSnapshotRows(observation.structuredDataText, /^\s*(?:jsonld|important-link|meta)\b/gmu),
                productCount: countSnapshotRows(observation.productCardsText, /^\s*product#\d+/gmu),
                tableCount: countSnapshotRows(observation.tableText, /^\s*table#\d+/gmu),
                formBrainFields: countSnapshotRows(observation.formBrainText, /^\s*field#\d+/gmu),
                visualControls: countSnapshotRows(observation.visualMapText, /^\s*visual#\d+/gmu),
                evidenceItems: state.evidenceStash.length,
                networkSnippets: state.networkSnippets.length,
                blockers: cleanWhitespace(observation.blockerSignals || '').slice(0, 260),
            });

            if (hasDismissibleTechnicalOverlay(observation)) {
                const repeatedOverlayDismissals = state.history
                    .slice(-6)
                    .filter((record) => record.url === url && record.label.startsWith('auto_dismiss_technical_overlay'))
                    .length;
                if (repeatedOverlayDismissals >= 2) {
                    const note = 'Техническое окно cookie/уведомлений всё ещё определяется после двух попыток закрытия. Не зацикливайся на нём: продолжай основную задачу, если оно не перекрывает целевой элемент.';
                    browserLog('technical_overlay_ignore_after_retries', {
                        iter: i + 1,
                        url: safeLogUrl(url),
                        attempts: repeatedOverlayDismissals,
                    });
                    state.notes.push(note);
                    state.history.push({
                        step: i + 1,
                        label: 'skip_technical_overlay_after_retries',
                        url,
                        comment: note,
                        result: 'failed',
                        error: 'technical_overlay_retry_limit',
                    });
                    observation.modalText = '';
                    observation.blockerSignals = observation.blockerSignals
                        .split('\n')
                        .filter((line) => !isDismissibleTechnicalOverlayText(line))
                        .join('\n');
                } else {
                    try {
                        const comment = await dismissOverlays(page);
                        browserLog('technical_overlay_dismissed', {
                            iter: i + 1,
                            url: safeLogUrl(url),
                            attempts: repeatedOverlayDismissals + 1,
                            comment: comment.slice(0, 220),
                        });
                        const userComment = repeatedOverlayDismissals >= 1
                            ? 'Убираю оставшееся техническое окно cookie/уведомлений и продолжаю задачу.'
                            : 'Закрываю техническое окно cookie/уведомлений, чтобы продолжить работу с сайтом.';
                        await sendProgress(ctx, `🌐 ${userComment}`);
                        state.notes.push(`${userComment} ${comment}`.slice(0, 500));
                        pushEvidence(state, 'action', userComment, state.page.url());
                        state.history.push({
                            step: i + 1,
                            label: `auto_dismiss_technical_overlay ${repeatedOverlayDismissals + 1}`,
                            url,
                            comment,
                            result: 'ok',
                        });
                        state.iterationCount = i + 1;
                        state.consecutiveActionFailures = 0;
                        await state.page.waitForTimeout(300);
                        continue;
                    } catch (err) {
                        const reason = safeErrorMessage(err);
                        state.notes.push(`Техническое окно cookie/уведомлений не удалось закрыть автоматически: ${reason}`.slice(0, 600));
                        state.history.push({
                            step: i + 1,
                            label: `auto_dismiss_technical_overlay_failed ${repeatedOverlayDismissals + 1}`,
                            url,
                            comment: 'Не удалось автоматически закрыть техническое окно.',
                            result: 'failed',
                            error: reason,
                        });
                        state.iterationCount = i + 1;
                        if (repeatedOverlayDismissals < 2) {
                            await page.waitForTimeout(200);
                            continue;
                        }
                    }
                }
            }

            const manualBlocker = manualBlockerPausePrompt(observation, state);
            if (manualBlocker) {
                state.notes.push(`Ручной блокер браузера: ${manualBlocker.kind}. ${manualBlocker.question}`.slice(0, 700));
                state.history.push({
                    step: i + 1,
                    label: `manual_blocker_${manualBlocker.kind}`,
                    url,
                    comment: manualBlocker.question,
                    result: 'failed',
                    error: manualBlocker.kind,
                });
                state.iterationCount = i + 1;
                pauseBrowserRun(ctx, state, manualBlocker.question, undefined, manualBlocker.choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужен ручной шаг: ${manualBlocker.question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(manualBlocker.question, manualBlocker.choices || [], 'manual_step'),
                    keyboard: buildBrowserPauseKeyboard(state.id, manualBlocker.choices || []),
                };
            }

            await maybeUpdatePageUnderstanding(state, taskForLlm, observation, url, i + 1, sitePatternsText);
            recordEvidenceFromObservation(state, observation);
            const autoSuccessSummary = detectedSuccessSummary(state, taskForLlm);
            if (autoSuccessSummary) {
            const finalAutoSuccessSummary = finalSummaryWithEvidence(autoSuccessSummary, state, taskForLlm);
                const universalBlockReason = universalCompletionBlockReason(taskForLlm, finalAutoSuccessSummary, state, observation);
                if (universalBlockReason) {
                    browserLog('auto_success_universal_blocked', {
                        reason: universalBlockReason.slice(0, 260),
                    });
                    state.notes.push(`Universal completion guard заблокировал автозавершение: ${universalBlockReason}`.slice(0, 1000));
                    state.history.push({
                        step: i + 1,
                        label: 'universal_completion_block auto_success',
                        url,
                        comment: universalBlockReason,
                        result: 'failed',
                        error: 'universal_completion_blocked',
                    });
                    await page.waitForTimeout(150);
                    continue;
                }
                const completionReview = await reviewTaskCompletionWithLlm(taskForLlm, finalAutoSuccessSummary, observation, state);
                const completionBlockReason = completionReviewBlockReason(completionReview);
                if (completionBlockReason) {
                    browserLog('auto_success_completion_blocked', {
                        reason: completionBlockReason.slice(0, 260),
                        confidence: completionReview?.confidence,
                    });
                    state.notes.push(`Completion review заблокировал автозавершение: ${completionBlockReason}`.slice(0, 1000));
                    state.history.push({
                        step: i + 1,
                        label: 'completion_review_block auto_success',
                        url,
                        comment: completionBlockReason,
                        result: 'failed',
                        error: 'completion_review_blocked',
                    });
                } else {
                    pushEvidence(state, 'success', finalAutoSuccessSummary, state.page.url());
                    await sendScreenshot(ctx, page, browserDoneScreenshotCaption(finalAutoSuccessSummary));
                    if (domain) {
                        await BrowserSessionStore.save(state.browserCtx, state.userId, domain).catch(() => {});
                        state.sessionSavedForDomain = domain;
                        rememberSuccessfulSitePattern(domain, state, observation, finalAutoSuccessSummary);
                    }
                    const sentDownloads = await sendDownloadedFiles(ctx, state);
                    ctx.session.pendingBrowserTask = undefined;
                    ctx.session.lastBrowserTask = {
                        originalTask: state.originalTask,
                        summary: finalAutoSuccessSummary,
                        url: state.page.url(),
                        title,
                        notes: state.notes.slice(-12),
                        pageText: browserTaskPageContextForSession(observation),
                        createdAt: Date.now(),
                        expiresAt: Date.now() + LAST_BROWSER_TASK_TTL_MS,
                    };
                    const downloadsLine = sentDownloads.length ? `\n\nФайлы: ${sentDownloads.join(', ')}` : '';
                    return { responseText: formatBrowserDoneResponse(finalAutoSuccessSummary, downloadsLine) };
                }
            }

            const shouldSendScreenshot =
                (domain && domain !== state.lastScreenshotDomain && url !== 'about:blank') ||
                (i > 0 && i % SCREENSHOT_INTERVAL === 0);

            if (shouldSendScreenshot) {
                await sendScreenshot(ctx, page, `🌐 ${title || url}`);
                state.lastScreenshotDomain = domain;
            }

            const recentlyTriedScopedAction = state.history.slice(-2).some((record) =>
                record.result === 'ok' &&
                record.url === url &&
                record.label.startsWith('task_scoped_action')
            );
            if (url !== 'about:blank' && !recentlyTriedScopedAction && !bookingFormVisible) {
                const scopedAction = await maybeUseTaskScopedAction(page, taskForLlm).catch((err) => ({
                    status: 'failed' as const,
                    reason: safeErrorMessage(err),
                }));
                if (scopedAction.status !== 'none') {
                    browserLog('task_scoped_result', {
                        status: scopedAction.status,
                        reason: 'reason' in scopedAction ? scopedAction.reason : undefined,
                        label: 'label' in scopedAction ? scopedAction.label : undefined,
                        controlLabel: 'controlLabel' in scopedAction ? scopedAction.controlLabel : undefined,
                        choices: 'choices' in scopedAction ? summarizeChoices(scopedAction.choices) : undefined,
                    });
                }
                if (scopedAction.status === 'clicked') {
                    const comment = `Нашла целевой блок и нажала «${scopedAction.controlLabel}» внутри него: ${scopedAction.label}`;
                    await sendProgress(ctx, `🌐 ${comment}`);
                    await adoptLatestPage(state);
                    state.consecutiveActionFailures = 0;
                    state.history.push({
                        step: i + 1,
                        label: `task_scoped_action "${scopedAction.controlLabel.slice(0, 70)}"`,
                        url,
                        comment,
                        result: 'ok',
                    });
                    state.iterationCount = i + 1;
                    await state.page.waitForTimeout(500);
                    continue;
                }
                if (scopedAction.status === 'ambiguous') {
                    pauseBrowserRun(ctx, state, scopedAction.question, undefined, scopedAction.choices);
                    shouldClose = false;
                    await sendScreenshot(ctx, page, `❓ Нужно выбрать блок: ${scopedAction.question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(scopedAction.question, scopedAction.choices, 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id, scopedAction.choices),
                    };
                }
                if (scopedAction.status === 'failed') {
                    state.notes.push(`Клик по целевому блоку из задачи не сработал: ${scopedAction.reason}`);
                }
            }

            const bookingFormFill = await maybeFillBookingFormFromKnownData(page, state, observation).catch((err) => ({
                status: 'failed' as const,
                reason: safeErrorMessage(err),
            }));
            if (bookingFormFill.status !== 'none') {
                browserLog('booking_form_fill_result', {
                    status: bookingFormFill.status,
                    fields: 'fields' in bookingFormFill ? bookingFormFill.fields.join(', ') : undefined,
                    reason: 'reason' in bookingFormFill ? bookingFormFill.reason : undefined,
                    question: 'question' in bookingFormFill ? bookingFormFill.question : undefined,
                });
            }
            if (bookingFormFill.status === 'filled') {
                const comment = `Заполняю известные поля формы: ${bookingFormFill.fields.join(', ')}`;
                const fillLabel = `booking_form_fill ${bookingFormFill.fields.join(', ')}`.slice(0, 140);
                const sameFillAlreadyTried = state.history.slice(-6).some((record) =>
                    record.url === url && record.label === fillLabel
                );
                if (sameFillAlreadyTried) {
                    state.notes.push(`Автозаполнение формы уже выполнялось на этой странице (${bookingFormFill.fields.join(', ')}); не повторяй его, переходи к следующему действию формы или задай один конкретный вопрос.`);
                } else {
                    await sendProgress(ctx, `🌐 ${comment}`);
                    state.history.push({
                        step: i + 1,
                        label: fillLabel,
                        url,
                        comment,
                        result: 'ok',
                    });
                    state.iterationCount = i + 1;
                    state.consecutiveActionFailures = 0;
                    await state.page.waitForTimeout(300);
                    continue;
                }
            }
            if (bookingFormFill.status === 'needs_data') {
                pauseBrowserRun(ctx, state, bookingFormFill.question);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужны данные формы: ${bookingFormFill.question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(bookingFormFill.question, [], 'manual_step'),
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }
            if (bookingFormFill.status === 'needs_confirmation') {
                pauseBrowserRun(ctx, state, bookingFormFill.question, undefined, bookingFormFill.choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Подтверди данные из памяти: ${bookingFormFill.question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(bookingFormFill.question, bookingFormFill.choices, 'clarification'),
                    keyboard: buildBrowserPauseKeyboard(state.id, bookingFormFill.choices),
                };
            }
            if (bookingFormFill.status === 'failed') {
                state.notes.push(`Автозаполнение формы из известных данных не сработало: ${bookingFormFill.reason}`);
            }

            if (bookingFormFill.status === 'none') {
                const genericFormFill = await maybeFillVisibleFormFromTrustedData(page, state, observation, taskForLlm).catch((err) => ({
                    status: 'failed' as const,
                    reason: safeErrorMessage(err),
                }));
                if (genericFormFill.status !== 'none') {
                    browserLog('generic_form_fill_result', {
                        status: genericFormFill.status,
                        fields: 'fields' in genericFormFill ? genericFormFill.fields.join(', ') : undefined,
                        reason: 'reason' in genericFormFill ? genericFormFill.reason : undefined,
                    });
                }
                if (genericFormFill.status === 'filled') {
                    const comment = `Заполняю поля формы из явных данных пользователя: ${genericFormFill.fields.join(', ')}`;
                    await sendProgress(ctx, `🌐 ${comment}`);
                    state.history.push({
                        step: i + 1,
                        label: `generic_form_fill ${genericFormFill.fields.join(', ')}`.slice(0, 140),
                        url,
                        comment,
                        result: 'ok',
                    });
                    state.iterationCount = i + 1;
                    state.consecutiveActionFailures = 0;
                    await state.page.waitForTimeout(300);
                    continue;
                }
                if (genericFormFill.status === 'failed') {
                    state.notes.push(`Общее автозаполнение формы не сработало: ${genericFormFill.reason}`.slice(0, 600));
                }
            }

            maybeInjectBrowserLoopCheckpoint(state, observation, url, i + 1);
            if (shouldUseProactiveBrowserStuckRecovery(state, observation, url, i + 1)) {
                const recoveryPlan = chooseBrowserStuckRecoveryPlan(state, observation, taskForLlm, url, 'proactive_stuck_signals');
                if (recoveryPlan) {
                    const recovered = await executeBrowserStuckRecoveryPlan(ctx, state, page, recoveryPlan, i + 1, url);
                    if (recovered) continue;
                }
            }

            let decision: BrowserAction;
            const proactiveListingFallback = visibleListingFallbackDecision(taskForLlm, observation, state);
            if (proactiveListingFallback) {
                decision = proactiveListingFallback;
                state.notes.push('На странице есть структурированный список/карточки; применяю общий listing fallback до запроса следующего LLM-действия.'.slice(0, 500));
                browserLog('visible_listing_fallback_proactive', {
                    action: decision.action,
                    summary: decision.summary?.slice(0, 260),
                    comment: decision.comment?.slice(0, 260),
                    items: state.visibleListingItems.length,
                });
            } else {
                decision = await askNextAction(
                    taskForLlm,
                    url,
                    title,
                    observation,
                    state.history,
                    state.notes,
                    getCredentialHint(state.activeCredentials, domain),
                    memoryForLlm,
                    state.pageUnderstanding,
                    state.taskLedger,
                    state.taskPlan,
                    state.lastActionOutcome,
                    sitePatternsText,
                    state
                );
            }
            devLog('browserAgent decision:', sanitizeDecisionForLog(decision));
            console.log(formatDecisionForLog(decision));
            recordBrowserTrajectoryEvent(state, 'decision', {
                iter: i + 1,
                decision: sanitizeDecisionForLog(decision),
                historyLength: state.history.length,
                notesTail: state.notes.slice(-3),
                pagePhase: state.pageUnderstanding?.phase,
            });

            if (decision.action === 'ask_user') {
                const listingFallback = visibleListingFallbackDecision(taskForLlm, observation, state);
                if (listingFallback) {
                    state.notes.push([
                        `LLM хотела спросить пользователя: ${decision.summary || decision.comment || 'ask_user без текста'}`,
                        'Но на странице уже есть структурированный список. Использую общий listing fallback: читаю видимые карточки/строки, сверяю критерии и продолжаю без вопроса про UI.',
                    ].join(' ').slice(0, 900));
                    decision = listingFallback;
                    browserLog('visible_listing_fallback_decision', {
                        action: decision.action,
                        summary: decision.summary?.slice(0, 260),
                        comment: decision.comment?.slice(0, 260),
                    });
                }
            }

            const earlySafetyQuestion = safetyQuestionForDecision(decision, state, observation);
            if (earlySafetyQuestion) {
                pauseBrowserRun(ctx, state, earlySafetyQuestion);
                shouldClose = false;
                state.history.push({
                    step: i + 1,
                    label: `safety_pause ${actionSignature(decision)}`,
                    url,
                    comment: earlySafetyQuestion,
                    result: 'failed',
                    error: 'sensitive_or_blocked_step_requires_user',
                });
                await sendScreenshot(ctx, page, `❓ Нужен ручной шаг: ${earlySafetyQuestion.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(earlySafetyQuestion, [], 'manual_step'),
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            const earlyBookingSubmitDecision = isBookingSubmitDecision(decision, observation);
            if (earlyBookingSubmitDecision && !state.highImpactConfirmed) {
                const question = 'Подтверди, что можно отправить заявку/форму записи на сайте. Ответь «да, подтверждаю», если действительно продолжаем.';
                const choices = highImpactConfirmationChoices();
                browserLog('high_impact_pause', {
                    kind: 'booking_submit',
                    action: actionSignature(decision),
                    url: safeLogUrl(url),
                    alreadyConfirmed: state.highImpactConfirmed,
                });
                pauseBrowserRun(ctx, state, question, 'high_impact', choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно подтверждение: ${question.slice(0, 180)}`);
                return {
                    responseText:
                        `Перед отправкой заявки нужно подтверждение:\n\n${question}\n\n` +
                        'Нажми «Да, подтверждаю» кнопкой ниже или ответь текстом. Для отмены нажми кнопку отмены или напиши «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id, choices),
                };
            }

            if (isHighImpactAction(decision) && !state.highImpactConfirmed) {
                const question = highImpactQuestion(decision);
                const choices = highImpactConfirmationChoices();
                browserLog('high_impact_pause', {
                    kind: 'generic',
                    action: actionSignature(decision),
                    url: safeLogUrl(url),
                    alreadyConfirmed: state.highImpactConfirmed,
                });
                pauseBrowserRun(ctx, state, question, 'high_impact', choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно подтверждение: ${question.slice(0, 180)}`);
                return {
                    responseText:
                        `Перед финальным действием нужно подтверждение:\n\n${question}\n\n` +
                        'Нажми «Да, подтверждаю» кнопкой ниже или ответь текстом. Для отмены нажми кнопку отмены или напиши «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id, choices),
                };
            }

            const explicitClickHref =
                decision.action === 'click' ? hrefFromCandidateSelector(actionTargetSelector(decision), url) : undefined;
            if (explicitClickHref) {
                browserLog('context_guards_skip', {
                    reason: 'explicit_href',
                    href: safeLogUrl(explicitClickHref),
                    selector: actionTargetSelector(decision).slice(0, 180),
                });
            }

            const modalClick = modalButtonFromClickDecision(decision, observation);
            if (modalClick) {
                browserLog('modal_click_direct', {
                    button: modalClick.button,
                    question: modalClick.question.slice(0, 220),
                    action: actionSignature(decision),
                });
                try {
                    await clickVisibleModalButtonByLabel(page, modalClick.button);
                    const comment = `Нажала «${modalClick.button}» в модальном окне.`;
                    await sendProgress(ctx, `🌐 ${comment}`);
                    await adoptLatestPage(state);
                    state.consecutiveActionFailures = 0;
                    state.history.push({
                        step: i + 1,
                        label: `modal_click "${modalClick.button}"`,
                        url,
                        comment,
                        result: 'ok',
                    });
                    state.iterationCount = i + 1;
                    await state.page.waitForTimeout(500);
                    continue;
                } catch (err) {
                    const reason = safeErrorMessage(err);
                    browserLog('modal_click_direct_failed', {
                        button: modalClick.button,
                        reason,
                    });
                    state.notes.push(`Клик по кнопке модального окна «${modalClick.button}» не сработал: ${reason}`);
                }
            }

            if (!explicitClickHref) {
            const targetBlockClick = await maybeUseTargetBlockClick(page, taskForLlm, decision).catch((err) => ({
                status: 'failed' as const,
                reason: safeErrorMessage(err),
            }));
            if (targetBlockClick.status !== 'none') {
                browserLog('target_block_result', {
                    status: targetBlockClick.status,
                    reason: 'reason' in targetBlockClick ? targetBlockClick.reason : undefined,
                    label: 'label' in targetBlockClick ? targetBlockClick.label : undefined,
                    choices: 'choices' in targetBlockClick ? summarizeChoices(targetBlockClick.choices) : undefined,
                });
            }
            if (targetBlockClick.status === 'clicked') {
                const comment = `Нашла нужный блок по тексту и нажала кнопку внутри него: ${targetBlockClick.label}`;
                await sendProgress(ctx, `🌐 ${comment}`);
                await adoptLatestPage(state);
                state.consecutiveActionFailures = 0;
                state.history.push({
                    step: i + 1,
                    label: `target_block_click "${targetBlockClick.label.slice(0, 70)}"`,
                    url,
                    comment,
                    result: 'ok',
                });
                state.iterationCount = i + 1;
                await state.page.waitForTimeout(500);
                continue;
            }
            if (targetBlockClick.status === 'ambiguous') {
                pauseBrowserRun(ctx, state, targetBlockClick.question, undefined, targetBlockClick.choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно выбрать блок: ${targetBlockClick.question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(targetBlockClick.question, targetBlockClick.choices, 'clarification'),
                    keyboard: buildBrowserPauseKeyboard(state.id, targetBlockClick.choices),
                };
            }
            if (targetBlockClick.status === 'failed') {
                state.notes.push(`Клик по блоку с целевым текстом не сработал: ${targetBlockClick.reason}`);
            }

            const contextualClick = await maybeUseContextualClick(page, taskForLlm, decision).catch((err) => ({
                status: 'failed' as const,
                reason: safeErrorMessage(err),
            }));
            if (contextualClick.status !== 'none') {
                browserLog('contextual_result', {
                    status: contextualClick.status,
                    reason: 'reason' in contextualClick ? contextualClick.reason : undefined,
                    label: 'label' in contextualClick ? contextualClick.label : undefined,
                    choices: 'choices' in contextualClick ? summarizeChoices(contextualClick.choices) : undefined,
                });
            }
            if (contextualClick.status === 'clicked') {
                const comment = `Выбрала элемент по контексту блока: ${contextualClick.label}`;
                await sendProgress(ctx, `🌐 ${comment}`);
                await adoptLatestPage(state);
                state.consecutiveActionFailures = 0;
                state.history.push({
                    step: i + 1,
                    label: `contextual_click "${contextualClick.label.slice(0, 70)}"`,
                    url,
                    comment,
                    result: 'ok',
                });
                state.iterationCount = i + 1;
                await state.page.waitForTimeout(500);
                continue;
            }
            if (contextualClick.status === 'ambiguous') {
                pauseBrowserRun(ctx, state, contextualClick.question, undefined, contextualClick.choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно выбрать блок: ${contextualClick.question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(contextualClick.question, contextualClick.choices, 'clarification'),
                    keyboard: buildBrowserPauseKeyboard(state.id, contextualClick.choices),
                };
            }
            if (contextualClick.status === 'failed') {
                state.notes.push(`Контекстный клик не сработал: ${contextualClick.reason}`);
            }

            const rawClickGuard = await guardRawClickAgainstTargetContext(page, taskForLlm, decision).catch((err) => ({
                status: 'failed' as const,
                reason: safeErrorMessage(err),
            }));
            if (rawClickGuard.status !== 'none') {
                browserLog('raw_click_guard_result', {
                    status: rawClickGuard.status,
                    reason: 'reason' in rawClickGuard ? rawClickGuard.reason : undefined,
                    note: 'note' in rawClickGuard ? rawClickGuard.note : undefined,
                    choices: 'choices' in rawClickGuard ? summarizeChoices(rawClickGuard.choices) : undefined,
                });
            }
            if (rawClickGuard.status === 'blocked') {
                state.notes.push(rawClickGuard.note);
                const blockedClickLabel = `blocked_contextless_click ${actionSignature(decision)}`.slice(0, 140);
                state.history.push({
                    step: i + 1,
                    label: blockedClickLabel,
                    url,
                    comment: rawClickGuard.note,
                    result: 'failed',
                    error: 'contextless_click_blocked',
                });
                state.iterationCount = i + 1;

                const visualLayoutClick = await maybeUseVisualLayoutClick(page, taskForLlm, decision, observation, rawClickGuard.note).catch((err) => ({
                    status: 'failed' as const,
                    reason: safeErrorMessage(err),
                }));
                if (visualLayoutClick.status !== 'none') {
                    browserLog('visual_layout_result', {
                        status: visualLayoutClick.status,
                        label: 'label' in visualLayoutClick ? visualLayoutClick.label : undefined,
                        controlIndex: 'controlIndex' in visualLayoutClick ? visualLayoutClick.controlIndex : undefined,
                        reason: 'reason' in visualLayoutClick ? visualLayoutClick.reason : undefined,
                    });
                }
                if (visualLayoutClick.status === 'clicked') {
                    const comment = `Выбрала видимый элемент по верстке/скриншоту: ${visualLayoutClick.label}`;
                    await sendProgress(ctx, `🌐 ${comment}`);
                    await adoptLatestPage(state);
                    state.consecutiveActionFailures = 0;
                    state.history.push({
                        step: i + 1,
                        label: `visual_layout_click "${visualLayoutClick.label.slice(0, 70)}"`,
                        url,
                        comment,
                        result: 'ok',
                    });
                    await state.page.waitForTimeout(500);
                    continue;
                }
                if (visualLayoutClick.status === 'failed') {
                    state.notes.push(`Vision-проверка клика не сработала: ${visualLayoutClick.reason}`);
                }

                if (rawClickGuard.question && rawClickGuard.choices?.length) {
                    state.notes.push([
                        'Это внутренняя UI-неоднозначность, не вопрос пользователю.',
                        rawClickGuard.question,
                        'Смени стратегию: выбери другой selector/context, прокрути, открой детальную страницу, используй видимый текст или верни done/fail по результату.',
                    ].join(' ').slice(0, 700));
                    await sendProgress(ctx, '🌐 Вижу несколько похожих элементов; выбираю другую стратегию сама.');
                    await page.waitForTimeout(200);
                    continue;
                }

                const repeatedBlockedClickCount = state.history
                    .slice(-8)
                    .filter((record) => record.label === blockedClickLabel && record.error === 'contextless_click_blocked')
                    .length;
                if (repeatedBlockedClickCount >= 2) {
                    state.notes.push([
                        'Один и тот же общий клик дважды заблокирован.',
                        'Не спрашивай пользователя про кнопку/область: это внутренняя навигационная проблема.',
                        'Используй другой путь: scroll, go_back, прямой URL категории, поиск на сайте, другой selector, или заверши done/fail по уже найденным данным.',
                    ].join(' '));
                    await sendProgress(ctx, '🌐 Повторный общий клик не помогает; перестраиваю маршрут сама.');
                    await page.waitForTimeout(200);
                    continue;
                }

                await sendProgress(ctx, '🌐 Не нажимаю общий элемент без привязки к целевому блоку; меняю стратегию.');
                await page.waitForTimeout(200);
                continue;
            }
            if (rawClickGuard.status === 'failed') {
                state.notes.push(`Проверка контекста клика не сработала: ${rawClickGuard.reason}`);
            }
            }

            const actionLoop = detectBrowserActionLoopBeforeExecution(state, decision, url);
            if (actionLoop.stuck) {
                const alreadyWarned = state.loopCheckpointSignatures.includes(actionLoop.warningKey);
                state.loopCheckpointSignatures.push(actionLoop.warningKey);
                if (state.loopCheckpointSignatures.length > 16) {
                    state.loopCheckpointSignatures.splice(0, state.loopCheckpointSignatures.length - 16);
                }

                const note = [
                    `${actionLoop.level.toUpperCase()} ${actionLoop.detector}: ${actionLoop.message}`,
                    actionLoop.recovery,
                    alreadyWarned ? 'Этот паттерн уже предупреждался; следующий ответ LLM должен выбрать принципиально другой маршрут или завершить задачу.' : '',
                ].filter(Boolean).join(' ');
                state.notes.push(note.slice(0, 900));
                state.history.push({
                    step: i + 1,
                    label: `action_loop_${actionLoop.detector} ${actionSignature(decision)}`.slice(0, 140),
                    url,
                    comment: note,
                    result: 'failed',
                    error: `loop_${actionLoop.detector}`,
                });
                state.iterationCount = i + 1;
                browserLog('action_loop_detected', {
                    detector: actionLoop.detector,
                    level: actionLoop.level,
                    count: actionLoop.count,
                    action: actionSignature(decision),
                    alreadyWarned,
                    url: safeLogUrl(url),
                });
                recordBrowserTrajectoryEvent(state, 'action.loop_detected', {
                    detector: actionLoop.detector,
                    level: actionLoop.level,
                    count: actionLoop.count,
                    action: actionSignature(decision),
                    message: actionLoop.message,
                    recovery: actionLoop.recovery,
                    alreadyWarned,
                });
                await sendProgress(ctx, alreadyWarned
                    ? '🌐 Этот маршрут снова зациклился; заставляю себя выбрать другой путь или завершить по доказанным данным.'
                    : '🌐 Вижу риск цикла действий; перестраиваю маршрут до выполнения повторного шага.');
                const recoveryPlan = chooseBrowserStuckRecoveryPlan(
                    state,
                    observation,
                    taskForLlm,
                    url,
                    `action_loop_${actionLoop.detector}`
                );
                if (recoveryPlan) {
                    const recovered = await executeBrowserStuckRecoveryPlan(ctx, state, page, recoveryPlan, i + 1, url);
                    if (recovered) continue;
                }
                await page.waitForTimeout(200);
                continue;
            }

            const repeatedCount = repeatedActionCount(state.history, decision);
            if (repeatedCount > 0) {
                browserLog('repeated_action_candidate', {
                    count: repeatedCount,
                    signature: actionSignature(decision),
                    url: safeLogUrl(url),
                });
            }
            if (repeatedCount >= 3) {
                const signature = actionSignature(decision);
                if (!hasRecentRepeatedActionRecovery(state.history, signature)) {
                    const scrollState = isScrollDownDecision(decision)
                        ? await getScrollBoundaryState(page)
                        : null;
                    const note = scrollState && !scrollState.canScrollDown
                        ? [
                            'Достигнут низ страницы; повторный scroll down больше не даст прогресса.',
                            'Смени стратегию: используй уже найденный видимый/DOM-текст, прокрути вверх к нужному блоку, нажми подходящий видимый элемент, верни done с результатами или задай один конкретный вопрос.',
                        ].join(' ')
                        : [
                            `Действие "${signature}" повторилось без прогресса.`,
                            'Не повторяй его следующим шагом: выбери другой selector/контекстный блок, попробуй wait/go_back/scroll в другую сторону, верни done по уже собранной информации или задай один конкретный вопрос.',
                        ].join(' ');

                    state.notes.push(note);
                    state.history.push({
                        step: i + 1,
                        label: repeatedActionRecoveryLabel(signature),
                        url,
                        comment: note,
                        result: 'failed',
                        error: 'repeated action recovered',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, `🌐 ${scrollState && !scrollState.canScrollDown ? 'Достигла низа страницы; меняю стратегию вместо повторной прокрутки.' : 'Повторяющееся действие не дало прогресса; меняю стратегию.'}`);
                    await page.waitForTimeout(200);
                    continue;
                }

                const note = [
                    `Действие "${signature}" повторяется после восстановления и всё ещё не даёт прогресса.`,
                    'Не спрашивай пользователя про текущую страницу. Самостоятельно смени маршрут: go_back, прямой URL/поиск, другой selector, scroll в другую сторону, done по найденному результату или fail с причиной.',
                ].join(' ');
                state.notes.push(note);
                state.history.push({
                    step: i + 1,
                    label: `blocked_repeated_pause ${signature}`.slice(0, 140),
                    url,
                    comment: note,
                    result: 'failed',
                    error: 'repeated_pause_blocked',
                });
                state.iterationCount = i + 1;
                await sendProgress(ctx, '🌐 Повтор всё ещё не помогает; меняю маршрут без остановки задачи.');
                await page.waitForTimeout(200);
                continue;
            }

            if (shouldCritiqueDecision(decision, state, observation, repeatedCount)) {
                const critic = await critiqueDecisionWithLlm(taskForLlm, decision, observation, state);
                if (critic) {
                    browserLog('decision_critic', {
                        verdict: critic.verdict,
                        risk: critic.risk,
                        confidence: critic.confidence,
                        reason: critic.reason.slice(0, 260),
                    });
                    if (critic.verdict === 'ask_user' && critic.confidence >= 0.65) {
                        const question = critic.question || critic.reason || 'Нужен ручной ориентир для следующего действия.';
                        if (isInternalUiAmbiguityQuestion(question)) {
                            const note = [
                                `Decision critic предложил спросить пользователя про внутренний UI-выбор: ${question}`,
                                'Это должна решить браузерная система. Смени selector/стратегию или верни done/fail по текущим данным.',
                            ].join(' ');
                            state.notes.push(note.slice(0, 700));
                            state.history.push({
                                step: i + 1,
                                label: `blocked_critic_ui_ask_user ${actionSignature(decision)}`.slice(0, 140),
                                url,
                                comment: note,
                                result: 'failed',
                                error: 'critic_internal_ui_question_blocked',
                            });
                            state.iterationCount = i + 1;
                            await sendProgress(ctx, '🌐 Проверка попросила ручной ориентир, но это внутренний UI-выбор; продолжаю сама.');
                            await page.waitForTimeout(200);
                            continue;
                        }
                        pauseBrowserRun(ctx, state, question);
                        shouldClose = false;
                        await sendScreenshot(ctx, page, `❓ Нужен ручной ориентир: ${question.slice(0, 180)}`);
                        return {
                            responseText: formatBrowserPauseResponse(question, [], 'manual_step'),
                            keyboard: buildBrowserPauseKeyboard(state.id),
                        };
                    }
                    if (critic.verdict === 'block' && critic.confidence >= 0.68) {
                        const note = `Decision critic заблокировал действие "${actionSignature(decision)}": ${critic.reason}`;
                        state.notes.push(note.slice(0, 600));
                        state.history.push({
                            step: i + 1,
                            label: `decision_critic_block ${actionSignature(decision)}`.slice(0, 140),
                            url,
                            comment: note,
                            result: 'failed',
                            error: 'decision_critic_blocked',
                        });
                        state.iterationCount = i + 1;
                        await sendProgress(ctx, '🌐 Проверка решения нашла риск цикла или неверного контекста; меняю стратегию.');
                        await page.waitForTimeout(200);
                        continue;
                    }
                }
            }

            if (decision.action === 'done') {
                const doneSummary = decision.summary ?? 'Задача выполнена.';
                const universalBlockReason = universalCompletionBlockReason(taskForLlm, doneSummary, state, observation);
                if (universalBlockReason) {
                    state.notes.push(universalBlockReason.slice(0, 900));
                    state.history.push({
                        step: i + 1,
                        label: `blocked_universal_done ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment: universalBlockReason,
                        result: 'failed',
                        error: 'universal_done_missing_evidence',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Итог пока не доказан по критериям пользователя; продолжаю исследовать страницу.');
                    await page.waitForTimeout(200);
                    continue;
                }
                const shoppingBlockReason = shoppingCompletionBlockReason(taskForLlm, doneSummary, observation);
                if (shoppingBlockReason) {
                    state.notes.push(shoppingBlockReason.slice(0, 800));
                    state.history.push({
                        step: i + 1,
                        label: `blocked_shopping_done ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment: shoppingBlockReason,
                        result: 'failed',
                        error: 'shopping_done_missing_evidence',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Пока нельзя завершить подбор: нужен конкретный комплект и ссылки на товары. Продолжаю искать карточки и href.');
                    await page.waitForTimeout(200);
                    continue;
                }
                const finalDoneSummary = finalSummaryWithEvidence(doneSummary, state, taskForLlm);
                const completionReview = await reviewTaskCompletionWithLlm(taskForLlm, finalDoneSummary, observation, state);
                const completionBlockReason = completionReviewBlockReason(completionReview);
                if (completionBlockReason) {
                    browserLog('done_completion_blocked', {
                        reason: completionBlockReason.slice(0, 260),
                        confidence: completionReview?.confidence,
                    });
                    state.notes.push(`Completion review заблокировал done: ${completionBlockReason}`.slice(0, 1000));
                    state.history.push({
                        step: i + 1,
                        label: `completion_review_block ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment: completionBlockReason,
                        result: 'failed',
                        error: 'completion_review_blocked',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Итог ещё не покрывает все критерии пользователя; продолжаю проверять варианты и собирать доказательства.');
                    await page.waitForTimeout(200);
                    continue;
                }
                pushEvidence(state, 'success', finalDoneSummary, state.page.url());
                await sendScreenshot(ctx, page, browserDoneScreenshotCaption(finalDoneSummary));
                if (domain && domain !== state.sessionSavedForDomain) {
                    await BrowserSessionStore.save(state.browserCtx, state.userId, domain);
                    state.sessionSavedForDomain = domain;
                }
                if (domain) {
                    rememberSuccessfulSitePattern(domain, state, observation, finalDoneSummary);
                }
                const sentDownloads = await sendDownloadedFiles(ctx, state);
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.lastBrowserTask = {
                    originalTask: state.originalTask,
                    summary: finalDoneSummary,
                    url: state.page.url(),
                    title,
                    notes: state.notes.slice(-12),
                    pageText: browserTaskPageContextForSession(observation),
                    createdAt: Date.now(),
                    expiresAt: Date.now() + LAST_BROWSER_TASK_TTL_MS,
                };
                const downloadsLine = sentDownloads.length ? `\n\nФайлы: ${sentDownloads.join(', ')}` : '';
                return { responseText: formatBrowserDoneResponse(finalDoneSummary, downloadsLine) };
            }

            if (decision.action === 'fail') {
                await sendScreenshot(ctx, page, `❌ ${decision.summary?.slice(0, 200) ?? 'Не удалось выполнить'}`);
                ctx.session.pendingBrowserTask = undefined;
                return { responseText: `❌ Не удалось выполнить задачу.\n\n${decision.summary ?? 'Причина неизвестна.'}` };
            }

            if (decision.action === 'memory_lookup') {
                const query = (decision.value || decision.summary || decision.comment || taskForLlm).trim().slice(0, 500);
                const normalizedQuery = normalizeLookupQuery(query);
                if (decision.comment && decision.comment !== state.lastComment) {
                    await sendProgress(ctx, `🧠 ${decision.comment}`);
                    state.lastComment = decision.comment;
                }

                if (state.memoryLookupQueries.includes(normalizedQuery)) {
                    state.history.push({
                        step: i + 1,
                        label: `memory_lookup "${query.slice(0, 60)}"`,
                        url,
                        comment: 'Этот запрос к памяти уже выполнялся. Нужно выбрать другой запрос, использовать найденный контекст или спросить пользователя.',
                        result: 'failed',
                        error: 'duplicate memory_lookup',
                    });
                    state.iterationCount = i + 1;
                    continue;
                }

                if (state.memoryLookupQueries.length >= MAX_MEMORY_LOOKUPS) {
                    const question = 'Я уже проверила долговременную память несколькими запросами и не нашла недостающий факт. Уточни, пожалуйста, недостающие данные для продолжения.';
                    pauseBrowserRun(ctx, state, question);
                    shouldClose = false;
                    await sendScreenshot(ctx, page, `❓ Нужно уточнение: ${question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(question, [], 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id),
                    };
                }

                let result: ActionRecord['result'] = 'ok';
                let error: string | undefined;
                try {
                    state.memoryLookupQueries.push(normalizedQuery);
                    const memoryBlock = await lookupBrowserMemory(ctx, query);
                    if (memoryBlock) {
                        memoryForLlm = mergeMemoryContext(memoryForLlm, memoryBlock, query);
                        state.memoryContext = memoryForLlm;
                        const newCredentialCandidates = extractCredentialCandidatesFromText(memoryBlock, 'memory');
                        state.credentialCandidates.push(...newCredentialCandidates);
                        state.memoryCredentials = extractCredentialsFromMemory(memoryForLlm, domain) ?? state.memoryCredentials;
                        if (!state.activeCredentials || state.activeCredentials.source === 'memory') {
                            state.activeCredentials = resolveCredentialsForDomain(
                                state.userId,
                                domain,
                                state.credentialCandidates,
                                state.memoryCredentials
                            );
                        }
                        state.history.push({
                            step: i + 1,
                            label: `memory_lookup "${query.slice(0, 60)}"`,
                            url,
                            comment: `Нашла дополнительный контекст в долговременной памяти.`,
                            result,
                        });
                    } else {
                        state.history.push({
                            step: i + 1,
                            label: `memory_lookup "${query.slice(0, 60)}"`,
                            url,
                            comment: `В долговременной памяти не нашлось подходящего факта.`,
                            result,
                        });
                        if (
                            isBookingOrLeadFormSurface(observation) &&
                            hasVisibleBookingContactFields(observation) &&
                            isPrimaryBookingDataField(query)
                        ) {
                            const question = [
                                'Я проверила долгосрочную память, но не нашла достаточно данных для этой формы.',
                                bookingFormDataQuestion(observation),
                            ].join(' ');
                            pauseBrowserRun(ctx, state, question);
                            shouldClose = false;
                            await sendScreenshot(ctx, page, `❓ Нужны данные формы: ${question.slice(0, 180)}`);
                            return {
                                responseText: formatBrowserPauseResponse(question, [], 'clarification'),
                                keyboard: buildBrowserPauseKeyboard(state.id),
                            };
                        }
                    }
                } catch (err) {
                    result = 'failed';
                    error = safeErrorMessage(err);
                    state.history.push({
                        step: i + 1,
                        label: `memory_lookup "${query.slice(0, 60)}"`,
                        url,
                        comment: 'Не удалось выполнить поиск по памяти.',
                        result,
                        error,
                    });
                }
                state.iterationCount = i + 1;
                await page.waitForTimeout(200);
                continue;
            }

            if (decision.action === 'find_on_page') {
                const query = cleanWhitespace(decision.value || decision.selector || decision.summary || decision.comment || '');
                const label = `find_on_page "${query.slice(0, 70)}"`;
                if (decision.comment && decision.comment !== state.lastComment) {
                    await sendProgress(ctx, `🌐 ${decision.comment}`);
                    state.lastComment = decision.comment;
                }

                if (!query) {
                    state.history.push({
                        step: i + 1,
                        label: 'find_on_page',
                        url,
                        comment: 'Пустой запрос поиска по странице.',
                        result: 'failed',
                        error: 'empty_find_query',
                    });
                    state.iterationCount = i + 1;
                    continue;
                }

                const repeatedFind = state.history.slice(-4).some((record) => record.label === label);
                if (repeatedFind) {
                    const note = `Поиск по странице "${query}" уже выполнялся недавно. Не повторяй его: используй найденный блок, другой запрос, visual selector, go_back или завершай по текущим данным.`;
                    state.notes.push(note);
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment: note,
                        result: 'failed',
                        error: 'duplicate_find_on_page',
                    });
                    state.iterationCount = i + 1;
                    await page.waitForTimeout(200);
                    continue;
                }

                try {
                    const found = await findOnPage(page, query);
                    const comment = `Нашла на странице "${query}": ${found.text.slice(0, 180)}`;
                    state.notes.push(`find_on_page: ${found.text}`.slice(0, 500));
                    pushEvidence(state, 'observation', `find_on_page "${query}": ${found.text}`, state.page.url());
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment,
                        result: 'ok',
                    });
                    state.iterationCount = i + 1;
                    state.consecutiveActionFailures = 0;
                    await sendProgress(ctx, `🌐 ${comment}`);
                } catch (err) {
                    const error = safeErrorMessage(err);
                    state.notes.push(`Поиск по странице "${query}" не дал результата: ${error}`);
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment: `Не нашла на текущей странице: ${query}`,
                        result: 'failed',
                        error,
                    });
                    state.iterationCount = i + 1;
                }
                await page.waitForTimeout(250);
                continue;
            }

            if (decision.action === 'site_search') {
                const query = cleanWhitespace(decision.value || decision.summary || decision.comment || '');
                const label = `site_search "${query.slice(0, 70)}"`;
                if (decision.comment && decision.comment !== state.lastComment) {
                    await sendProgress(ctx, `🌐 ${decision.comment}`);
                    state.lastComment = decision.comment;
                }

                if (!query) {
                    state.history.push({
                        step: i + 1,
                        label: 'site_search',
                        url,
                        comment: 'Пустой запрос поиска по сайту.',
                        result: 'failed',
                        error: 'empty_site_search_query',
                    });
                    state.iterationCount = i + 1;
                    continue;
                }

                if (state.history.slice(-5).some((record) => record.label === label)) {
                    const note = `Поиск по сайту "${query}" уже выполнялся недавно. Используй результаты, другой запрос, меню/фильтр, find_on_page или заверши по найденным данным.`;
                    state.notes.push(note);
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment: note,
                        result: 'failed',
                        error: 'duplicate_site_search',
                    });
                    state.iterationCount = i + 1;
                    await page.waitForTimeout(200);
                    continue;
                }

                try {
                    const searchSummary = await runSiteSearch(page, query);
                    await adoptLatestPage(state);
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment: searchSummary,
                        result: 'ok',
                    });
                    state.notes.push(`Выполнен поиск по сайту: ${query}`);
                    pushEvidence(state, 'action', `Выполнен поиск по сайту: ${query}; ${searchSummary}`, state.page.url());
                    state.iterationCount = i + 1;
                    state.consecutiveActionFailures = 0;
                    await sendProgress(ctx, `🌐 Ищу на сайте: ${query}`);
                } catch (err) {
                    const error = safeErrorMessage(err);
                    state.notes.push(`Поиск по сайту "${query}" не сработал: ${error}`);
                    state.history.push({
                        step: i + 1,
                        label,
                        url,
                        comment: `Не удалось воспользоваться поиском сайта: ${query}`,
                        result: 'failed',
                        error,
                    });
                    state.iterationCount = i + 1;
                }
                await page.waitForTimeout(500);
                continue;
            }

            if (decision.action === 'note') {
                const note = (decision.summary || decision.comment || decision.value || '').trim();
                if (note) {
                    state.notes.push(redactSecrets(note).slice(0, 500));
                    pushEvidence(state, 'data', note, state.page.url());
                    if (state.notes.length > 30) {
                        state.notes.splice(0, state.notes.length - 30);
                    }
                }
                state.history.push({
                    step: i + 1,
                    label: 'note',
                    url,
                    comment: note || 'Рабочая заметка сохранена.',
                    result: 'ok',
                });
                state.iterationCount = i + 1;
                if (note && shouldCompleteShoppingBrowseFromNote(taskForLlm, note)) {
                    await sendScreenshot(ctx, page, `✅ Готово: ${note.slice(0, 200)}`);
                    if (domain) {
                        await BrowserSessionStore.save(state.browserCtx, state.userId, domain).catch(() => {});
                        state.sessionSavedForDomain = domain;
                        rememberSuccessfulSitePattern(domain, state, observation, note);
                    }
                    ctx.session.pendingBrowserTask = undefined;
                    ctx.session.lastBrowserTask = {
                        originalTask: state.originalTask,
                        summary: note,
                        url: state.page.url(),
                        title,
                        notes: state.notes.slice(-12),
                        pageText: browserTaskPageContextForSession(observation),
                        createdAt: Date.now(),
                        expiresAt: Date.now() + LAST_BROWSER_TASK_TTL_MS,
                    };
                    return { responseText: `✅ Готово!\n\n${note}` };
                }
                continue;
            }

            if (decision.action === 'ask_user') {
                if (hasDismissibleTechnicalOverlay(observation)) {
                    const comment = await dismissOverlays(page).catch((err) => `не удалось закрыть техническое окно: ${safeErrorMessage(err)}`);
                    state.notes.push(`LLM хотела спросить про техническое окно, но это внутренняя браузерная задача. ${comment}`.slice(0, 700));
                    state.history.push({
                        step: i + 1,
                        label: `auto_dismiss_before_ask_user ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment,
                        result: comment.startsWith('не удалось') ? 'failed' : 'ok',
                        error: comment.startsWith('не удалось') ? 'technical_overlay_dismiss_failed' : undefined,
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Это техническое окно сайта; закрываю его сама и продолжаю задачу.');
                    await page.waitForTimeout(250);
                    continue;
                }
                const { question, choices } = buildBrowserPausePrompt(decision, observation, taskForLlm);
                if (isInternalUiAmbiguityQuestion(question)) {
                    const note = [
                        `LLM попыталась спросить пользователя про внутренний UI-выбор: ${question}`,
                        'Не делай этого. Самостоятельно выбери по DOM/скриншоту/context или смени стратегию: scroll, wait, go_back, поиск, прямой URL, другой selector, done/fail.',
                    ].join(' ');
                    state.notes.push(note.slice(0, 800));
                    state.history.push({
                        step: i + 1,
                        label: `blocked_internal_ui_ask_user ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment: note,
                        result: 'failed',
                        error: 'internal_ui_question_blocked',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Это внутренний выбор на странице; решаю его сама и меняю стратегию.');
                    await page.waitForTimeout(200);
                    continue;
                }
                pauseBrowserRun(ctx, state, question, undefined, choices);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно уточнение: ${question.slice(0, 180)}`);
                return {
                    responseText: formatBrowserPauseResponse(question, choices, 'clarification'),
                    keyboard: buildBrowserPauseKeyboard(state.id, choices),
                };
            }

            if (decision.comment && decision.comment !== state.lastComment) {
                await sendProgress(ctx, `🌐 ${decision.comment}`);
                state.lastComment = decision.comment;
            }

            const stayOnBookingFormReason = shouldStayOnVisibleBookingForm(taskForLlm, observation, decision);
            if (stayOnBookingFormReason) {
                state.notes.push(stayOnBookingFormReason);
                state.history.push({
                    step: i + 1,
                    label: `blocked_booking_form_navigation ${decision.value || decision.action}`.slice(0, 140),
                    url,
                    comment: stayOnBookingFormReason,
                    result: 'failed',
                    error: 'booking_form_navigation_blocked',
                });
                state.iterationCount = i + 1;
                await sendProgress(ctx, '🌐 Форма записи уже открыта; остаюсь на ней и продолжаю заполнение.');
                await page.waitForTimeout(200);
                continue;
            }

            const blockedNavigationReason = shouldBlockGuessedFollowUpNavigation(state, decision);
            if (blockedNavigationReason) {
                state.notes.push(blockedNavigationReason);
                state.history.push({
                    step: i + 1,
                    label: `blocked_navigation ${decision.value || ''}`.slice(0, 120),
                    url,
                    comment: blockedNavigationReason,
                    result: 'failed',
                    error: 'guessed_external_domain',
                });
                state.iterationCount = i + 1;
                continue;
            }

            const highImpactAction = isHighImpactAction(decision) || earlyBookingSubmitDecision;
            const label = actionSignature(decision);
            let result: ActionRecord['result'] = 'ok';
            let error: string | undefined;
            let visualRecoveryComment: string | undefined;
            let actionResultComment: string | undefined;
            let actionFailureKind: string | undefined;
            const beforeActionUrl = state.page.url();
            const startedAt = Date.now();

            try {
                const targetDebug = await describeActionTarget(page, decision).catch((err) => ({
                    action: decision.action,
                    targetError: safeErrorMessage(err),
                }));
                browserLog('action_target', {
                    iter: i + 1,
                    ...targetDebug,
                });
                const targetRecord = targetDebug as Record<string, unknown>;
                const shoppingTargetBlockReason = shouldBlockMisdirectedShoppingTarget(taskForLlm, decision, targetRecord);
                if (shoppingTargetBlockReason) {
                    browserLog('shopping_target_blocked', {
                        action: actionSignature(decision),
                        href: targetRecord.href || targetRecord.hrefFromSelector,
                        text: targetRecord.text,
                        reason: shoppingTargetBlockReason,
                    });
                    state.notes.push(shoppingTargetBlockReason);
                    state.history.push({
                        step: i + 1,
                        label: `blocked_shopping_target ${actionSignature(decision)}`.slice(0, 140),
                        url,
                        comment: shoppingTargetBlockReason,
                        result: 'failed',
                        error: 'shopping_target_blocked',
                    });
                    state.iterationCount = i + 1;
                    await sendProgress(ctx, '🌐 Этот клик не соответствует текущей цели подбора; ищу правильный фильтр, категорию или карточку товара.');
                    await page.waitForTimeout(200);
                    continue;
                }
                const actionSummary = await doAction(page, decision, state.activeCredentials, state);
                if (typeof actionSummary === 'string' && actionSummary) {
                    actionResultComment = actionSummary;
                    state.notes.push(actionSummary.slice(0, 500));
                    pushEvidence(state, 'action', actionSummary, state.page.url());
                }
                await adoptLatestPage(state);
                state.consecutiveActionFailures = 0;
            } catch (err: any) {
                result = 'failed';
                error = safeErrorMessage(err);
                state.consecutiveActionFailures += 1;
                console.warn(`[BROWSER] action "${decision.action}" failed:`, error);

                const failureClass = classifyBrowserActionFailure(err, decision);
                actionFailureKind = failureClass.kind;
                state.notes.push(`Ошибка действия (${failureClass.kind}): ${failureClass.recovery}`.slice(0, 700));
                browserLog('action_failure_classified', {
                    iter: i + 1,
                    action: decision.action,
                    kind: failureClass.kind,
                    recovery: failureClass.recovery,
                });

                if (failureClass.kind === 'browser_infrastructure' && !highImpactAction) {
                    try {
                        await ensureUsableBrowserPage(state);
                        page = state.page;
                        const retrySummary = await doAction(page, decision, state.activeCredentials, state);
                        result = 'ok';
                        error = undefined;
                        state.consecutiveActionFailures = 0;
                        actionResultComment = typeof retrySummary === 'string' && retrySummary
                            ? `После восстановления вкладки: ${retrySummary}`
                            : 'Повторила действие после восстановления вкладки.';
                        state.notes.push(actionResultComment.slice(0, 500));
                        pushEvidence(state, 'action', actionResultComment, state.page.url());
                        await adoptLatestPage(state);
                    } catch (retryErr) {
                        const retryError = safeErrorMessage(retryErr);
                        error = `${error}; recovery_retry=${retryError}`.slice(0, 240);
                        state.notes.push(`Восстановление вкладки не помогло: ${retryError}`.slice(0, 500));
                    }
                }

                if (result !== 'ok') {
                    const selfHealing = await trySelfHealingAction(page, decision).catch((healingErr) => ({
                        status: 'none' as const,
                        reason: safeErrorMessage(healingErr),
                    }));
                    if (selfHealing.status === 'healed') {
                        result = 'ok';
                        error = undefined;
                        state.consecutiveActionFailures = 0;
                        actionResultComment = selfHealing.comment;
                        state.notes.push(selfHealing.comment.slice(0, 500));
                        pushEvidence(state, 'action', selfHealing.comment, state.page.url());
                        await sendProgress(ctx, `🌐 ${selfHealing.comment}`);
                        await adoptLatestPage(state);
                    } else if (selfHealing.reason !== 'action_not_supported') {
                        state.notes.push(`Self-healing selector не сработал: ${selfHealing.reason}`.slice(0, 500));
                    }
                }

                if (result !== 'ok' && decision.action === 'click' && observation.screenshotB64) {
                    const visualRecovery = await maybeUseVisualLayoutClick(
                        page,
                        taskForLlm,
                        decision,
                        observation,
                        `DOM-клик не сработал: ${error}`
                    ).catch((recoveryErr) => ({
                        status: 'failed' as const,
                        reason: safeErrorMessage(recoveryErr),
                    }));
                    if (visualRecovery.status === 'clicked') {
                        result = 'ok';
                        error = undefined;
                        state.consecutiveActionFailures = 0;
                        visualRecoveryComment = `Нашла нужный элемент визуально и нажала его: ${visualRecovery.label}`;
                        await sendProgress(ctx, `🌐 ${visualRecoveryComment}`);
                        await adoptLatestPage(state);
                    } else if (visualRecovery.status === 'failed') {
                        state.notes.push(`Визуальное восстановление клика не сработало: ${visualRecovery.reason}`);
                    }
                }
            }
            browserLog('action_result', {
                iter: i + 1,
                action: decision.action,
                result,
                elapsedMs: Date.now() - startedAt,
                beforeUrl: safeLogUrl(beforeActionUrl),
                afterUrl: safeLogUrl(state.page.url()),
                urlChanged: !urlsEquivalent(beforeActionUrl, state.page.url()),
                consecutiveFailures: state.consecutiveActionFailures,
                actionResult: actionResultComment,
                visualRecovery: visualRecoveryComment,
                failureKind: actionFailureKind,
                error,
            });
            recordBrowserTrajectoryEvent(state, 'action.result', {
                iter: i + 1,
                action: decision.action,
                label,
                result,
                elapsedMs: Date.now() - startedAt,
                beforeUrl: safeLogUrl(beforeActionUrl),
                afterUrl: safeLogUrl(state.page.url()),
                urlChanged: !urlsEquivalent(beforeActionUrl, state.page.url()),
                consecutiveFailures: state.consecutiveActionFailures,
                actionResult: actionResultComment,
                visualRecovery: visualRecoveryComment,
                failureKind: actionFailureKind,
                error,
            });
            if (shouldVerifyActionOutcome(decision, result)) {
                const afterObservation = await getPageObservation(state.page, state.pageEvents).catch(() => null);
                if (afterObservation) {
                    const outcome = await verifyActionOutcomeWithLlm(
                        taskForLlm,
                        decision,
                        observation,
                        afterObservation,
                        state.pageUnderstanding
                    );
                    if (outcome) {
                        state.lastActionOutcome = outcome;
                        browserLog('action_outcome', {
                            changed: outcome.changed,
                            progress: outcome.progress,
                            sameLoopRisk: outcome.sameLoopRisk,
                            next: outcome.nextExpectedPhase,
                            confidence: outcome.confidence,
                            evidence: outcome.evidence.join(' | ').slice(0, 260),
                        });
                        recordBrowserTrajectoryEvent(state, 'action.outcome', {
                            changed: outcome.changed,
                            progress: outcome.progress,
                            sameLoopRisk: outcome.sameLoopRisk,
                            nextExpectedPhase: outcome.nextExpectedPhase,
                            confidence: outcome.confidence,
                            evidence: outcome.evidence,
                        });
                        if (outcome.progress && outcome.progress !== 'unknown') {
                            state.notes.push(`Результат последнего действия: ${outcome.progress}. ${outcome.evidence.join(' ')}`.slice(0, 500));
                        }
                        for (const evidence of outcome.evidence) {
                            pushEvidence(state, /success|submitted|created|готов|успеш/iu.test(outcome.progress) ? 'success' : 'observation', evidence, state.page.url());
                        }
                    }
                }
            }
            if (highImpactAction) state.highImpactConfirmed = false;

            const newDomain = extractDomain(state.page.url());
            if (newDomain && newDomain !== state.sessionSavedForDomain && newDomain !== 'about:blank') {
                await BrowserSessionStore.save(state.browserCtx, state.userId, newDomain).catch(() => {});
                state.sessionSavedForDomain = newDomain;
            }

            state.iterationCount = i + 1;
            state.history.push({
                step: i + 1,
                label,
                url,
                comment: visualRecoveryComment || actionResultComment || decision.comment || '',
                result,
                error,
            });

            if (state.consecutiveActionFailures >= MAX_CONSECUTIVE_ACTION_FAILURES) {
                let recoveredFromStuck = false;
                for (let recoveryAttempt = 0; recoveryAttempt < 2; recoveryAttempt += 1) {
                    const recoveryPlan = chooseBrowserStuckRecoveryPlan(
                        state,
                        observation,
                        taskForLlm,
                        state.page.url(),
                        `consecutive_failures_${state.consecutiveActionFailures}`
                    );
                    if (!recoveryPlan) break;
                    recoveredFromStuck = await executeBrowserStuckRecoveryPlan(
                        ctx,
                        state,
                        state.page,
                        recoveryPlan,
                        i + 1,
                        state.page.url()
                    );
                    if (recoveredFromStuck) break;
                }
                if (recoveredFromStuck) continue;

                const question = 'Несколько действий подряд не сработали на странице. Нужен ручной ориентир: что нажать или какие данные использовать дальше?';
                pauseBrowserRun(ctx, state, question);
                shouldClose = false;
                await sendScreenshot(ctx, state.page, `❓ Нужен ручной ориентир: ${question.slice(0, 180)}`);
                return {
                    responseText:
                        `Я остановилась после нескольких неудачных действий подряд.\n\n${question}\n\n` +
                        'Ответь следующим сообщением. Если хочешь отменить задачу, напиши «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            await page.waitForTimeout(result === 'ok' ? 500 : 900);
        }

        const question = 'Достигнут лимит операций для текущей браузерной задачи. Продолжить с этой же страницы ещё один цикл или остановить задачу?';
        const choices = iterationLimitContinuationChoices();
        state.iterationCount = MAX_ITERATIONS;
        state.notes.push('Достигнут лимит операций; жду решения пользователя, продолжать ли с текущей страницы.'.slice(0, 500));
        pauseBrowserRun(ctx, state, question, undefined, choices);
        shouldClose = false;
        await sendScreenshot(ctx, state.page, `⏱️ Лимит операций: ${question.slice(0, 180)}`);
        return {
            responseText:
                `⏰ ${question}\n\n` +
                'Нажми «Продолжить» или ответь текстом. Если хочешь остановить задачу, напиши «отмена».',
            keyboard: buildBrowserPauseKeyboard(state.id, choices),
        };
    } catch (err: any) {
        if (state?.cancelRequested) {
            ctx.session.pendingBrowserTask = undefined;
            ctx.session.activeBrowserTask = undefined;
            recordBrowserTrajectoryEvent(state, 'lifecycle.cancel_acknowledged', {
                error: safeErrorMessage(err),
            });
            return { responseText: 'Ок, браузерную задачу остановила.' };
        }
        console.error('[BROWSER] fatal error:', err);
        recordBrowserTrajectoryEvent(state, 'lifecycle.error', {
            error: safeErrorMessage(err),
        });
        ctx.session.pendingBrowserTask = undefined;
        ctx.session.activeBrowserTask = undefined;
        return { responseText: `❌ Ошибка браузера: ${safeErrorMessage(err) || 'неизвестная ошибка'}` };
    } finally {
        if (state && ctx.session.activeBrowserTask?.sessionId === state.id) {
            ctx.session.activeBrowserTask = undefined;
        }
        if (state && shouldClose) {
            await closeBrowserRunState(state, 'done').catch(() => {});
        }
    }
}

export async function browserAgent(
    ctx: BotContext,
    message: string,
    isForwarded: boolean = false,
    forwardFrom: string = '',
    messageHistory: MessageHistory[] = [],
    classification?: MessageClassification,
    injectedMemoryContext?: string
): Promise<ProcessingResult> {
    if (shouldInterruptActiveBrowserRun(ctx, message)) {
        const activeState = getActiveBrowserSession(ctx);
        if (activeState) {
            activeState.cancelRequested = true;
            activeState.cancelAcknowledged = true;
        }
        if (ctx.session.pendingBrowserTask?.sessionId) {
            await cancelPausedBrowserSession(ctx.session.pendingBrowserTask.sessionId).catch(() => {});
        }
        ctx.session.pendingBrowserTask = undefined;
        ctx.session.activeBrowserTask = undefined;
        browserLog('browser_lane_interrupt', {
            laneKey: browserRunOwnerKeyForContext(ctx),
            activeSessionId: activeState?.id,
        });
        return { responseText: 'Ок, браузерную задачу остановила.' };
    }

    return enqueueBrowserAgentLane(ctx, () =>
        runBrowserAgent(
            ctx,
            message,
            isForwarded,
            forwardFrom,
            messageHistory,
            classification,
            injectedMemoryContext
        )
    );
}
