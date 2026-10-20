import { STEP_UP_PATH } from '@ptbk/engine-api';

import type { BrowserLocation } from '../../app/sign-in-redirect';
import { safeNextPath } from '../../security/safe-url';

/** The gateway's step-up page, which returns to the current page after a fresh passkey assertion. */
export function stepUpUrl(location: Omit<BrowserLocation, 'assign'>): string {
    const returnTo = safeNextPath(`${location.pathname}${location.search}${location.hash}`, location.origin) ?? '/';
    return `${STEP_UP_PATH}?${new URLSearchParams({ returnTo }).toString()}`;
}
