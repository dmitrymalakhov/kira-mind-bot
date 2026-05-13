import { chromium, Browser, BrowserContext, Frame, Locator, Page } from 'playwright';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InlineKeyboard, InputFile } from 'grammy';
import type { BotContext, MessageHistory } from '../types';
import type { ProcessingResult, MessageClassification } from '../orchestrator';
import openai from '../openai';
import { devLog, parseLLMJson } from '../utils';
import { fetchAgentMemoryContext, buildMemoryContextBlock } from '../utils/agentMemoryContext';
import { BrowserSessionStore } from '../services/BrowserSessionStore';
import { BrowserCredentialService } from '../services/BrowserCredentialService';

const MAX_ITERATIONS = 35;
const MAX_MEMORY_LOOKUPS = 6;
const MAX_CONSECUTIVE_ACTION_FAILURES = 4;
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const VISION_MODEL = 'gpt-4o';
const SCREENSHOT_INTERVAL = 6;
const PENDING_BROWSER_TTL_MS = 15 * 60 * 1000;
const LAST_BROWSER_TASK_TTL_MS = 45 * 60 * 1000;
const BROWSER_SITE_PATTERNS_FILE = path.join(__dirname, '..', 'data', 'browser-site-patterns.json');
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
    /** CSS, text=..., role=button[name="..."], label=..., placeholder=..., testid=..., frame=N >> ... или видимый текст */
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
    bbox: string;
    center: string;
    context: string;
    position: string;
    zIndex: number;
    modalLike: boolean;
    score: number;
}

type VisualLayoutClickResult =
    | { status: 'none'; reason?: string }
    | { status: 'clicked'; label: string; controlIndex: number; reason: string }
    | { status: 'failed'; reason: string };

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
    affordanceGraphText: string;
    formText: string;
    modalText: string;
    frameText: string;
    pageText: string;
    selectOptions: string;
    runtimeSignals: string;
}

interface BrowserDownload {
    filename: string;
    filePath: string;
    url: string;
}

interface BrowserRunState {
    id: string;
    userId: number;
    chatId?: number;
    browser: Browser;
    browserCtx: BrowserContext;
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
    downloads: BrowserDownload[];
    lastComment: string;
    lastUserAnswer: string;
    lastScreenshotDomain: string;
    lastCredentialDomain: string;
    sessionSavedForDomain: string;
    followUpOriginDomain: string;
    iterationCount: number;
    consecutiveActionFailures: number;
    highImpactConfirmed: boolean;
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
    'wait',
    'go_back',
    'memory_lookup',
    'note',
    'ask_user',
    'done',
    'fail',
]);

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
                        const selectors = robustSelectors.length ? robustSelectors : [indexSelector];
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
                            alt: [...selectors.slice(1), ...(robustSelectors.length ? [indexSelector] : [])].slice(0, 4),
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

