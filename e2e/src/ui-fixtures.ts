/*
 * Fixtures for the engine-ui flows (X-04, tests/ui/): the engine under test as an `EngineTarget`, a fresh seeded engine
 * before every test, sessions, and the page guard every test runs under. The guard fails a test on any CSP or Trusted
 * Types violation, uncaught page error, request to another origin or native dialog, in any page of its context.
 */
import type { BrowserContext } from '@playwright/test';

import type { EngineControls, EngineTarget, UiSessionSubject } from './engine-target.ts';
import { ALL_CAPABILITIES } from './engine-target.ts';
import { expect, test as base } from './fixtures.ts';
import { createMockEngineUiTarget } from './mock-engine-target.ts';
import type { ResponseRecorder } from './response-recorder.ts';
import { recordResponses } from './response-recorder.ts';
import { MOCK_ENGINE_CONTROL, UI_RELEASES } from './stack.ts';
import type { GuardReport, GuardedViolation } from './ui-guard.ts';
import { guardFindings, isForeignRequest, isPolicyMessage } from './ui-guard.ts';

export { expect };

/** The engine every flow starts from: compose.ui.yaml starts the mock engine with the same seed and scenario. */
export const UI_SEED = 1;
export const UI_SCENARIO = 'small-team';
export const OWNER: UiSessionSubject = { kind: 'owner' };

const GUARD_BINDING = '__ptbkE2eUiGuard';

export interface UiWorkerFixtures {
    readonly engine: EngineTarget;
}

export interface UiTestFixtures {
    /** Resets the engine to the seed, with every capability, no faults and the simulation paused. */
    readonly freshEngine: undefined;
    /**
     * What the guard saw so far in this test; it fails the test at the end unless every list of the report is empty.
     * `consoleMessages` keeps every console message too, for "the canary never reached the console".
     */
    readonly guard: GuardReport & { readonly consoleMessages: readonly string[] };
    /** Signs the test's browser context in, as the gateway would after a passkey assertion. */
    readonly signIn: (subject?: UiSessionSubject) => Promise<void>;
    /** `https://<engine>/<path>`. */
    readonly appUrl: (path: string) => string;
    readonly responses: ResponseRecorder;
}

/** The control a flow needs; skips the test with the reason when the engine under test has none. */
export function need<Name extends keyof EngineControls>(
    engine: EngineTarget,
    name: Name,
): NonNullable<EngineControls[Name]> {
    const control = engine.controls[name];
    test.skip(control === undefined, `the engine under test offers no "${name}" control`);
    return control as NonNullable<EngineControls[Name]>;
}

export interface MutableGuard {
    readonly cspViolations: GuardedViolation[];
    readonly policyMessages: string[];
    readonly pageErrors: string[];
    readonly foreignRequests: string[];
    readonly dialogs: string[];
    readonly consoleMessages: string[];
}

export function newGuard(): MutableGuard {
    return {
        cspViolations: [],
        policyMessages: [],
        pageErrors: [],
        foreignRequests: [],
        dialogs: [],
        consoleMessages: [],
    };
}

/** Hooks the page guard into a context; also for browsers a test launches itself (relay failover). */
export async function installGuard(context: BrowserContext, engineHost: string, guard: MutableGuard): Promise<void> {
    await context.exposeBinding(GUARD_BINDING, (_source, violation: GuardedViolation) => {
        guard.cspViolations.push(violation);
    });
    // Before any page script runs, in every frame and page of the context.
    await context.addInitScript((binding) => {
        document.addEventListener('securitypolicyviolation', (event) => {
            const report = (window as unknown as Record<string, ((violation: unknown) => void) | undefined>)[binding];
            report?.({
                directive: event.effectiveDirective,
                blockedUri: event.blockedURI,
                sourceFile: event.sourceFile,
            });
        });
    }, GUARD_BINDING);
    context.on('console', (message) => {
        guard.consoleMessages.push(message.text());
        if (isPolicyMessage(message.text())) guard.policyMessages.push(message.text());
    });
    context.on('weberror', (error) => guard.pageErrors.push(error.error().message));
    context.on('request', (request) => {
        if (isForeignRequest(request.url(), engineHost)) guard.foreignRequests.push(request.url());
    });
    context.on('dialog', (dialog) => {
        guard.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
        void dialog.dismiss().catch(() => undefined);
    });
}

export const test = base.extend<UiTestFixtures, UiWorkerFixtures>({
    engine: [
        async ({ engineHost }, use) => {
            await use(
                createMockEngineUiTarget({
                    hostname: engineHost,
                    controlUrl: new URL(`http://${MOCK_ENGINE_CONTROL.ip}:${String(MOCK_ENGINE_CONTROL.port)}`),
                    tamperedVersion: UI_RELEASES.tampered,
                }),
            );
        },
        { scope: 'worker' },
    ],

    freshEngine: [
        async ({ engine }, use) => {
            const { reset, faults, pauseSimulation } = engine.controls;
            await reset?.({ scenario: UI_SCENARIO, seed: UI_SEED, capabilities: ALL_CAPABILITIES });
            await faults?.clear();
            await pauseSimulation?.();
            await use(undefined);
            await faults?.clear();
        },
        { auto: true },
    ],

    // Auto, so it hooks the context before the test's page exists and nothing the page does escapes it.
    guard: [
        async ({ context, engine }, use) => {
            const guard = newGuard();
            await installGuard(context, engine.hostname, guard);
            await use(guard);
            expect(guardFindings(guard), 'CSP, Trusted Types, errors, foreign requests or dialogs').toEqual([]);
        },
        { auto: true },
    ],

    signIn: async ({ context, engine }, use) => {
        await use(async (subject = OWNER) => {
            const cookie = await engine.session(subject);
            await context.addCookies([
                {
                    ...cookie,
                    url: `https://${engine.hostname}/`,
                    secure: true,
                    httpOnly: true,
                    sameSite: 'Strict',
                },
            ]);
        });
    },
    appUrl: async ({ engine }, use) => {
        await use((path) => `https://${engine.hostname}${path.startsWith('/') ? path : `/${path}`}`);
    },
    responses: async ({ context }, use) => {
        await use(recordResponses(context));
    },
});
