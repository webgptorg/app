import type { CheckResult, ConformanceReport } from './runner';

export interface ReportSummary {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
}

export function summarize(report: ConformanceReport): ReportSummary {
    const count = (kind: CheckResult['outcome']['kind']): number =>
        report.results.filter((result) => result.outcome.kind === kind).length;
    return { passed: count('pass'), failed: count('fail'), skipped: count('skip') };
}

/** The report as JSON: stable field order, one result per check, plus the summary. */
export function writeJsonReport(report: ConformanceReport): string {
    return `${JSON.stringify({ ...report, summary: summarize(report) }, null, 2)}\n`;
}

/** JUnit XML, one `<testsuite>` per suite and one `<testcase>` per check, for CI annotations. */
export function writeJunitReport(report: ConformanceReport): string {
    const suites = new Map<string, CheckResult[]>();
    for (const result of report.results) suites.set(result.suite, [...(suites.get(result.suite) ?? []), result]);
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    const total = summarize(report);
    lines.push(
        `<testsuites name="ptbk-conformance" tests="${String(report.results.length)}" failures="${String(total.failed)}" skipped="${String(total.skipped)}" time="${seconds(sumDuration(report.results))}" timestamp="${xml(report.startedAt)}">`,
    );
    for (const [suite, results] of suites) {
        const counts = summarize({ ...report, results });
        lines.push(
            `  <testsuite name="${xml(suite)}" tests="${String(results.length)}" failures="${String(counts.failed)}" skipped="${String(counts.skipped)}" time="${seconds(sumDuration(results))}">`,
        );
        for (const result of results) {
            const open = `    <testcase classname="${xml(suite)}" name="${xml(result.id)}" time="${seconds(result.durationMs)}"`;
            switch (result.outcome.kind) {
                case 'pass':
                    lines.push(`${open}/>`);
                    break;
                case 'fail':
                    lines.push(
                        `${open}>`,
                        `      <failure message="${xml(firstLine(result.outcome.detail))}">${xml(`${result.title}\n${result.outcome.detail}`)}</failure>`,
                        '    </testcase>',
                    );
                    break;
                case 'skip':
                    lines.push(
                        `${open}>`,
                        `      <skipped message="${xml(result.outcome.reason)}"/>`,
                        '    </testcase>',
                    );
                    break;
            }
        }
        lines.push('  </testsuite>');
    }
    lines.push('</testsuites>');
    return `${lines.join('\n')}\n`;
}

function sumDuration(results: readonly CheckResult[]): number {
    return results.reduce((sum, result) => sum + result.durationMs, 0);
}

function seconds(ms: number): string {
    return (ms / 1000).toFixed(3);
}

function firstLine(text: string): string {
    return text.split('\n', 1)[0] ?? '';
}

/** Escapes text and attribute values, and drops characters XML 1.0 cannot carry at all. */
function xml(text: string): string {
    return text
        .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
