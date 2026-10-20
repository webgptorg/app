import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertCleanTree, headCommit, headCommitTime } from './git.ts';

let repo: string;

beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ptbk-git-'));
    const env = { ...process.env, GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z' };
    const git = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, env });
    };
    git('init', '-q');
    await writeFile(join(repo, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '--no-gpg-sign', '-m', 'init');
});
afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
});

describe('git', () => {
    it('reads the HEAD commit and its commit time', () => {
        expect(headCommit(repo)).toMatch(/^[0-9a-f]{40}$/);
        expect(headCommitTime(repo)).toBe(Date.parse('2026-10-01T00:00:00Z') / 1000);
    });

    it('accepts untracked files but refuses changes to tracked ones', async () => {
        await writeFile(join(repo, 'untracked.txt'), 'u');
        expect(() => {
            assertCleanTree(repo);
        }).not.toThrow();
        await writeFile(join(repo, 'a.txt'), 'changed');
        expect(() => {
            assertCleanTree(repo);
        }).toThrow(/uncommitted changes/);
    });
});
