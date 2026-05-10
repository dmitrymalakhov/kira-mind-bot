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
}

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
    iterationCount: number;
    consecutiveActionFailures: number;
    highImpactConfirmed: boolean;
    expiresAt: number;
    timeout?: NodeJS.Timeout;
}

const pausedBrowserSessions = new Map<string, BrowserRunState>();
const observedPages = new WeakSet<Page>();

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
                const alt = el.alt.length ? ` alt: ${el.alt.join(' | ')}` : '';
                return `  #${el.index} ${el.role}${type}${label}${flags}${href} -> ${el.selector}${alt}`;
            });
        return limitText(lines.join('\n'), 7000);
    } catch (e) {
        devLog('browserAgent: interactive snapshot failed:', e);
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
        const modals = await page.$$eval(
            [
                '[role="dialog"]',
                '[aria-modal="true"]',
                'dialog',
                '.modal',
                '.popup',
                '.overlay',
                '[class*="cookie" i]',
                '[id*="cookie" i]',
                '[class*="consent" i]',
                '[id*="consent" i]',
            ].join(','),
            (nodes) => {
                const compact = (value: string | null | undefined) =>
                    String(value ?? '').replace(/\s+/g, ' ').trim();
                const isVisible = (el: Element) => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const buttonTexts = (root: Element) =>
                    Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))
                        .filter(isVisible)
                        .map((el) => {
                            const input = el as HTMLInputElement;
                            return compact((el as HTMLElement).innerText || el.textContent || input.value || el.getAttribute('aria-label'));
                        })
                        .filter(Boolean)
                        .slice(0, 10);

                return nodes
                    .filter((el, index, arr) => arr.indexOf(el) === index && isVisible(el))
                    .slice(0, 8)
                    .map((el, index) => ({
                        index: index + 1,
                        role: el.getAttribute('role') || el.tagName.toLowerCase(),
                        label: compact(el.getAttribute('aria-label') || el.getAttribute('id') || el.className?.toString()),
                        text: compact((el as HTMLElement).innerText || el.textContent).slice(0, 500),
                        buttons: buttonTexts(el),
                    }))
                    .filter((modal) => modal.text || modal.buttons.length);
            }
        );

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
    const [screenshotBuf, pageState, a11yText, interactiveText, formText, modalText, frameText, pageText, selectOptions] = await Promise.all([
        takeJpeg(page),
        getPageStateText(page),
        getAccessibilityText(page),
        getInteractiveElementsText(page),
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
        formText,
        modalText,
        frameText,
        pageText,
        selectOptions,
        runtimeSignals: limitText(pageEvents.slice(-12).join('\n'), 2500),
    };
}

// ─── Скриншоты ────────────────────────────────────────────────────────────────

async function takeJpeg(page: Page): Promise<Buffer> {
    return page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
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

function safeFileName(filename: string): string {
    const base = path.basename(filename || 'download.bin').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/g, '_').slice(0, 120);
    return base || 'download.bin';
}

function safeErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    return redactSecrets(raw).slice(0, 240);
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

function shouldStopRepeatedAction(history: ActionRecord[], decision: BrowserAction): boolean {
    const signature = actionSignature(decision);
    return history.slice(-6).filter((h) => h.label === signature).length >= 3;
}

function isHighImpactAction(decision: BrowserAction): boolean {
    if (decision.action !== 'click' && decision.action !== 'press_key') return false;
    const text = [
        decision.selector,
        decision.value,
        decision.comment,
        decision.summary,
    ].filter(Boolean).join(' ');
    return /(оплат|плат[её]ж|заплат|купить|покупк|оформить\s+заказ|заказать|checkout|payment|pay\b|purchase|buy\b|confirm|подтверд|забронировать|бронь|reserve|book\b|submit\s+order)/i.test(text);
}

function isExplicitUserConfirmation(text: string): boolean {
    return /^(да|ок|okay|yes|подтверждаю|можно|согласен|согласна|продолжай|делай|нажимай|оплати|бронируй)\b/i.test(text.trim());
}

