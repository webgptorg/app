import { describe, expect, it } from 'vitest';

import { abortable } from './abortable';

describe('abortable', () => {
    it('passes a rejection through and stops listening for the abort', async () => {
        const controller = new AbortController();
        const failure = new Error('broken');
        await expect(abortable(Promise.reject(failure), controller.signal)).rejects.toBe(failure);
        controller.abort();
    });

    it('rejects with the reason of a signal that aborts first', async () => {
        const controller = new AbortController();
        const pending = abortable(new Promise(() => undefined), controller.signal);
        const reason = new Error('gone');
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });

    it('rejects at once for an already-aborted signal', async () => {
        const reason = new Error('gone');
        await expect(abortable(Promise.resolve(1), AbortSignal.abort(reason))).rejects.toBe(reason);
    });
});
