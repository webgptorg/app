import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CeremonyResult } from './ceremonies';
import { useCeremony } from './use-ceremony';

describe('useCeremony', () => {
    it('runs one ceremony at a time and keeps the failure for the screen', async () => {
        let finish: (result: CeremonyResult<number>) => void = () => undefined;
        const ceremony = vi.fn(
            () =>
                new Promise<CeremonyResult<number>>((resolve) => {
                    finish = resolve;
                }),
        );
        const onSuccess = vi.fn();
        const { result } = renderHook(() => useCeremony(ceremony, onSuccess));

        act(() => {
            result.current.start();
            result.current.start();
        });
        expect(ceremony).toHaveBeenCalledTimes(1);
        expect(result.current.state).toEqual({ kind: 'running' });

        await act(async () => {
            finish({ kind: 'failed', failure: { kind: 'passkey', reason: 'cancelled' } });
            await Promise.resolve();
        });
        expect(result.current.state).toEqual({ kind: 'failed', failure: { kind: 'passkey', reason: 'cancelled' } });

        act(() => {
            result.current.start();
        });
        await act(async () => {
            finish({ kind: 'ok', value: 7 });
            await Promise.resolve();
        });
        expect(onSuccess).toHaveBeenCalledWith(7);
        expect(result.current.state).toEqual({ kind: 'idle' });
    });
});