async function getStructuredPageText(page: Page): Promise<string> {
    try {
        const blocks = await page.evaluate((interactiveSelector) => {
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
            const titleOf = (root: HTMLElement, fullText: string, actionLabels: string[]) => {
                const titleCandidates = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],strong,b'))
                    .map((el) => compact((el as HTMLElement).innerText || el.textContent))
                    .filter((text) => text && text.length <= 140 && !actionLabels.includes(text));
                if (titleCandidates.length) return titleCandidates[0];

                const lines = fullText
                    .split(/\n+/u)
                    .map((line) => compact(line))
                    .filter(Boolean)
                    .filter((line) => line.length <= 160 && !actionLabels.includes(line));
                return lines[0] || fullText.slice(0, 120);
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
                    const text = compact(parent.innerText || parent.textContent);
                    if (!text || text === label || text.length < 16) continue;

                    const rect = parent.getBoundingClientRect();
                    const interactiveCount = parent.querySelectorAll(interactiveSelector).length;
                    const tooBroad =
                        parent === document.body ||
                        text.length > 2800 ||
                        interactiveCount > 18 ||
                        rect.width > window.innerWidth * 1.12 ||
                        rect.height > window.innerHeight * 3.2;
                    if (tooBroad) continue;

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
                const text = compact(best.innerText || best.textContent);
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
	                const modalScore = (el: Element, knownModalRoot: boolean) => {
	                    const rect = el.getBoundingClientRect();
	                    const style = window.getComputedStyle(el);
	                    const classAndId = compact(`${el.getAttribute('id') || ''} ${(el as HTMLElement).className?.toString?.() || ''}`);
	                    const text = compact((el as HTMLElement).innerText || el.textContent);
	                    const buttons = buttonTexts(el);
	                    const lowerButtons = buttons.map((button) => button.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'));
	                    const decisionIntent = hasDecisionIntent(text, buttons);

	                    if (!buttons.length || text.length < 8 || text.length > 1400) return -1000;
	                    if (rect.width < 80 || rect.height < 40) return -1000;
	                    if (rect.width > window.innerWidth * 0.96 && rect.height > window.innerHeight * 0.96) return -1000;
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

    const checks: Array<[RegExp, string]> = [
        [/(captcha|recaptcha|hcaptcha|я\s+не\s+робот|подтвердите,\s*что\s+вы\s+не\s+робот)/i, 'captcha/anti-bot challenge visible'],
        [/(sms|смс|одноразов|otp|2fa|two[-\s]?factor|код\s+(?:из|подтверждения|безопасности))/i, 'one-time code or 2FA required'],
        [/(банковск\w*\s+карт|card\s+number|cvv|cvc|оплат|payment|checkout|pay\s+now)/i, 'payment/card flow visible'],
        [/(паспорт|passport|снилс|snils|инн|inn|document\s+number|номер\s+документа)/i, 'identity document data requested'],
        [/(ошибка|error|invalid|required|обязательн|неверн|failed|try\s+again)/i, 'form validation or page error visible'],
        [/(войдите|sign\s+in|log\s+in|авторизац|login|password|пароль)/i, 'authentication flow visible'],
    ];

    for (const [pattern, label] of checks) {
        if (pattern.test(text) && !signals.includes(label)) signals.push(label);
    }

    return signals.length ? signals.map((signal) => `  - ${signal}`).join('\n') : '';
}

async function getPageObservation(page: Page, pageEvents: string[] = []): Promise<PageObservation> {
    const [screenshotBuf, pageState, a11yText, interactiveText, structureText, affordanceGraphText, formText, modalText, frameText, pageText, selectOptions] = await Promise.all([
        takeJpeg(page).catch((err) => {
            browserLog('observation_screenshot_failed', {
                url: safeLogUrl(page.url()),
                reason: safeErrorMessage(err),
            });
            return fallbackScreenshotBuffer();
        }),
        getPageStateText(page),
        getAccessibilityText(page),
        getInteractiveElementsText(page),
        getStructuredPageText(page),
        getAffordanceGraphText(page),
        getFormDiagnosticsText(page),
        getModalDiagnosticsText(page),
        getFrameDiagnosticsText(page),
        getVisiblePageText(page),
        getSelectOptions(page),
    ]);

    const blockerSignals = collectBlockerSignals([
        pageState,
        a11yText,
        interactiveText,
        structureText,
        affordanceGraphText,
        formText,
        modalText,
        frameText,
        pageText,
        pageEvents.slice(-12).join('\n'),
    ]);

    return {
        screenshotB64: screenshotBuf.toString('base64'),
        pageState,
        blockerSignals,
        a11yText,
        interactiveText,
        structureText,
        affordanceGraphText,
        formText,
        modalText,
        frameText,
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
    return /(оплат|плат[её]ж|заплат|купить|покупк|оформить\s+заказ|заказать|отправить\s+заявк|отправляю\s+заявк|заявк[ауи]|checkout|payment|pay\b|purchase|buy\b|confirm|подтверд|забронировать|бронь|reserve|book\b|submit\s+order)/i.test(text);
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

function sensitiveSurface(decision: BrowserAction, observation: PageObservation): string {
    return [
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
        observation.blockerSignals,
        observation.formText,
        observation.modalText,
        observation.frameText,
    ].filter(Boolean).join(' ');
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
    const pageSurface = sensitiveSurface(decision, observation);
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

    if (/(captcha|recaptcha|hcaptcha|я\s+не\s+робот)/i.test(pageSurface)) {
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

function pushPageEvent(state: BrowserRunState, event: string): void {
    state.pageEvents.push(`${new Date().toISOString()} ${redactSecrets(event)}`.slice(0, 500));
    if (state.pageEvents.length > 40) {
        state.pageEvents.splice(0, state.pageEvents.length - 40);
    }
}

function attachPageObserversToPage(state: BrowserRunState, page: Page): void {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('console', (msg) => {
        if (!['error', 'warning'].includes(msg.type())) return;
        pushPageEvent(state, `[console:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
        pushPageEvent(state, `[pageerror] ${safeErrorMessage(err)}`);
    });
    page.on('response', (response) => {
        const status = response.status();
        if (status < 400) return;
        const resourceType = response.request().resourceType();
        if (!['document', 'xhr', 'fetch'].includes(resourceType)) return;
        pushPageEvent(state, `[http:${status}:${resourceType}] ${response.url()}`);
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
            pushPageEvent(state, `[download] ${filename}`);
        } catch (err) {
            pushPageEvent(state, `[download:error] ${safeErrorMessage(err)}`);
        }
    });
}

function attachPageObservers(state: BrowserRunState): void {
    attachPageObserversToPage(state, state.page);
    state.browserCtx.on('page', (page) => {
        attachPageObserversToPage(state, page);
    });
}

async function adoptLatestPage(state: BrowserRunState): Promise<void> {
    const pages = state.browserCtx.pages().filter((p) => !p.isClosed());
    const latest = pages[pages.length - 1];
    if (!latest || latest === state.page) return;

    await latest.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    state.page = latest;
    attachPageObserversToPage(state, latest);
    pushPageEvent(state, `[browser] switched to new page ${latest.url()}`);
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
    return /^(?:отмена|отмени(?:ть)?|cancel|stop|стоп|(?:просто\s+)?останови\p{L}*(?:\s+вс[её].*)?|остановить(?:\s+вс[её].*)?|прекрати|хватит|не\s+продолжай|ничего\s+не\s+делай|просто\s+остановить.*)\s*[.!?…]*$/iu.test(cleanWhitespace(text));
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
}

function resumeBrowserRun(ctx: BotContext, state: BrowserRunState): void {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = undefined;
    pausedBrowserSessions.delete(state.id);
    ctx.session.pendingBrowserTask = undefined;
    registerActiveBrowserRun(ctx, state);
}

async function closeBrowserRunState(state: BrowserRunState, reason: 'done' | 'failed' | 'expired' | 'cancelled'): Promise<void> {
    if (state.timeout) clearTimeout(state.timeout);
    pausedBrowserSessions.delete(state.id);
    activeBrowserSessions.delete(browserRunOwnerKey(state.userId, state.chatId));

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
            const response = await openai.chat.completions.create({
                model: 'gpt-5.4-nano',
                max_tokens: 600,
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
        await element.selectOption({ label: item.value }).catch(async () => {
            await element.selectOption(item.value);
        });
    } else {
        await element.fill(item.value);
    }
    await element.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
    const confirmed = await element.evaluate((el, expected) => {
        const compact = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, ' ').trim();
        const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const tag = el.tagName.toLowerCase();
        const current = compact(
            tag === 'select'
                ? (input as HTMLSelectElement).selectedOptions?.[0]?.text || (input as HTMLSelectElement).value
                : (input as HTMLInputElement | HTMLTextAreaElement).value
        );
        return current === compact(expected);
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
    if (!parsed?.action || !VALID_BROWSER_ACTIONS.has(parsed.action)) return null;
    return parsed as BrowserAction;
}

async function repairBrowserActionJson(text: string): Promise<BrowserAction | null> {
    const source = text.trim();
    if (!source) return null;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            max_tokens: 260,
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
    sitePatternsText?: string
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
        'Если видны ошибки обязательных полей/валидации, phase=validation_error и missingData заполни конкретными полями.',
        'ledger.pending должен отражать следующие оставшиеся шаги процесса, например submit, site_confirmation_modal, wait_for_success.',
        'taskPlan верни как стабильный чеклист процесса: шаги open/find/open_form/fill/confirm_submit/handle_site_modal/verify_success или доменно подходящие аналоги. Сохраняй уже выполненные шаги done.',
        '',
        `Задача пользователя:\n${redactSecrets(task).slice(0, 1800)}`,
        '',
        `Предыдущий ledger:\n${taskLedgerSummary(previousLedger)}`,
        '',
        `Предыдущий план:\n${taskPlanSummary(previousPlan)}`,
        '',
        `Известные паттерны этого домена:\n${sitePatternsText || '(нет доменного паттерна)'}`,
        '',
        `История действий:\n${redactSecrets(recentHistory).slice(0, 1800)}`,
        '',
        `Модалки:\n${redactSecrets(observation.modalText || '').slice(0, 1600)}`,
        '',
        `Формы:\n${redactSecrets(observation.formText || '').slice(0, 1800)}`,
        '',
        `Структура:\n${redactSecrets(observation.structureText || '').slice(0, 2200)}`,
        '',
        `Affordance graph:\n${redactSecrets(observation.affordanceGraphText || '').slice(0, 2600)}`,
        '',
        `Видимый текст:\n${redactSecrets(observation.pageText || '').slice(0, 2200)}`,
        '',
        `Сигналы:\n${redactSecrets(observation.blockerSignals || '').slice(0, 800)}`,
        '',
        'Формат:',
        '{"phase":"booking_form","whatIsHappening":"...","blockingElement":"modal|form|none","primaryVisibleAction":"...","successEvidence":null,"missingData":[],"nextExpectedPhase":"...","confidence":0.0,"evidence":["..."],"ledger":{"goal":"...","target":"...","date":"...","formData":{"team":"..."},"filled":["..."],"pending":["..."],"confirmations":["..."],"lastEvidence":["..."]},"taskPlan":[{"id":"open","label":"Открыть сайт","status":"done","evidence":"..."},{"id":"handle_site_modal","label":"Ответить на модалку сайта","status":"in_progress","evidence":"..."}]}',
    ].join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: VISION_MODEL,
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
    const understanding = await understandPageStateWithLlm(task, observation, state.history, state.taskLedger, state.taskPlan, sitePatternsText);
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
        `Affordance graph:\n${redactSecrets(observation.affordanceGraphText || '').slice(0, 2200)}`,
        '',
        `Модалки:\n${redactSecrets(observation.modalText || '').slice(0, 1400)}`,
        '',
        'Формат: {"verdict":"allow|block|ask_user","risk":"low|medium|high","confidence":0.0,"reason":"...","question":"..."}',
    ].join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: VISION_MODEL,
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
        '',
        `Задача:\n${redactSecrets(task).slice(0, 1400)}`,
        '',
        `Действие:\n${redactSecrets(actionSignature(decision)).slice(0, 500)}\ncomment=${redactSecrets(decision.comment || '').slice(0, 500)}`,
        '',
        `Предыдущее понимание:\n${pageUnderstandingSummary(previousUnderstanding)}`,
        '',
        `Before modal/form/text:\n${redactSecrets([before.modalText, before.formText, before.pageText].filter(Boolean).join('\n')).slice(0, 2400)}`,
        '',
        `After modal/form/text:\n${redactSecrets([after.modalText, after.formText, after.pageText].filter(Boolean).join('\n')).slice(0, 2600)}`,
        '',
        'Формат: {"changed":true,"progress":"modal_opened|form_submitted|success|validation_error|no_visible_change|...","sameLoopRisk":false,"nextExpectedPhase":"...","evidence":["..."],"confidence":0.0}',
    ].join('\n');

    try {
        const response = await openai.chat.completions.create({
            model: VISION_MODEL,
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
    sitePatternsText?: string
): Promise<BrowserAction> {
    const historyText = history.length
        ? history
              .slice(-12)
              .map((h) => `  ${h.step}. [${h.result}] ${h.label}: ${h.comment || '-'} (${h.url})${h.error ? ` error=${h.error}` : ''}`)
              .join('\n')
        : '  (нет предыдущих действий)';
    const notesText = notes.length
        ? notes.slice(-12).map((note, index) => `  ${index + 1}. ${note}`).join('\n')
        : '  (нет рабочих заметок)';
    const recentFailures = history.filter((h) => h.result === 'failed').slice(-3);
    const recoveryText = recentFailures.length
        ? recentFailures.map((h) => `  - ${h.label}: ${h.error || h.comment || 'ошибка без текста'}`).join('\n')
        : '  (нет недавних ошибок)';
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
- wait            — подождать загрузки/динамического обновления
- go_back         — вернуться назад
- memory_lookup   — поискать недостающий факт в долговременной памяти (value = точный поисковый запрос)
- note            — сохранить краткую рабочую заметку внутри текущей сессии (summary = факт/решение; без действий на странице)
- ask_user        — остановиться и спросить пользователя, если данных нет или нужен безопасный ручной шаг
- done            — задача выполнена (summary = что сделано)
- fail            — задача невыполнима (summary = причина)

Правила качества:
0. Если задача начинается с about:blank и пользователь не дал конкретный URL, сначала открой поисковик или наиболее вероятный официальный сайт по задаче. Не жди URL от пользователя, если его можно найти обычным поиском.
0a. Если задача содержит "Последняя страница" или контекст предыдущей браузерной задачи, продолжай с этой страницы и выбирай вариант там. Не придумывай новый домен по названию мероприятия, игры, товара или места.
1. Сначала используй "Candidate selectors"; копируй selector ровно как указан после стрелки "->".
   Не используй номер строки вида "#1" как selector. Если нужен именно номер элемента, используй index=1.
   Если selector начинается с "frame=N >>", используй его целиком — это действие внутри iframe/виджета.
   Если есть одинаковые кнопки/ссылки, выбирай по context=... или href=..., а не только по названию кнопки.
1a. Для сложных интерфейсов с карточками, строками таблиц, списками и модалками сначала найди нужный объект по тексту из задачи, затем нажимай кнопку/ссылку внутри этого же ближайшего блока. Если нужный блок не виден, прокрути страницу и повтори поиск. Не спрашивай пользователя выбирать среди одинаковых кнопок, когда целевой текст уже есть на странице, в DOM или в context.
	2. Используй долговременную память для адресов, предпочтений, имён, сохранённых параметров и известных учётных данных.
	3. Если нужного факта нет в текущем контексте памяти, сначала используй memory_lookup с конкретным запросом. Если память не дала ответа или дала неполные данные — ask_user в контексте текущей формы/страницы, без ухода в общий диалог о сохранении фактов.
	3a. Если данные для формы взяты из памяти, можно попросить пользователя подтвердить, что найденные значения актуальны, особенно перед отправкой заявки.
	4. Для пароля/login используй fill_credential, если credentialHint говорит что данные доступны.
5. Captcha, SMS/2FA/OTP, банковские карты, документы, платёж, юридическое согласие и необратимые действия требуют ask_user, если пользователь явно не дал все нужные данные.
5a. Не выдумывай значения для форм: телефон, email, имя, название команды/организации, количество участников, комментарии и контактные данные можно вводить только из сообщения пользователя, долговременной памяти или сохранённых учётных данных. Если данных нет — ask_user до fill и до отправки формы.
6. Если страница просит финальное подтверждение покупки/оплаты/бронирования с деньгами или штрафом — ask_user, даже если задача в целом понятна.
7. done разрешён только когда на странице явно видно, что цель достигнута: подтверждение, созданная запись, отправленная форма, скачанный файл или другая проверяемая фиксация результата.
8. Используй note, когда нашёл важный факт на странице или в памяти: выбранный слот, адрес, цену, ограничение, причину ошибки.
9. Если действие уже повторялось и не помогает — смени стратегию: другой selector, scroll/wait, go_back, memory_lookup или ask_user/fail.
10. ask_user формулируй как один конкретный вопрос: какой именно факт/код/выбор нужен и почему его нельзя взять из памяти. Если на странице есть явный выбор кнопками (например "Да"/"Нет"), добавь поле choices: [{"label":"понятная кнопка для пользователя","answer":"что именно нажать/ввести"}].
10a. Если всё же нужно спросить про одинаковые кнопки, варианты должны различаться контекстом блока/строки/карточки. Не предлагай пользователю несколько одинаковых "Выбрать: Записаться" без названия объекта рядом.
11. Если пользователь просит только найти варианты игр/мероприятий/квизов/билетов, собери ближайшие варианты с датами, местами и ссылками, затем done с предложением выбрать вариант для записи. Не начинай регистрацию, пока пользователь явно не попросил записать/зарегистрировать.
12. Перед каждым click проверь цепочку: цель пользователя -> нужный объект/блок на странице -> действие внутри этого блока. Если можешь назвать только текст кнопки, но не можешь связать её с нужным объектом, не возвращай click: используй scroll, go_back, memory_lookup, note или ask_user.
12a. Если нейро-классификатор ниже говорит phase=confirmation_modal, текущая модалка/попап является локальным контекстом задачи. Для кнопок этой модалки не требуй, чтобы рядом снова был исходный объект/карточка из задачи.
12b. Если phase=success и есть successEvidence, возвращай done с кратким подтверждением результата, не продолжай кликать.
12c. Если lastActionOutcome.sameLoopRisk=true или progress=no_visible_change, не повторяй то же действие: выбери другую стратегию или ask_user.
13. Отвечай ТОЛЬКО JSON, без markdown-блоков.`;

    const userContent = `Задача пользователя:
${redactSecrets(task)}

Текущая дата и время: ${nowText} (Europe/Moscow)
Осталось итераций: ${Math.max(0, MAX_ITERATIONS - history.length)}

Текущая страница:
URL: ${url || 'about:blank'}
Заголовок: ${title || '(нет)'}
Состояние: ${observation.pageState || '(нет данных)'}
Сигналы блокеров/рисков:
${observation.blockerSignals || '(нет явных)'}

Контекст из долговременной памяти:
${buildMemoryPrompt(memoryContext)}

Учётные данные:
${credentialHint}

История действий:
${historyText}

Рабочие заметки:
${notesText}

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

Недавние ошибки и подсказка восстановления:
${recoveryText}
Если здесь есть ошибки локатора, выбери другой selector из Candidate selectors, попробуй index=N, scroll/wait или задай ask_user.

Candidate selectors:
${observation.interactiveText || '(нет явных интерактивных элементов)'}

Структура страницы: карточки, строки, повторяющиеся блоки и действия внутри них:
${observation.structureText || '(структурные блоки не выделены)'}

Affordance graph: смысловые блоки интерфейса, поля и действия внутри них:
${observation.affordanceGraphText || '(affordance graph пуст)'}

Диагностика форм:
${observation.formText || '(формы/ошибки не обнаружены)'}

Модалки и cookie/consent-баннеры:
${observation.modalText || '(модалки/баннеры не обнаружены)'}

Iframe/встроенные виджеты:
${observation.frameText || '(нет важных iframe)'}

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
            const response = await openai.chat.completions.create({
                model: VISION_MODEL,
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
    const bareIndex = trimmed.match(/^#(\d{1,3})$/);
    if (bareIndex) return `index=${bareIndex[1]}`;

    const candidateIndex = trimmed.match(/^(?:candidate\s*)?#(\d{1,3})\b/i);
    if (candidateIndex && !trimmed.includes('->')) return `index=${candidateIndex[1]}`;

    const copiedCandidate = trimmed.match(/->\s*([\s\S]+)$/);
    if (copiedCandidate) return copiedCandidate[1].trim();

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

function buildLocatorsInRoot(root: Page | Frame, selector: string): Locator[] {
    const trimmed = normalizeCandidateSelector(selector);
    if (!trimmed) return [];

    const { core, href } = splitCandidateSelectorMetadata(trimmed);
    const roleMatch = core.match(/^role=([a-zA-Z0-9_-]+)\[name=(?:"([^"]*)"|'([^']*)'|([^\]]+))\]$/);
    if (roleMatch) {
        const name = unescapeSelectorValue(roleMatch[2] || roleMatch[3] || roleMatch[4] || '');
        return [
            ...hrefLocatorsInRoot(root, href, name),
            (root as any).getByRole(roleMatch[1] as any, { name, exact: false }),
        ];
    }

    const hrefOnlyLocators = hrefLocatorsInRoot(root, href);
    if (hrefOnlyLocators.length && (!core || core === trimmed)) return hrefOnlyLocators;

    const indexMatch = core.match(/^index=(\d+)$/);
    if (indexMatch) {
        const index = Math.max(0, Number(indexMatch[1]) - 1);
        return [(root as any).locator(VISIBLE_INTERACTIVE_ELEMENT_SELECTOR).nth(index)];
    }

    const prefixes: Array<[RegExp, (value: string) => Locator]> = [
        [/^css=([\s\S]+)$/, (value) => (root as any).locator(value)],
        [/^text=([\s\S]+)$/, (value) => (root as any).getByText(value, { exact: false })],
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

async function describeActionTarget(page: Page, decision: BrowserAction): Promise<Record<string, unknown>> {
    const selector = actionTargetSelector(decision);
    if (!selector || !['click', 'fill', 'fill_credential', 'select_option', 'check', 'uncheck', 'hover'].includes(decision.action)) {
        return { action: decision.action };
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

async function doAction(page: Page, decision: BrowserAction, credentials: CredentialMaterial | null): Promise<void> {
    const sel = decision.selector ?? '';
    const val = decision.value ?? '';
    const targetSelector = actionTargetSelector(decision);

    switch (decision.action) {
        case 'navigate': {
            const url = val.startsWith('http') ? val : `https://${val}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            break;
        }
        case 'click': {
            const beforeUrl = page.url();
            const hrefFallback = hrefFromCandidateSelector(targetSelector, beforeUrl);
            await tryLocators(page, targetSelector, async (locator) => {
                try {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS });
                } catch (err) {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS, force: true });
                }
            });
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            const afterUrl = page.url();
            if (hrefFallback && !urlsEquivalent(hrefFallback, beforeUrl) && urlsEquivalent(afterUrl, beforeUrl)) {
                browserLog('click_href_fallback', {
                    beforeUrl: safeLogUrl(beforeUrl),
                    href: safeLogUrl(hrefFallback),
                    selector: targetSelector.slice(0, 180),
                });
                await page.goto(hrefFallback, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            }
            break;
        }
        case 'fill': {
            await tryLocators(page, sel, async (locator) => {
                try {
                    await locator.fill(val, { timeout: ACTION_TIMEOUT_MS });
                } catch {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS });
                    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
                    await page.keyboard.type(val, { delay: 20 });
                }
            });
            break;
        }
        case 'fill_credential': {
            const secretValue = credentialValue(credentials, val);
            if (!secretValue) throw new Error(`Нет сохранённого значения для ${val || 'credential'}`);
            await tryLocators(page, sel, async (locator) => {
                try {
                    await locator.fill(secretValue, { timeout: ACTION_TIMEOUT_MS });
                } catch {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS });
                    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
                    await page.keyboard.type(secretValue, { delay: 20 });
                }
            });
            break;
        }
        case 'type': {
            await page.keyboard.type(val, { delay: 35 });
            break;
        }
        case 'press_key': {
            await page.keyboard.press(val || 'Enter');
            await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
            break;
        }
        case 'select_option': {
            await tryLocators(page, sel, async (locator) => {
                try {
                    await locator.selectOption(val, { timeout: ACTION_TIMEOUT_MS });
                } catch {
                    await locator.selectOption({ label: val }, { timeout: ACTION_TIMEOUT_MS });
                }
            });
            break;
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
            await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
            await page.waitForTimeout(700);
            break;
        }
        case 'go_back': {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS }).catch(() => {});
            break;
        }
    }
}

async function createBrowserRun(
    ctx: BotContext,
    userId: number,
    originalTask: string,
    memoryContext?: string,
    recentUserContext?: string
): Promise<BrowserRunState> {
    const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    const browser = await chromium.launch({
        headless: true,
        executablePath: chromiumExecutablePath || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const browserCtx = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        permissions: [],
        acceptDownloads: true,
    });
    browserCtx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    browserCtx.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const page = await browserCtx.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

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
        downloads: [],
        lastComment: '',
        lastUserAnswer: '',
        lastScreenshotDomain: '',
        lastCredentialDomain: '',
        sessionSavedForDomain: '',
        followUpOriginDomain: '',
        iterationCount: 0,
        consecutiveActionFailures: 0,
        highImpactConfirmed: false,
        lastUnderstandingUrl: '',
        lastUnderstandingIteration: -1,
        pendingBookingMemorySnapshot: undefined,
        confirmedBookingMemorySnapshot: undefined,
        rejectedBookingMemorySnapshots: [],
        cancelRequested: false,
        cancelAcknowledged: false,
        expiresAt: Date.now() + PENDING_BROWSER_TTL_MS,
    };
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

    return null;
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
        await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        try {
            await element.click({ timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            const box = await element.boundingBox().catch(() => null);
            if (!box) throw err;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
    } finally {
        await handle.dispose();
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function getVisualClickCandidates(page: Page): Promise<VisualClickCandidate[]> {
    return page.evaluate(() => {
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
        const roleOf = (el: Element) => {
            const explicitRole = compact(el.getAttribute('role'));
            if (explicitRole) return explicitRole;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'input') return ((el as HTMLInputElement).type || 'input').toLowerCase();
            return tag;
        };
        const buttonTexts = (root: Element) =>
            Array.from(root.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
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
        const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'))
            .filter((el) => isVisible(el) && textOf(el));

        return controls
            .map((el, controlIndex) => {
                const rect = el.getBoundingClientRect();
                const label = textOf(el);
                const role = roleOf(el);
                const { context, modalLike, zIndex, position } = contextFor(el);
                const normalizedLabel = normalize(label);
                const area = Math.round(rect.width * rect.height);
                let score = 0;
                if (modalLike) score += 80;
                if (/^(да|нет|ok|ок|yes|no|подтвердить|отмена|cancel|continue|продолжить)$/iu.test(normalizedLabel)) score += 36;
                if (/(запис|регист|брон|отправ|подтверд|продолж|submit|send|confirm|book|reserve|register|yes|no)/iu.test(normalizedLabel)) score += 24;
                if (zIndex >= 10) score += 18;
                if (position === 'fixed') score += 16;
                if (position === 'absolute') score += 8;
                if (rect.top >= -10 && rect.left >= -10 && rect.top < window.innerHeight && rect.left < window.innerWidth) score += 12;
                if (label.length > 120) score -= 26;
                if (area > window.innerWidth * window.innerHeight * 0.25) score -= 30;

                return {
                    controlIndex,
                    label: label.slice(0, 160),
                    role,
                    bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
                    center: `${Math.round(rect.x + rect.width / 2)},${Math.round(rect.y + rect.height / 2)}`,
                    context: context.slice(0, 700),
                    position,
                    zIndex,
                    modalLike,
                    score,
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 48);
    });
}

function rankVisualClickCandidates(candidates: VisualClickCandidate[], clickLabel: string): VisualClickCandidate[] {
    const normalizedClick = normalizeSearchText(clickLabel);
    return candidates
        .map((candidate) => {
            const normalizedLabel = normalizeSearchText(candidate.label);
            let score = candidate.score;
            if (normalizedClick && normalizedLabel === normalizedClick) score += 140;
            else if (normalizedClick && (normalizedLabel.includes(normalizedClick) || normalizedClick.includes(normalizedLabel))) score += 70;
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
        },
        candidates: candidates.map((candidate, index) => ({
            index,
            label: candidate.label,
            role: candidate.role,
            bbox: candidate.bbox,
            center: candidate.center,
            modalLike: candidate.modalLike,
            position: candidate.position,
            zIndex: candidate.zIndex,
            context: redactSecrets(candidate.context).slice(0, 650),
        })),
    };

    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await openai.chat.completions.create({
                model: VISION_MODEL,
                max_tokens: 300,
                temperature: 0,
                messages: [
                    {
                        role: 'system',
                        content: [
                            'Ты visual layout resolver для браузерного агента.',
                            'Детерминированный DOM guard заблокировал click, потому что не смог связать элемент с целевым блоком.',
                            'Твоя задача: по скриншоту и списку видимых элементов выбрать candidate.index, если нужный элемент очевиден визуально.',
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
        await clickVisibleControlByIndex(page, choice.candidate.controlIndex);
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
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            max_tokens: 240,
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

                return {
                    status: 'ambiguous',
                    question: `Нашла несколько блоков для действия «${intent.description}». Какой выбрать?`,
                    choices: choicesFromTaskScopedCandidates(candidates),
                };
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

    const hints = extractContextualClickHints(task, decision, clickLabel);
    browserLog('target_block_probe', { clickLabel, hints: hints.join(', ') });
    if (!hints.some((hint) => !isRussianDateHint(hint))) {
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
                return {
                    status: 'ambiguous',
                    question: `Нашла несколько блоков с нужным текстом и кнопкой «${clickLabel}». Какой выбрать?`,
                    choices: choicesFromContextualCandidates(candidates),
                };
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
        await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        try {
            await element.click({ timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            const box = await element.boundingBox().catch(() => null);
            if (!box) throw err;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
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

async function maybeUseContextualClick(
    page: Page,
    task: string,
    decision: BrowserAction
): Promise<ContextualClickResult> {
    const clickLabel = clickLabelFromDecision(decision);
    if (!clickLabel) return { status: 'none', reason: 'click_label_not_found' };

    const hints = extractContextualClickHints(task, decision, clickLabel);
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
            return {
                status: 'ambiguous',
                question: `На странице несколько элементов «${clickLabel}», и я не хочу нажимать первый наугад. Какой блок выбрать?`,
                choices: choicesFromContextualCandidates(candidates.filter((candidate) => candidate.score > 0)),
            };
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
        .filter((hint) => !isRussianDateHint(hint));
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
    return (navHits >= 4 || (buttons.length >= 3 && navButtons >= Math.min(buttons.length, 4))) &&
        !modalBlockHasDecisionIntent(question, buttons);
}

function isActionableModalButtonBlock(question: string, buttons: string[]): boolean {
    if (!buttons.length) return false;
    if (looksLikeNavigationOnlyModalBlock(question, buttons)) return false;
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
        await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        try {
            await element.click({ timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            const box = await element.boundingBox().catch(() => null);
            if (!box) throw err;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
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

function detectedSuccessSummary(state: BrowserRunState): string | null {
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
        return `Задача выглядит выполненной: ${understanding.whatIsHappening}. ${evidence}`.slice(0, 700);
    }

    const outcome = state.lastActionOutcome;
    if (
        outcome &&
        outcome.confidence >= 0.76 &&
        /(success|submitted|form_submitted|booking_created|reservation_created|заявк[ауы]?\s+отправ|брон[ьи]?\s+создан|успеш|готов)/iu.test(outcome.progress)
    ) {
        return `Задача выглядит выполненной после последнего действия: ${outcome.progress}. ${outcome.evidence.join(' ')}`.slice(0, 700);
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

export async function browserAgent(
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
                        await state.page.goto(continuation.previousUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: NAVIGATION_TIMEOUT_MS,
                        });
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

        for (let i = state.iterationCount; i < MAX_ITERATIONS; i++) {
            if (state.cancelRequested) {
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.activeBrowserTask = undefined;
                return { responseText: 'Ок, браузерную задачу остановила.' };
            }

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
                interactiveCount: countSnapshotRows(observation.interactiveText, /^\s*#\d+/gmu),
                blockCount: countSnapshotRows(observation.structureText, /^\s*block#\d+/gmu),
                affordanceNodes: countSnapshotRows(observation.affordanceGraphText, /^\s*node#\d+/gmu),
                formLines: countSnapshotRows(observation.formText, /^\s*field#\d+/gmu),
                bookingFormVisible,
                blockers: cleanWhitespace(observation.blockerSignals || '').slice(0, 180),
            });

            await maybeUpdatePageUnderstanding(state, taskForLlm, observation, url, i + 1, sitePatternsText);
            const autoSuccessSummary = detectedSuccessSummary(state);
            if (autoSuccessSummary) {
                await sendScreenshot(ctx, page, `✅ Готово: ${autoSuccessSummary.slice(0, 200)}`);
                if (domain) {
                    await BrowserSessionStore.save(state.browserCtx, state.userId, domain).catch(() => {});
                    state.sessionSavedForDomain = domain;
                    rememberSuccessfulSitePattern(domain, state, observation, autoSuccessSummary);
                }
                const sentDownloads = await sendDownloadedFiles(ctx, state);
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.lastBrowserTask = {
                    originalTask: state.originalTask,
                    summary: autoSuccessSummary,
                    url: state.page.url(),
                    title,
                    notes: state.notes.slice(-12),
                    pageText: observation.pageText ? observation.pageText.slice(0, 2000) : undefined,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + LAST_BROWSER_TASK_TTL_MS,
                };
                const downloadsLine = sentDownloads.length ? `\n\nФайлы: ${sentDownloads.join(', ')}` : '';
                return { responseText: `✅ Готово!\n\n${autoSuccessSummary}${downloadsLine}` };
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

            const decision = await askNextAction(
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
                sitePatternsText
            );
            devLog('browserAgent decision:', sanitizeDecisionForLog(decision));
            console.log(formatDecisionForLog(decision));

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
                    pauseBrowserRun(ctx, state, rawClickGuard.question, undefined, rawClickGuard.choices);
                    shouldClose = false;
                    await sendScreenshot(ctx, page, `❓ Нужно выбрать блок: ${rawClickGuard.question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(rawClickGuard.question, rawClickGuard.choices, 'clarification'),
                        keyboard: buildBrowserPauseKeyboard(state.id, rawClickGuard.choices),
                    };
                }

                const repeatedBlockedClickCount = state.history
                    .slice(-8)
                    .filter((record) => record.label === blockedClickLabel && record.error === 'contextless_click_blocked')
                    .length;
                if (repeatedBlockedClickCount >= 2) {
                    const question = [
                        'Я дважды заблокировала один и тот же общий клик и vision-проверка не дала уверенного выбора.',
                        'Нужен ручной ориентир: какую видимую кнопку/область нажать дальше?',
                    ].join(' ');
                    pauseBrowserRun(ctx, state, question);
                    shouldClose = false;
                    await sendScreenshot(ctx, page, `❓ Нужен ручной ориентир: ${question.slice(0, 180)}`);
                    return {
                        responseText: formatBrowserPauseResponse(question, [], 'manual_step'),
                        keyboard: buildBrowserPauseKeyboard(state.id),
                    };
                }

                await sendProgress(ctx, '🌐 Не нажимаю общий элемент без привязки к целевому блоку; меняю стратегию.');
                await page.waitForTimeout(200);
                continue;
            }
            if (rawClickGuard.status === 'failed') {
                state.notes.push(`Проверка контекста клика не сработала: ${rawClickGuard.reason}`);
            }
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

                const question = 'Страница не даёт прогресса после повторяющегося действия. Я сохранила браузерную сессию: можно уточнить, что выбрать на текущей странице, или написать «продолжай», чтобы попробовать другую стратегию.';
                pauseBrowserRun(ctx, state, question);
                shouldClose = false;
                await sendScreenshot(ctx, page, '❓ Страница не даёт прогресса после повторяющегося действия.');
                return {
                    responseText: formatBrowserPauseResponse(question, [], 'manual_step'),
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
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
                await sendScreenshot(ctx, page, `✅ Готово: ${decision.summary?.slice(0, 200) ?? ''}`);
                if (domain && domain !== state.sessionSavedForDomain) {
                    await BrowserSessionStore.save(state.browserCtx, state.userId, domain);
                    state.sessionSavedForDomain = domain;
                }
                if (domain) {
                    rememberSuccessfulSitePattern(domain, state, observation, decision.summary);
                }
                const sentDownloads = await sendDownloadedFiles(ctx, state);
                ctx.session.pendingBrowserTask = undefined;
                ctx.session.lastBrowserTask = {
                    originalTask: state.originalTask,
                    summary: decision.summary ?? 'Задача выполнена.',
                    url: state.page.url(),
                    title,
                    notes: state.notes.slice(-12),
                    pageText: observation.pageText ? observation.pageText.slice(0, 2000) : undefined,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + LAST_BROWSER_TASK_TTL_MS,
                };
                const downloadsLine = sentDownloads.length ? `\n\nФайлы: ${sentDownloads.join(', ')}` : '';
                return { responseText: `✅ Готово!\n\n${decision.summary ?? 'Задача выполнена.'}${downloadsLine}` };
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

            if (decision.action === 'note') {
                const note = (decision.summary || decision.comment || decision.value || '').trim();
                if (note) {
                    state.notes.push(redactSecrets(note).slice(0, 500));
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
                continue;
            }

            if (decision.action === 'ask_user') {
                const { question, choices } = buildBrowserPausePrompt(decision, observation, taskForLlm);
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
                    await sendProgress(ctx, '🌐 Этот клик ведёт в корзину/логин, а не к фильтру или товару; ищу правильный элемент на странице.');
                    await page.waitForTimeout(200);
                    continue;
                }
                await doAction(page, decision, state.activeCredentials);
                await adoptLatestPage(state);
                state.consecutiveActionFailures = 0;
            } catch (err: any) {
                    result = 'failed';
                    error = safeErrorMessage(err);
                    state.consecutiveActionFailures += 1;
                    console.warn(`[BROWSER] action "${decision.action}" failed:`, error);
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
                        if (outcome.progress && outcome.progress !== 'unknown') {
                            state.notes.push(`Результат последнего действия: ${outcome.progress}. ${outcome.evidence.join(' ')}`.slice(0, 500));
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
                comment: decision.comment ?? '',
                result,
                error,
            });

            if (state.consecutiveActionFailures >= MAX_CONSECUTIVE_ACTION_FAILURES) {
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

        ctx.session.pendingBrowserTask = undefined;
        return {
            responseText: '⏰ Достигнут лимит итераций. Задача не завершена — попробуй уточнить запрос.',
        };
    } catch (err: any) {
        if (state?.cancelRequested) {
            ctx.session.pendingBrowserTask = undefined;
            ctx.session.activeBrowserTask = undefined;
            return { responseText: 'Ок, браузерную задачу остановила.' };
        }
        console.error('[BROWSER] fatal error:', err);
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
