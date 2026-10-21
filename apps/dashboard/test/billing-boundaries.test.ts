import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * ADR 0017: the rest of the dashboard asks `Entitlements`, never the provider or a plan. Only billing itself, the
 * composition root that wires it, and test support may know `BillingProvider`, the stripe package or plan IDs.
 */
const BILLING_MODULES = ['src/domain/billing/', 'src/adapters/billing/', 'src/testing/'];
const COMPOSITION_ROOT = ['src/app/create-dashboard.ts'];

const SRC = new URL('../src/', import.meta.url).pathname;

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !path.includes('/paraglide/') && !path.endsWith('routeTree.gen.ts'));
}

const IMPORT = /import\s+(?:type\s+)?([^;]*?)\s+from\s+'([^']+)'/gs;

/** Names a file imports `BillingProvider` or the stripe package under. */
export function providerImports(source: string): readonly string[] {
    return [...source.matchAll(IMPORT)].flatMap(([, clause = '', from = '']) => [
        ...(/\bBillingProvider\b/.test(clause) ? ['BillingProvider'] : []),
        ...(from === 'stripe' || from.startsWith('stripe/') ? ['stripe'] : []),
    ]);
}

/** Comparisons and switches on a plan or price ID: gating must go through entitlements instead. */
const PLAN_ID = String.raw`(?:\bplanId|\bplan\.id|\bpriceId|\bstripePriceId|\bNONE_PLAN_ID)\b`;
const PLAN_COMPARISON = new RegExp(
    String.raw`${PLAN_ID}\s*[!=]==?|[!=]==?\s*[\w.?]*${PLAN_ID}|switch\s*\([^)]*${PLAN_ID}`,
);

describe('billing boundaries', () => {
    it('recognises what it looks for', () => {
        expect(providerImports("import type { BillingProvider } from '../domain/billing/billing-provider';")).toEqual([
            'BillingProvider',
        ]);
        expect(providerImports("import Stripe from 'stripe';")).toEqual(['stripe']);
        expect(providerImports("import { billingEventSchema } from './billing-provider';")).toEqual([]);
        for (const comparison of [
            "if (view.planId === 'pro') {",
            "plan.id !== 'none'",
            "'scale' === billing.planId",
            'switch (overview.plan.id) {',
            'x.priceId == y',
        ]) {
            expect(PLAN_COMPARISON.test(comparison), comparison).toBe(true);
        }
        expect(PLAN_COMPARISON.test('planId: plan.id,')).toBe(false);
    });

    it('keeps the provider and the stripe package inside billing and the composition root', async () => {
        const offenders: string[] = [];
        for (const path of await sourceFiles(SRC)) {
            const file = relative(join(SRC, '..'), path);
            const allowed = [...BILLING_MODULES, ...COMPOSITION_ROOT].some((prefix) => file.startsWith(prefix));
            const found = providerImports(await readFile(path, 'utf8'));
            if (!allowed && found.length > 0) {
                offenders.push(`${file}: ${found.join(', ')}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('compares plan or price IDs nowhere outside billing', async () => {
        const offenders: string[] = [];
        for (const path of await sourceFiles(SRC)) {
            const file = relative(join(SRC, '..'), path);
            if (BILLING_MODULES.some((prefix) => file.startsWith(prefix))) {
                continue;
            }
            for (const [index, line] of (await readFile(path, 'utf8')).split('\n').entries()) {
                if (PLAN_COMPARISON.test(line)) {
                    offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
