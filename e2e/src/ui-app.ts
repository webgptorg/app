/*
 * Small helpers the UI flows share: reading the engine API from inside the signed-in page (as the app itself does, so
 * the specs need no API client of their own) and finding things on screen by their accessible names.
 */
import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export interface ApiAnswer<Body> {
    readonly status: number;
    readonly body: Body;
}

/** `GET <ENGINE_API_PREFIX><path>` from the page, with the page's session; throws unless it answers 200. */
export async function apiGet<Body>(page: Page, path: string): Promise<Body> {
    const answer = await apiCall<Body>(page, 'GET', path);
    if (answer.status !== 200) throw new Error(`GET ${path} answered ${String(answer.status)}`);
    return answer.body;
}

/**
 * Any API call from the page, as a member could make from the browser console: same origin, their cookie, the
 * browser's own `Origin` and `Sec-Fetch-Site`. The body is parsed JSON, or `null`.
 */
export async function apiCall<Body = unknown>(
    page: Page,
    method: string,
    path: string,
    body?: unknown,
): Promise<ApiAnswer<Body>> {
    return page.evaluate(
        async ({ url, verb, payload }) => {
            const response = await fetch(url, {
                method: verb,
                ...(payload === undefined
                    ? {}
                    : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
            });
            const parsed: unknown = await response.json().catch(() => null);
            return { status: response.status, body: parsed as never };
        },
        { url: `${ENGINE_API_PREFIX}${path}`, verb: method, payload: body },
    );
}

export interface Page_<Item> {
    readonly items: readonly Item[];
    readonly nextCursor: string | null;
}

/** Every item of a paged list, following `nextCursor`. */
export async function apiList<Item>(page: Page, path: string, limit = 100): Promise<readonly Item[]> {
    const items: Item[] = [];
    let cursor: string | null = null;
    do {
        const separator = path.includes('?') ? '&' : '?';
        const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const answer: Page_<Item> = await apiGet<Page_<Item>>(
            page,
            `${path}${separator}limit=${String(limit)}${suffix}`,
        );
        items.push(...answer.items);
        cursor = answer.nextCursor;
    } while (cursor !== null);
    return items;
}

/** The value next to a label in a definition list (`<dt>label</dt><dd>value</dd>`). */
export function factValue(scope: Locator, label: string): Locator {
    return scope
        .locator('dt')
        .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        .locator('xpath=following-sibling::dd[1]');
}

/** The SHA-256 (64 hex digits) shown in `scope`, however the UI groups the digits. */
export async function shownSha256(scope: Locator): Promise<string | null> {
    const text = (await scope.textContent()) ?? '';
    return /[0-9a-f]{64}/.exec(text.replace(/\s+/g, ''))?.[0] ?? null;
}

/** Opens a row's actions menu and answers it. */
export async function openRowMenu(page: Page, label: string): Promise<Locator> {
    await page.getByRole('button', { name: `Actions for ${label}`, exact: true }).click();
    return page.getByRole('menu', { name: `Actions for ${label}` });
}

/** A name nobody seeded, so a test finds exactly what it created. */
export function uniqueName(prefix: string): string {
    return `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
}

/** `value`, or a failure naming what the engine under test lacks. */
export function required<Value>(value: Value | undefined, what: string): Value {
    if (value === undefined) throw new Error(`the engine under test has no ${what}`);
    return value;
}

/** Saves a Wallet login through the Wallet page's form, as an owner would; `site` is a bare host. */
export async function addWalletLogin(page: Page, site: string, username: string, password: string): Promise<void> {
    await page.getByRole('button', { name: 'Add login' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add login' });
    await dialog.getByRole('textbox', { name: /^Website/ }).fill(site);
    await dialog.getByRole('textbox', { name: /^Username or email/ }).fill(username);
    await dialog.getByLabel(/^Password/).fill(password);
    await dialog.getByRole('button', { name: 'Save login' }).click();
    await expect(page.getByText(`Login for ${site} saved.`)).toBeVisible();
}

/** `@ptbk/ui`'s skeletons, which have no role: they pulse with this animation until their data is there. */
export const SKELETON = '[class*="ptbk-skeleton-pulse"]';

/**
 * Waits until no skeleton shows. Not `networkidle`: the app keeps `GET /events` open for as long as it runs.
 */
export async function settled(page: Page): Promise<void> {
    await expect(page.locator(SKELETON)).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Resolves once the app's event stream (`GET /events`) has answered. Call it before the navigation and await it before
 * changing engine state the page should show live: an event published before the stream connected is never replayed.
 */
export function eventsConnected(page: Page): Promise<unknown> {
    return page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/events' && response.status() === 200,
    );
}
