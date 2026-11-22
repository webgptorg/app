import { expect, it } from 'vitest';

import { createAdvisoryEntitlements } from './advisory-entitlements';

it('allows every feature without a limit, so a licence never stops anyone in the App', async () => {
    const entitlements = createAdvisoryEntitlements();
    const signal = new AbortController().signal;
    expect(await entitlements.allows('org' as never, 'engines.create', signal)).toBe(true);
    expect(await entitlements.limit('org' as never, 'engines.max', signal)).toBeNull();
});
