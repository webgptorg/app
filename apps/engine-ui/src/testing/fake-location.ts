import { vi } from 'vitest';
import type { Mock } from 'vitest';

import type { BrowserLocation } from '../app/sign-in-redirect';

export interface FakeLocation extends BrowserLocation {
    readonly assign: Mock<(url: string) => void>;
}

export const TEST_ORIGIN = 'https://engine.localhost';

/** `window.location` for tests: full-page navigations are recorded, never performed. */
export function createFakeLocation(path: string): FakeLocation {
    const url = new URL(path, TEST_ORIGIN);
    return { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, assign: vi.fn() };
}
