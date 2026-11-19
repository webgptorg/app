import { MAX_WALLET_RECORDS } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { isStepUpRequired } from '../../app/mutations';
import type { OneTimeValue } from './one-time-value';
import { hasImportConflict, importLoginKey } from './password-import';
import type { ImportLogin } from './password-import';

export interface ImportWrite extends ImportLogin {
    readonly password: OneTimeValue;
    /** True only for an existing login explicitly selected in the preview. */
    readonly replace: boolean;
}

export interface ImportProgress {
    readonly saved: number;
    readonly skipped: number;
}

/** A private queue and cursor: step-up retries resume at the current login, never replay completed saves. */
export class WalletImportBatch {
    readonly #writes: readonly ImportWrite[];
    readonly #abort = new AbortController();
    #cursor = 0;
    #saved = 0;
    #skipped = 0;

    constructor(writes: readonly ImportWrite[]) {
        this.#writes = writes;
    }

    cancel(): void {
        this.#abort.abort();
        for (const write of this.#writes) write.password.take();
    }

    #isClosed(): boolean {
        return this.#abort.signal.aborted;
    }

    async run(wallet: EngineApiClient['wallet'], progress: (value: ImportProgress) => void): Promise<ImportProgress> {
        const summary = () => ({ saved: this.#saved, skipped: this.#skipped });
        if (this.#isClosed()) return summary();
        const signal = () => AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]);
        try {
            // Recheck after file selection and after step-up; never overwrite a newly discovered login by default.
            const latest = unwrap(await wallet.get(signal()));
            if (this.#isClosed()) return summary();
            if (latest.state !== 'ready' || latest.records.length >= MAX_WALLET_RECORDS) {
                throw new Error('Wallet import is unavailable');
            }
            const existing = new Set(latest.records.map(importLoginKey));
            let recordCount = latest.records.length;
            while (this.#cursor < this.#writes.length && !this.#isClosed()) {
                const write = this.#writes[this.#cursor];
                if (write === undefined) break;
                const key = importLoginKey(write);
                if (!write.replace && hasImportConflict(existing, write)) {
                    write.password.take();
                    this.#cursor += 1;
                    this.#skipped += 1;
                    progress(summary());
                    continue;
                }
                if (!existing.has(key) && recordCount >= MAX_WALLET_RECORDS) {
                    throw new Error('Wallet import capacity reached');
                }
                const password = write.password.take();
                const answer = await wallet.add(
                    {
                        origin: write.origin,
                        username: write.username,
                        password,
                        ...(write.label === '' ? {} : { label: write.label }),
                    },
                    signal(),
                );
                if (answer.kind === 'problem' && answer.problem.code === 'step-up-required' && !this.#isClosed()) {
                    write.password.restore(password);
                }
                unwrap(answer);
                if (!existing.has(key)) recordCount += 1;
                existing.add(key);
                this.#cursor += 1;
                this.#saved += 1;
                progress(summary());
            }
            this.cancel();
            return summary();
        } catch (error) {
            if (!isStepUpRequired(classifyApiError(error)) || this.#isClosed()) this.cancel();
            throw error;
        }
    }

    toJSON(): Record<string, never> {
        return {};
    }
}