function highImpactQuestion(decision: BrowserAction): string {
    const target = decision.selector || decision.comment || 'финальное действие';
    return `Подтверди, что можно выполнить потенциально необратимое действие: ${target}. Ответь «да, подтверждаю», если действительно продолжаем.`;
}

function valueFromLatestUserAnswer(state: BrowserRunState, value?: string): boolean {
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedValue || normalizedValue.length < 2) return false;
    return state.lastUserAnswer.toLowerCase().includes(normalizedValue.toLowerCase());
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
    const match = message.match(/Ответ пользователя:\s*([\s\S]*?)(?:\nИспользуй ответ|\n$|$)/);
    return match?.[1]?.trim();
}

interface ParsedBrowserContinuation {
    sessionId?: string;
    originalTask?: string;
    question?: string;
    answer?: string;
}

function parseBrowserContinuationMessage(message: string): ParsedBrowserContinuation | null {
    if (!BROWSER_CONTINUATION_RE.test(message)) return null;
    const sessionId = browserTaskSessionFromMessage(message);
    const originalTask = message.match(/Исходная задача пользователя:\s*([\s\S]*?)(?:\nВопрос агента пользователю:|\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const question = message.match(/Вопрос агента пользователю:\s*([\s\S]*?)(?:\nОтвет пользователя:|\nИспользуй ответ|$)/)?.[1]?.trim();
    const answer = browserTaskAnswerFromMessage(message);
    return { sessionId, originalTask, question, answer };
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

function buildBrowserPauseKeyboard(sessionId: string): InlineKeyboard {
    return new InlineKeyboard().text('Отменить браузерную задачу', `browser_cancel:${sessionId}`);
}

function pauseBrowserRun(ctx: BotContext, state: BrowserRunState, question: string, risk?: 'high_impact'): void {
    state.expiresAt = Date.now() + PENDING_BROWSER_TTL_MS;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
        closeBrowserRunState(state, 'expired').catch(() => {});
    }, PENDING_BROWSER_TTL_MS);
    pausedBrowserSessions.set(state.id, state);
    ctx.session.pendingBrowserTask = {
        originalTask: state.originalTask,
        question,
        sessionId: state.id,
        risk,
        createdAt: Date.now(),
        expiresAt: state.expiresAt,
    };
}

function resumeBrowserRun(ctx: BotContext, state: BrowserRunState): void {
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = undefined;
    pausedBrowserSessions.delete(state.id);
    ctx.session.pendingBrowserTask = undefined;
}

async function closeBrowserRunState(state: BrowserRunState, reason: 'done' | 'failed' | 'expired' | 'cancelled'): Promise<void> {
    if (state.timeout) clearTimeout(state.timeout);
    pausedBrowserSessions.delete(state.id);

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
        return;
    }

    await Promise.all([...pausedBrowserSessions.values()].map((state) => closeBrowserRunState(state, 'cancelled')));
}

