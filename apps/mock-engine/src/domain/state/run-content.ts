import type { ProjectFileTemplate } from './capability-texts';
import { MODEL_PRICES } from './capability-texts';
import type { SeededSequence } from './seed-random';

const HEX = '0123456789abcdef';

export function hex(sequence: SeededSequence, length: number): string {
    let out = '';
    for (let index = 0; index < length; index++) out += HEX.charAt(sequence.int(0, 15));
    return out;
}

export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly durationMs: number;
    readonly cost: { readonly amount: string; readonly currency: 'USD' };
}

/** Tokens drawn from the sequence, and their cost at the model's list price, as a decimal string. */
export function usageFor(sequence: SeededSequence, model: keyof typeof MODEL_PRICES, durationMs: number): Usage {
    const inputTokens = sequence.int(800, 60_000);
    const outputTokens = sequence.int(150, 8_000);
    const [inputPrice, outputPrice] = MODEL_PRICES[model];
    const cost = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
    return { inputTokens, outputTokens, durationMs, cost: { amount: cost.toFixed(4), currency: 'USD' } };
}

export interface Diff {
    readonly diff: string;
    readonly changedFiles: readonly {
        readonly path: string;
        readonly insertions: number;
        readonly deletions: number;
    }[];
}

/** A unified diff (`git diff` style) replacing each file's `before` lines with its `after` lines. */
export function unifiedDiff(files: readonly ProjectFileTemplate[]): Diff {
    const parts: string[] = [];
    const changedFiles = files.map((file) => {
        parts.push(
            `diff --git a/${file.path} b/${file.path}`,
            `--- a/${file.path}`,
            `+++ b/${file.path}`,
            `@@ -1,${String(file.before.length)} +1,${String(file.after.length)} @@`,
            ...file.before.map((line) => `-${line}`),
            ...file.after.map((line) => `+${line}`),
        );
        return { path: file.path, insertions: file.after.length, deletions: file.before.length };
    });
    return { diff: `${parts.join('\n')}\n`, changedFiles };
}

/** A generated fixture added in one commit: far over the contract's run text limit, so the engine truncates it. */
export function largeFixtureDiff(sequence: SeededSequence, lines: number): Diff {
    const path = 'test/fixtures/customers.json';
    const body: string[] = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`];
    body.push(`@@ -0,0 +1,${String(lines)} @@`, '+[');
    for (let index = 0; index < lines - 2; index++) {
        body.push(
            `+  { "id": ${String(index + 1)}, "name": "Customer ${hex(sequence, 6)}", "plan": "${index % 3 === 0 ? 'team' : 'pro'}", "mrr": ${String(sequence.int(10, 900))} },`,
        );
    }
    body.push('+]');
    return { diff: `${body.join('\n')}\n`, changedFiles: [{ path, insertions: lines, deletions: 0 }] };
}
