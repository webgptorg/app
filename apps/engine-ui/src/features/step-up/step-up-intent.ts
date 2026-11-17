import type { PreferenceStorage } from '@ptbk/ui';

export const STEP_UP_INTENT_KEY = 'ptbk.step-up-intent';

/** Long enough for a passkey prompt, short enough that a stale intent never resurfaces on a later visit. */
export const STEP_UP_INTENT_MAX_AGE_MS = 10 * 60_000;
/** An intent the page performs by itself on return must be this fresh; an older one is dropped, not run. */
export const STEP_UP_AUTO_MAX_AGE_MS = 2 * 60_000;

/**
 * What the member was about to do when the engine asked for a fresh passkey: an action name, the page it belongs to
 * and its non-secret parameters (a policy, a passkey ID), never a value the member typed as a secret.
 */
export interface StepUpIntent {
    readonly action: string;
    readonly data: unknown;
    /** `data` is the action's complete, non-secret input: on return the action runs again by itself, once. */
    readonly auto?: boolean;
}

interface StoredIntent extends StepUpIntent {
    readonly path: string;
    readonly at: number;
}

function isStoredIntent(value: unknown): value is StoredIntent {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record['action'] === 'string' &&
        typeof record['path'] === 'string' &&
        typeof record['at'] === 'number' &&
        (record['auto'] === undefined || typeof record['auto'] === 'boolean') &&
        'data' in record
    );
}

/** Kept in the preference storage across the full-page round trip to the gateway; failures only lose the restore. */
export function saveStepUpIntent(
    storage: PreferenceStorage | undefined,
    intent: StepUpIntent,
    path: string,
    now: number,
): void {
    try {
        storage?.setItem(STEP_UP_INTENT_KEY, JSON.stringify({ ...intent, path, at: now }));
    } catch {
        // Storage refused: the member comes back to the unchanged page, as before.
    }
}

/** `PreferenceStorage` has no `removeItem`; an empty value reads as no intent. */
function clear(storage: PreferenceStorage): void {
    storage.setItem(STEP_UP_INTENT_KEY, '');
}

function readStored(storage: PreferenceStorage, now: number): StoredIntent | undefined {
    const raw = storage.getItem(STEP_UP_INTENT_KEY);
    if (raw === null || raw === '') return undefined;
    let stored: unknown;
    try {
        stored = JSON.parse(raw);
    } catch {
        stored = undefined;
    }
    if (!isStoredIntent(stored) || now - stored.at < 0 || now - stored.at > STEP_UP_INTENT_MAX_AGE_MS) {
        clear(storage);
        return undefined;
    }
    return stored;
}

/**
 * The saved intent for `action` on `path`, at most once: a matching intent is removed on reading, and a stale or
 * malformed one whenever it is seen. Without `auto` the caller restores its form or dialog and never runs the action;
 * with `auto` only intents saved for an automatic rerun match, and only within `STEP_UP_AUTO_MAX_AGE_MS`.
 */
export function takeStepUpIntent(
    storage: PreferenceStorage | undefined,
    action: string,
    path: string,
    now: number,
    { auto = false }: { readonly auto?: boolean } = {},
): unknown {
    if (storage === undefined) return undefined;
    try {
        const stored = readStored(storage, now);
        if (stored?.action !== action || stored.path !== path || (stored.auto ?? false) !== auto) return undefined;
        clear(storage);
        if (auto && now - stored.at > STEP_UP_AUTO_MAX_AGE_MS) return undefined;
        return stored.data;
    } catch {
        return undefined;
    }
}
