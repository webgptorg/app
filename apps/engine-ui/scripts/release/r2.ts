import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { PINNED_TRUSTED_ROOT_FILE } from '@ptbk/release-tools';

import { RELEASE_FILES } from './paths.ts';

/** An S3-compatible bucket (R2) reached with `curl --aws-sigv4`. */
export interface R2Target {
    /** `https://<account>.r2.cloudflarestorage.com`, without a trailing slash. */
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
}

export interface Upload {
    readonly key: string;
    readonly file: string;
    readonly contentType: string;
}

/**
 * Runs curl with `args`; `config` goes to its stdin (`--config -`), so credentials never appear in the process list.
 * Resolves the HTTP status curl reports, rejects when curl itself fails.
 */
export type Curl = (args: readonly string[], config: string) => Promise<number>;

export const runCurl: Curl = (args, config) =>
    new Promise((resolve, reject) => {
        const child = spawn('curl', ['--config', '-', ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            const status = Number(stdout);
            if (code !== 0 || !/^[0-9]{3}$/.test(stdout)) reject(new Error(`curl failed (exit ${String(code)})`));
            else resolve(status);
        });
        child.stdin.end(config);
    });

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const CREDENTIAL = /^[A-Za-z0-9+/=_-]{1,256}$/;

/** What a UI release publishes, the release log entry last so it never names files that are not there yet. */
export function releaseUploads(dir: string, version: string): Upload[] {
    const prefix = `ui/${version}`;
    return [
        {
            key: `${prefix}/${RELEASE_FILES.archive}`,
            file: join(dir, RELEASE_FILES.archive),
            contentType: 'application/zstd',
        },
        {
            key: `${prefix}/${RELEASE_FILES.manifest}`,
            file: join(dir, RELEASE_FILES.manifest),
            contentType: 'application/json',
        },
        {
            key: `${prefix}/${RELEASE_FILES.archiveBundle}`,
            file: join(dir, RELEASE_FILES.archiveBundle),
            contentType: 'application/json',
        },
        // The trusted root the release verifies against, for offline verifiers and mirrors; an engine pins its own.
        {
            key: `${prefix}/trusted_root.json`,
            file: PINNED_TRUSTED_ROOT_FILE,
            contentType: 'application/json',
        },
        {
            key: `release-log/ui-${version}.json`,
            file: join(dir, RELEASE_FILES.signedRelease),
            contentType: 'application/json',
        },
    ];
}

export type PublishOutcome =
    | { readonly kind: 'published'; readonly keys: readonly string[] }
    | { readonly kind: 'exists'; readonly key: string };

/**
 * Uploads every file, never overwriting: if any key already exists nothing is uploaded, and each PUT carries
 * `If-None-Match: *` so a concurrent publish of the same version fails instead of replacing objects.
 */
export async function publishRelease(
    target: R2Target,
    uploads: readonly Upload[],
    curl: Curl = runCurl,
): Promise<PublishOutcome> {
    if (!CREDENTIAL.test(target.accessKeyId) || !CREDENTIAL.test(target.secretAccessKey)) {
        throw new Error('R2 credentials contain unexpected characters');
    }
    const config = `user = "${target.accessKeyId}:${target.secretAccessKey}"\n`;
    const common = ['--silent', '--show-error', '--max-time', '300', '--aws-sigv4', 'aws:amz:auto:s3'];
    const output = ['--output', '/dev/null', '--write-out', '%{http_code}'];
    const url = (key: string): string => {
        if (!KEY.test(key) || key.includes('..') || key.includes('//')) throw new Error(`unsafe object key: ${key}`);
        return `${target.endpoint}/${encodeURIComponent(target.bucket)}/${key}`;
    };

    for (const { key } of uploads) {
        const status = await curl([...common, '--head', ...output, url(key)], config);
        if (status === 200) return { kind: 'exists', key };
        if (status !== 404) throw new Error(`HEAD ${key} answered ${String(status)}`);
    }
    for (const { key, file, contentType } of uploads) {
        const status = await curl(
            [
                ...common,
                '--upload-file',
                file,
                '--header',
                'If-None-Match: *',
                '--header',
                `Content-Type: ${contentType}`,
                ...output,
                url(key),
            ],
            config,
        );
        if (status === 412) return { kind: 'exists', key };
        if (status !== 200) throw new Error(`PUT ${key} answered ${String(status)}`);
    }
    return { kind: 'published', keys: uploads.map(({ key }) => key) };
}
