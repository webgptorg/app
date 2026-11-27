import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { MAX_UI_CHECK_INTERVAL_MS, UPDATE_CHECK_MIN_INTERVAL_MS } from '../capabilities/updates';
import { Sha256Hex, Timestamp } from '../common';
import type { SemVer } from '../common';
import { UiUpdateCheck } from '../security';
import type { SecurityOverview } from '../security';
import type { UpdatePolicy } from '../settings';
import { advertises, fail, ok } from './kit';
import type { EngineContext, Handlers } from './kit';

/**
 * The engine's UI updater as the API sees it. A real engine's is its loader; an engine built on the core (the mock
 * engine) plugs its own in, and without one the core runs a fake against {@link InMemoryUpdates.release}.
 */
export interface UiUpdater {
    /** The policy the updater works under, which decides whether check-now applies. */
    policy(): UpdatePolicy['policy'];
    /** When the next scheduled check is due; `null` when none is. */
    nextCheckAt(): Timestamp | null;
    /** The normal check now, joining one in flight; resolves once `GET /security` reports it. */
    checkNow(signal: AbortSignal): Promise<UiUpdateCheck>;
}

/** What the fake release store offers: one newer release, eligible at `eligibleAt` (`null`: no delay left). */
export interface FakeUiRelease {
    readonly version: SemVer;
    readonly eligibleAt: Timestamp | null;
}

export interface InMemoryUpdates {
    updater: UiUpdater | null;
    release: FakeUiRelease | null;
    storeFailing: boolean;
    /** When the last accepted check-now started, for `UPDATE_CHECK_MIN_INTERVAL_MS`. */
    lastCheckNowAtMs: number | null;
    /** Stands in for the last check before there is one, so the first scheduled check is an hour after start. */
    readonly startedAt: string;
}

export function createUpdatesRecord(startedAt: string): InMemoryUpdates {
    return { updater: null, release: null, storeFailing: false, lastCheckNowAtMs: null, startedAt };
}

function numbersOf(version: string): readonly number[] {
    return version
        .replace(/[-+].*$/, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10));
}

/** Release order on the numeric core only: the fake store never publishes pre-releases. */
export function compareVersions(a: string, b: string): number {
    const [left, right] = [numbersOf(a), numbersOf(b)];
    for (let index = 0; index < 3; index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

/** A recognisable placeholder per version, like the core's other fake hashes: never mistaken for evidence. */
function fakeBundleSha256(version: string): string {
    const hex = Array.from(version, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return hex.padEnd(64, '0').slice(0, 64);
}

type CheckFields = Omit<UiUpdateCheck, 'at'>;

const checked = (outcome: 'up-to-date' | 'unavailable', version: SemVer | null): CheckFields => ({
    outcome,
    version,
    reason: null,
    revocationReason: null,
    eligibleAt: null,
});

function decide(ctx: EngineContext, at: Timestamp): CheckFields {
    const { security, settings, updates } = ctx.state;
    const { policy, pinnedVersion } = settings.updatePolicy;
    const active = security.ui.version;
    if (updates.storeFailing) return checked('unavailable', null);
    const release = updates.release;
    const wanted = policy === 'pinned' ? (pinnedVersion ?? active) : (release?.version ?? active);
    const order = compareVersions(wanted, active);
    if (order === 0) return checked('up-to-date', wanted);
    if (order < 0) return { ...checked('up-to-date', wanted), outcome: 'refused', reason: 'not-newer' };
    if (release?.version !== wanted) return checked('unavailable', null);
    // Pinned and manual pass `mode: 'manual'` to the real verification; only `auto` waits for the delay.
    if (policy === 'auto' && release.eligibleAt !== null && Date.parse(release.eligibleAt) > Date.parse(at)) {
        return {
            ...checked('up-to-date', wanted),
            outcome: 'refused',
            reason: 'delay-not-elapsed',
            eligibleAt: release.eligibleAt,
        };
    }
    ctx.state.security = {
        ...security,
        ui: {
            ...security.ui,
            version: wanted,
            bundleSha256: Sha256Hex.parse(fakeBundleSha256(wanted)),
            releaseLogIndex: null,
            releaseLogEntryUuid: null,
        },
    };
    return { ...checked('up-to-date', wanted), outcome: 'installed' };
}

/** One check of the fake release store, recorded as `ui.lastUpdateCheck` and announced like a real one. */
export function runFakeUiCheck(ctx: EngineContext): UiUpdateCheck {
    const at = ctx.now();
    const check = UiUpdateCheck.parse({ at, ...decide(ctx, at) });
    ctx.state.security = { ...ctx.state.security, ui: { ...ctx.state.security.ui, lastUpdateCheck: check } };
    if (advertises(ctx, KNOWN_CAPABILITIES.updates)) {
        ctx.publish({ type: 'updates.changed', uiVersion: ctx.state.security.ui.version });
    }
    return check;
}

/** The fake's schedule: an hour after the last check, or the extra check at a delayed release's `eligibleAt`. */
function fakeNextCheckAt(ctx: EngineContext): Timestamp | null {
    if (ctx.state.settings.updatePolicy.policy === 'manual') return null;
    const last = ctx.state.security.ui.lastUpdateCheck;
    const periodic = Date.parse(last?.at ?? ctx.state.updates.startedAt) + MAX_UI_CHECK_INTERVAL_MS;
    const eligible =
        last?.reason === 'delay-not-elapsed' && last.eligibleAt !== null ? Date.parse(last.eligibleAt) : NaN;
    const next = Number.isNaN(eligible) ? periodic : Math.min(periodic, eligible);
    return Timestamp.parse(new Date(next).toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

/** The plugged-in updater, or the fake one over the core's own state. */
export function uiUpdaterOf(ctx: EngineContext): UiUpdater {
    return (
        ctx.state.updates.updater ?? {
            policy: () => ctx.state.settings.updatePolicy.policy,
            nextCheckAt: () => fakeNextCheckAt(ctx),
            checkNow: () => Promise.resolve(runFakeUiCheck(ctx)),
        }
    );
}

/** `GET /security` with what only the updater knows at the moment of the request. */
export function securityView(ctx: EngineContext): SecurityOverview {
    const { security } = ctx.state;
    if (!advertises(ctx, KNOWN_CAPABILITIES.updates)) return security;
    return { ...security, ui: { ...security.ui, nextCheckAt: uiUpdaterOf(ctx).nextCheckAt() } };
}

export const UPDATES_HANDLERS: Pick<Handlers, 'checkForUiUpdate'> = {
    checkForUiUpdate: async (_, ctx) => {
        const updater = uiUpdaterOf(ctx);
        if (updater.policy() === 'manual') return fail('update-policy-manual');
        const nowMs = Date.parse(ctx.now());
        const last = ctx.state.updates.lastCheckNowAtMs;
        if (last !== null && nowMs - last < UPDATE_CHECK_MIN_INTERVAL_MS) return fail('update-check-too-soon');
        ctx.state.updates.lastCheckNowAtMs = nowMs;
        return ok(await updater.checkNow(ctx.signal));
    },
};