function buildMemoryPrompt(memoryContext?: string): string {
    if (!memoryContext?.trim()) return '(нет релевантного контекста)';
    return limitText(redactSecrets(memoryContext.trim()), 4500);
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

// ─── LLM-решение ─────────────────────────────────────────────────────────────

async function askNextAction(
    task: string,
    url: string,
    title: string,
    observation: PageObservation,
    history: ActionRecord[],
    notes: string[],
    credentialHint: string,
    memoryContext?: string
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
1. Сначала используй "Candidate selectors"; копируй selector ровно как указан.
   Если selector начинается с "frame=N >>", используй его целиком — это действие внутри iframe/виджета.
2. Используй долговременную память для адресов, предпочтений, имён, сохранённых параметров и известных учётных данных.
3. Если нужного факта нет в текущем контексте памяти, сначала используй memory_lookup с конкретным запросом. Только если память не дала ответа — ask_user.
4. Для пароля/login используй fill_credential, если credentialHint говорит что данные доступны.
5. Captcha, SMS/2FA/OTP, банковские карты, документы, платёж, юридическое согласие и необратимые действия требуют ask_user, если пользователь явно не дал все нужные данные.
6. Если страница просит финальное подтверждение покупки/оплаты/бронирования с деньгами или штрафом — ask_user, даже если задача в целом понятна.
7. done разрешён только когда на странице явно видно, что цель достигнута: подтверждение, созданная запись, отправленная форма, скачанный файл или другая проверяемая фиксация результата.
8. Используй note, когда нашёл важный факт на странице или в памяти: выбранный слот, адрес, цену, ограничение, причину ошибки.
9. Если действие уже повторялось и не помогает — смени стратегию: другой selector, scroll/wait, go_back, memory_lookup или ask_user/fail.
10. ask_user формулируй как один конкретный вопрос: какой именно факт/код/выбор нужен и почему его нельзя взять из памяти.
11. Отвечай ТОЛЬКО JSON, без markdown-блоков.`;

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

Недавние ошибки и подсказка восстановления:
${recoveryText}
Если здесь есть ошибки локатора, выбери другой selector из Candidate selectors, попробуй index=N, scroll/wait или задай ask_user.

Candidate selectors:
${observation.interactiveText || '(нет явных интерактивных элементов)'}

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
        const parsed = parseLLMJson<BrowserAction>(text);
        if (parsed?.action) return parsed;
        devLog('browserAgent: unparseable LLM response:', redactSecrets(text));
        return { action: 'fail', summary: 'Не удалось распознать ответ от LLM.' };
    } catch (err: any) {
        console.error('[BROWSER] askNextAction error:', err?.message ?? err);
        return { action: 'fail', summary: `Ошибка LLM: ${safeErrorMessage(err) || 'неизвестно'}` };
    }
}

// ─── Выполнение действия ──────────────────────────────────────────────────────

function unescapeSelectorValue(value: string): string {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
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

function buildLocatorsInRoot(root: Page | Frame, selector: string): Locator[] {
    const trimmed = selector.trim();
    if (!trimmed) return [];

    const roleMatch = trimmed.match(/^role=([a-zA-Z0-9_-]+)\[name="([\s\S]*)"\]$/);
    if (roleMatch) {
        return [(root as any).getByRole(roleMatch[1] as any, { name: unescapeSelectorValue(roleMatch[2]), exact: false })];
    }

    const indexMatch = trimmed.match(/^index=(\d+)$/);
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
        const match = trimmed.match(pattern);
        if (match) return [factory(unescapeSelectorValue(match[1]))];
    }

    const semanticLocators = [
        (root as any).getByRole('button', { name: trimmed, exact: false }),
        (root as any).getByRole('link', { name: trimmed, exact: false }),
        (root as any).getByLabel(trimmed, { exact: false }),
        (root as any).getByPlaceholder(trimmed, { exact: false }),
        (root as any).getByText(trimmed, { exact: false }),
    ];
    const looksLikeCss = /^[.#\[]/.test(trimmed) || /[>+~:]/.test(trimmed) || /^(a|button|input|textarea|select|form|div|span)\b/i.test(trimmed);
    return looksLikeCss ? [(root as any).locator(trimmed), ...semanticLocators] : [...semanticLocators, (root as any).locator(trimmed)];
}

function buildLocators(page: Page, selector: string): Locator[] {
    const trimmed = selector.trim();
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
            const first = locator.first();
            await first.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            return await action(first);
        } catch (e) {
            lastError = e;
        }
    }

    throw lastError ?? new Error(`Не найден элемент: ${selector}`);
}

async function doAction(page: Page, decision: BrowserAction, credentials: CredentialMaterial | null): Promise<void> {
    const sel = decision.selector ?? '';
    const val = decision.value ?? '';

    switch (decision.action) {
        case 'navigate': {
            const url = val.startsWith('http') ? val : `https://${val}`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            break;
        }
        case 'click': {
            await tryLocators(page, sel, async (locator) => {
                try {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS });
                } catch (err) {
                    await locator.click({ timeout: ACTION_TIMEOUT_MS, force: true });
                }
            });
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
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
            await tryLocators(page, sel, (locator) => locator.hover({ timeout: ACTION_TIMEOUT_MS }));
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
    memoryContext?: string
): Promise<BrowserRunState> {
    const browser = await chromium.launch({ headless: true });
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
        iterationCount: 0,
        consecutiveActionFailures: 0,
        highImpactConfirmed: false,
        expiresAt: Date.now() + PENDING_BROWSER_TTL_MS,
    };
    attachPageObservers(state);
    return state;
}

