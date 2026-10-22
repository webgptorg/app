import type { Diagnostic } from '@ptbk/engine-api';
import { useCallback, useEffect, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';

/** Typing pauses this long before the engine checks the text. */
export const VALIDATION_DELAY_MS = 500;
const VALIDATION_TIMEOUT_MS = 15_000;

export interface BookValidation {
    readonly diagnostics: readonly Diagnostic[];
    readonly checking: boolean;
    /** The last check got no answer; the diagnostics shown are older. */
    readonly failed: boolean;
    /** Shows diagnostics from elsewhere (a refused save) until the text next changes. */
    readonly show: (diagnostics: readonly Diagnostic[]) => void;
}

interface ValidationResult {
    readonly diagnostics: readonly Diagnostic[];
    readonly failed: boolean;
}

const NONE: ValidationResult = { diagnostics: [], failed: false };

/**
 * The engine's diagnostics for `source`, checked 500 ms after the last change. A change aborts the check in flight,
 * and an answer that arrives after its check was aborted is dropped, so an older text's diagnostics never replace a
 * newer one's. `enabled` is false for members who may not write, since the engine refuses them the check.
 */
export function useBookValidation(source: string, enabled: boolean): BookValidation {
    const engineApi = useEngineApi();
    const [result, setResult] = useState<ValidationResult>(NONE);
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            setChecking(true);
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]);
            const settle = (next: (previous: ValidationResult) => ValidationResult) => {
                if (controller.signal.aborted) return;
                setResult(next);
                setChecking(false);
            };
            engineApi.agents.validate({ source }, signal).then(
                (response) => {
                    settle((previous) =>
                        response.kind === 'ok'
                            ? { diagnostics: response.data, failed: false }
                            : { ...previous, failed: true },
                    );
                },
                () => {
                    settle((previous) => ({ ...previous, failed: true }));
                },
            );
        }, VALIDATION_DELAY_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
            setChecking(false);
        };
    }, [engineApi, source, enabled]);

    const show = useCallback((diagnostics: readonly Diagnostic[]) => {
        setResult({ diagnostics, failed: false });
    }, []);

    return { diagnostics: result.diagnostics, checking, failed: result.failed, show };
}
