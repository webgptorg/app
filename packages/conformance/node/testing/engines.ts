import { fileURLToPath } from 'node:url';

import type { EngineCommand } from '../harness/engine-process';

const MOCK_ENGINE = fileURLToPath(new URL('../../../../apps/mock-engine/dist/main.mjs', import.meta.url));
const FAKE_ENGINE = fileURLToPath(new URL('./fake-engine.ts', import.meta.url));

/** Heartbeat interval the self-test engines run with, so a check that waits for beats takes seconds. */
export const SELF_TEST_HEARTBEAT_INTERVAL_S = 2;

/** The mock engine's bundle (built by the package's test script), small and fast. */
export function mockEngineCommand(extraEnv = ''): EngineCommand {
    return {
        command: `MOCK_PROFILE=full MOCK_SCENARIO=empty MOCK_HEARTBEAT_INTERVAL_S=${String(SELF_TEST_HEARTBEAT_INTERVAL_S)} ${extraEnv} exec node ${JSON.stringify(MOCK_ENGINE)}`,
        cwd: process.cwd(),
    };
}

/** The self-test's own engine, with the named defects. */
export function fakeEngineCommand(...defects: readonly string[]): EngineCommand {
    return {
        command: `FAKE_ENGINE_DEFECTS=${defects.join(',')} FAKE_HEARTBEAT_INTERVAL_S=${String(SELF_TEST_HEARTBEAT_INTERVAL_S)} exec node ${JSON.stringify(FAKE_ENGINE)}`,
        cwd: process.cwd(),
    };
}