function buildResumedTask(state: BrowserRunState, message: string, answer?: string): string {
    const userAnswer = answer || browserTaskAnswerFromMessage(message) || message;
    return [
        state.originalTask,
        '',
        'Уточнение пользователя для продолжения браузерной задачи:',
        userAnswer || '(ответ не распознан)',
    ].join('\n');
}

// ─── Главный агент ────────────────────────────────────────────────────────────

export async function browserAgent(
    ctx: BotContext,
    message: string,
    _isForwarded: boolean = false,
    _forwardFrom: string = '',
    _messageHistory: MessageHistory[] = [],
    _classification?: MessageClassification,
    injectedMemoryContext?: string
): Promise<ProcessingResult> {
    const userId = ctx.from?.id ?? 0;
    let state: BrowserRunState | undefined;
    let shouldClose = true;
    let taskForLlm = message;
    let memoryForLlm = injectedMemoryContext;

    try {
        state = getPausedBrowserSession(ctx, message);
        const continuation = parseBrowserContinuationMessage(message);
        if (state) {
            const pendingBrowserTask = ctx.session.pendingBrowserTask;
            const answer = pendingBrowserTask?.userAnswer || continuation?.answer || browserTaskAnswerFromMessage(message) || message;
            state.lastUserAnswer = answer;
            if (pendingBrowserTask?.risk === 'high_impact' && isExplicitUserConfirmation(answer)) {
                state.highImpactConfirmed = true;
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
                [state.memoryContext, injectedMemoryContext].filter(Boolean).join('\n\n') || undefined
            );
            state.memoryContext = memoryForLlm;
            state.credentialCandidates.push(...extractCredentialCandidatesFromText(memoryForLlm, 'memory'));
            await sendProgress(ctx, '🌐 Продолжаю браузерную задачу с того же места…');
        } else {
            if (continuation?.originalTask) {
                taskForLlm = [
                    continuation.originalTask,
                    '',
                    'Предыдущая live-сессия браузера недоступна, поэтому восстанови задачу с начала, используя ответ пользователя:',
                    continuation.answer || '(ответ не распознан)',
                    continuation.question ? `Вопрос, на который отвечал пользователь: ${continuation.question}` : '',
                ].filter(Boolean).join('\n');
                await sendProgress(ctx, '🌐 Восстанавливаю браузерную задачу с начала и использую твой ответ…');
                memoryForLlm = await enrichBrowserMemoryContext(ctx, taskForLlm, injectedMemoryContext);
                state = await createBrowserRun(ctx, userId, continuation.originalTask, memoryForLlm);
                state.lastUserAnswer = continuation.answer || '';
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
                memoryForLlm = await enrichBrowserMemoryContext(ctx, message, injectedMemoryContext);
                state = await createBrowserRun(ctx, userId, message, memoryForLlm);
            }
        }

        for (let i = state.iterationCount; i < MAX_ITERATIONS; i++) {
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
            const observation = await getPageObservation(page, state.pageEvents);
            const title = await page.title().catch(() => '');

            console.log(`[BROWSER] iter ${i + 1}/${MAX_ITERATIONS} | ${url}`);

            const shouldSendScreenshot =
                (domain && domain !== state.lastScreenshotDomain && url !== 'about:blank') ||
                (i > 0 && i % SCREENSHOT_INTERVAL === 0);

            if (shouldSendScreenshot) {
                await sendScreenshot(ctx, page, `🌐 ${title || url}`);
                state.lastScreenshotDomain = domain;
            }

            const decision = await askNextAction(
                taskForLlm,
                url,
                title,
                observation,
                state.history,
                state.notes,
                getCredentialHint(state.activeCredentials, domain),
                memoryForLlm
            );
            devLog('browserAgent decision:', sanitizeDecisionForLog(decision));
            console.log(`[BROWSER] action: ${decision.action} | ${redactSecrets(decision.comment ?? '')}`);

            if (shouldStopRepeatedAction(state.history, decision)) {
                await sendScreenshot(ctx, page, '❌ Похоже, страница не реагирует на повторяющееся действие.');
                return {
                    responseText: '❌ Я остановилась: одно и то же действие повторилось несколько раз без прогресса. Нужна более точная инструкция или ручной шаг на сайте.',
                };
            }

            if (decision.action === 'done') {
                await sendScreenshot(ctx, page, `✅ Готово: ${decision.summary?.slice(0, 200) ?? ''}`);
                if (domain && domain !== state.sessionSavedForDomain) {
                    await BrowserSessionStore.save(state.browserCtx, state.userId, domain);
                    state.sessionSavedForDomain = domain;
                }
                const sentDownloads = await sendDownloadedFiles(ctx, state);
                ctx.session.pendingBrowserTask = undefined;
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
                        responseText:
                            `Нужно уточнение, чтобы продолжить в браузере:\n\n${question}\n\n` +
                            'Ответь следующим сообщением. Если хочешь отменить задачу, напиши «отмена».',
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
                const question = decision.summary || decision.comment || 'Нужно уточнение, чтобы продолжить.';
                pauseBrowserRun(ctx, state, question);
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно уточнение: ${question.slice(0, 180)}`);
                return {
                    responseText:
                        `Нужно уточнение, чтобы продолжить в браузере:\n\n${question}\n\n` +
                        'Ответь следующим сообщением. Если хочешь отменить задачу, напиши «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            const safetyQuestion = safetyQuestionForDecision(decision, state, observation);
            if (safetyQuestion) {
                pauseBrowserRun(ctx, state, safetyQuestion);
                shouldClose = false;
                state.history.push({
                    step: i + 1,
                    label: `safety_pause ${actionSignature(decision)}`,
                    url,
                    comment: safetyQuestion,
                    result: 'failed',
                    error: 'sensitive_or_blocked_step_requires_user',
                });
                await sendScreenshot(ctx, page, `❓ Нужен ручной шаг: ${safetyQuestion.slice(0, 180)}`);
                return {
                    responseText:
                        `Нужен ручной шаг, чтобы продолжить в браузере:\n\n${safetyQuestion}\n\n` +
                        'Ответь следующим сообщением. Если хочешь отменить задачу, напиши «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            if (isHighImpactAction(decision) && !state.highImpactConfirmed) {
                const question = highImpactQuestion(decision);
                pauseBrowserRun(ctx, state, question, 'high_impact');
                shouldClose = false;
                await sendScreenshot(ctx, page, `❓ Нужно подтверждение: ${question.slice(0, 180)}`);
                return {
                    responseText:
                        `Перед финальным действием нужно подтверждение:\n\n${question}\n\n` +
                        'Ответь «да, подтверждаю» или «отмена».',
                    keyboard: buildBrowserPauseKeyboard(state.id),
                };
            }

            if (decision.comment && decision.comment !== state.lastComment) {
                await sendProgress(ctx, `🌐 ${decision.comment}`);
                state.lastComment = decision.comment;
            }

            const highImpactAction = isHighImpactAction(decision);
            const label = actionSignature(decision);
            let result: ActionRecord['result'] = 'ok';
            let error: string | undefined;

            try {
                await doAction(page, decision, state.activeCredentials);
                await adoptLatestPage(state);
                state.consecutiveActionFailures = 0;
            } catch (err: any) {
                    result = 'failed';
                    error = safeErrorMessage(err);
                    state.consecutiveActionFailures += 1;
                    console.warn(`[BROWSER] action "${decision.action}" failed:`, error);
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
        console.error('[BROWSER] fatal error:', err);
        ctx.session.pendingBrowserTask = undefined;
        return { responseText: `❌ Ошибка браузера: ${safeErrorMessage(err) || 'неизвестная ошибка'}` };
    } finally {
        if (state && shouldClose) {
            await closeBrowserRunState(state, 'done').catch(() => {});
        }
    }
}
