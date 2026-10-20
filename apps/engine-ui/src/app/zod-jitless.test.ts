import { z } from 'zod';
import { expect, it } from 'vitest';

it('turns off zod’s `new Function` probe before any schema is built', async () => {
    await import('./zod-jitless');
    expect(z.config().jitless).toBe(true);
});
