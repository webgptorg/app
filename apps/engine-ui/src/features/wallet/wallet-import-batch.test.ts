import { describe, expect, it, vi } from 'vitest';

import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';
import { OneTimeValue } from './one-time-value';
import { WalletImportBatch } from './wallet-import-batch';
import type { ImportWrite } from './wallet-import-batch';

function write(id: number, replace = false): ImportWrite {
    return {
        id,
        origin: `https://site${String(id)}.example`,
        username: 'ada',
        label: '',
        password: new OneTimeValue(`test-canary-${String(id)}`),
        replace,
    };
}

describe('Wallet import queue', () => {
    it('writes sequentially and resumes at the current login after step-up', async () => {
        const engine = createSecurityEngine();
        const original = engine.client.wallet.add.bind(engine.client.wallet);
        const add = vi.spyOn(engine.client.wallet, 'add');
        add.mockImplementationOnce(original).mockImplementationOnce(() => problemResponse('step-up-required'));
        const writes = [write(1), write(2), write(3)];
        const batch = new WalletImportBatch(writes);
        const progress = vi.fn();
        await expect(batch.run(engine.client.wallet, progress)).rejects.toThrow('step-up-required');
        expect(progress).toHaveBeenLastCalledWith({ saved: 1, skipped: 0 });
        expect(JSON.stringify(batch)).toBe('{}');
        expect(await batch.run(engine.client.wallet, progress)).toEqual({ saved: 3, skipped: 0 });
        expect(add.mock.calls.map(([body]) => body.origin)).toEqual([
            'https://site1.example',
            'https://site2.example',
            'https://site2.example',
            'https://site3.example',
        ]);
        expect(add.mock.calls.map(([body]) => body.password)).toEqual([
            'test-canary-1',
            'test-canary-2',
            'test-canary-2',
            'test-canary-3',
        ]);
        for (const item of writes) expect(item.password.take()).toBe('');
        await batch.run(engine.client.wallet, progress);
        expect(add).toHaveBeenCalledTimes(4);
    });

    it('rechecks duplicates after preview and replaces only explicitly selected existing logins', async () => {
        const engine = createSecurityEngine();
        await engine.client.wallet.add(
            { origin: 'https://www.site1.example', username: 'ADA', password: 'existing-canary' },
            AbortSignal.timeout(1000),
        );
        const add = vi.spyOn(engine.client.wallet, 'add');
        const first = write(1);
        expect(await new WalletImportBatch([first, write(2)]).run(engine.client.wallet, vi.fn())).toEqual({
            saved: 1,
            skipped: 1,
        });
        expect(first.password.take()).toBe('');
        expect(add.mock.calls.map(([body]) => body.origin)).toEqual(['https://site2.example']);
        expect(await new WalletImportBatch([write(1, true)]).run(engine.client.wallet, vi.fn())).toEqual({
            saved: 1,
            skipped: 0,
        });
        expect(add).toHaveBeenCalledTimes(2);
    });

    it('clears pending passwords on permanent failures, keeps completed writes and never continues automatically', async () => {
        const engine = createSecurityEngine();
        const original = engine.client.wallet.add.bind(engine.client.wallet);
        const actual = vi
            .spyOn(engine.client.wallet, 'add')
            .mockImplementationOnce(original)
            .mockImplementationOnce(() => problemResponse('wallet-not-ready'));
        const writes = [write(1), write(2), write(3)];
        const batch = new WalletImportBatch(writes);
        const progress = vi.fn();
        await expect(batch.run(engine.client.wallet, progress)).rejects.toThrow('wallet-not-ready');
        expect(progress).toHaveBeenLastCalledWith({ saved: 1, skipped: 0 });
        for (const item of writes) expect(item.password.take()).toBe('');
        expect(await batch.run(engine.client.wallet, progress)).toEqual({ saved: 1, skipped: 0 });
        expect(actual).toHaveBeenCalledTimes(2);
    });

    it('stops future writes after cancellation, including an old step-up retry', async () => {
        const engine = createSecurityEngine();
        const add = vi.spyOn(engine.client.wallet, 'add');
        const writes = [write(1), write(2)];
        const batch = new WalletImportBatch(writes);
        const progress = vi.fn(() => {
            batch.cancel();
        });
        expect(await batch.run(engine.client.wallet, progress)).toEqual({ saved: 1, skipped: 0 });
        expect(await batch.run(engine.client.wallet, progress)).toEqual({ saved: 1, skipped: 0 });
        expect(add).toHaveBeenCalledTimes(1);
        expect(writes[1]?.password.take()).toBe('');
    });

    it('fails before writing when the Wallet was locked or the overview cannot enumerate every saved login', async () => {
        const engine = createSecurityEngine();
        engine.controller.setWalletState('locked');
        const add = vi.spyOn(engine.client.wallet, 'add');
        const item = write(1);
        await expect(new WalletImportBatch([item]).run(engine.client.wallet, vi.fn())).rejects.toThrow('unavailable');
        expect(item.password.take()).toBe('');
        expect(add).not.toHaveBeenCalled();
    });

    it('clears the queue when even the fresh overview fails or a network call rejects', async () => {
        const engine = createSecurityEngine();
        vi.spyOn(engine.client.wallet, 'get').mockRejectedValueOnce(new TypeError('connection failed'));
        const first = write(1);
        await expect(new WalletImportBatch([first]).run(engine.client.wallet, vi.fn())).rejects.toThrow(
            'connection failed',
        );
        expect(first.password.take()).toBe('');
        vi.spyOn(engine.client.wallet, 'add').mockRejectedValueOnce(new TypeError('connection failed'));
        const second = write(2);
        await expect(new WalletImportBatch([second]).run(engine.client.wallet, vi.fn())).rejects.toThrow(
            'connection failed',
        );
        expect(second.password.take()).toBe('');
    });

    it('accepts cancellation while the initial read is in flight', async () => {
        const engine = createSecurityEngine();
        const add = vi.spyOn(engine.client.wallet, 'add');
        const item = write(1);
        const batch = new WalletImportBatch([item]);
        const running = batch.run(engine.client.wallet, vi.fn());
        batch.cancel();
        expect(await running).toEqual({ saved: 0, skipped: 0 });
        expect(item.password.take()).toBe('');
        expect(add).not.toHaveBeenCalled();
    });

    it('refuses a full overview that may hide additional accounts', async () => {
        const records = Array.from({ length: 1000 }, (_, id) => ({
            id: `seed-${String(id)}`,
            label: 'Saved',
            origin: `https://saved${String(id)}.example`,
            username: 'ada',
            fields: [],
            updatedAt: '2026-01-01T00:00:00Z',
            lastUse: null,
            verification: null,
        }));
        const engine = createSecurityEngine({ seed: { wallet: { records } } });
        const add = vi.spyOn(engine.client.wallet, 'add');
        await expect(new WalletImportBatch([write(1)]).run(engine.client.wallet, vi.fn())).rejects.toThrow(
            'unavailable',
        );
        expect(add).not.toHaveBeenCalled();
    });
});
