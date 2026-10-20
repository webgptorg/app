import { execFileSync } from 'node:child_process';

import { GitCommit } from '@ptbk/protocol';

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function headCommit(cwd: string): string {
    return GitCommit.parse(git(cwd, ['rev-parse', 'HEAD']));
}

/** The commit time in seconds: `SOURCE_DATE_EPOCH`, the only time a release may contain. */
export function headCommitTime(cwd: string): number {
    const seconds = git(cwd, ['log', '-1', '--format=%ct', 'HEAD']);
    if (!/^[0-9]{1,12}$/.test(seconds)) throw new Error(`unexpected commit time: ${seconds}`);
    return Number(seconds);
}

/** A release must be exactly its commit; untracked files (build output, generated code) are ignored by git anyway. */
export function assertCleanTree(cwd: string): void {
    const changes = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
    if (changes !== '') throw new Error(`uncommitted changes; commit them or pass --allow-dirty:\n${changes}`);
}
