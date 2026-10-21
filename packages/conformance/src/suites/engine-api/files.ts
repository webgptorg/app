import { acceptsFile, ENGINE_API_ROUTES, FILE_PURPOSES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { FileMetadata, FilePurpose, FileStats, FileUploadPolicy } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { randomToken } from '../../random';
import { checkFilter, checkStableWalk, requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const CREATED = 5;
const decoder = new TextDecoder();

async function upload(world: World, label: string, text: string): Promise<FileMetadata> {
    const form = new FormData();
    form.set('file', new Blob([text], { type: 'text/plain' }), 'conformance.txt');
    form.set('name', `${world.name(label)}.txt`);
    form.set('purpose', 'upload');
    const file = await world.owner.ok(R.uploadFile, { body: form });
    world.ctx.resources.defer((signal) =>
        world.owner.withSignal(signal).send(R.deleteFile, { params: { fileId: file.id } }),
    );
    return file;
}

interface Sample {
    readonly name: string;
    readonly type: string;
}

/** A file the policy accepts, built from its first `accept` entry; any plain text file when it takes everything. */
function acceptedSample(world: World, label: string, accept: readonly string[]): Sample {
    const [token] = accept;
    const base = world.name(label);
    if (token === undefined) return { name: `${base}.txt`, type: 'text/plain' };
    if (token.startsWith('.')) return { name: `${base}${token}`, type: '' };
    return { name: base, type: token.endsWith('/*') ? `${token.slice(0, -1)}x-ptbk-conformance` : token };
}

/** Matches no `accept` list that names real types: an unregistered extension and media type. */
const UNACCEPTED = { extension: '.ptbk-conformance-unaccepted', type: 'application/x-ptbk-conformance-unaccepted' };

function form(purpose: FilePurpose, file: Blob, name: string): FormData {
    const body = new FormData();
    body.set('file', file, 'conformance');
    body.set('name', name);
    body.set('purpose', purpose);
    return body;
}

/** Uploads what the engine should refuse; if it takes it anyway, the file is removed again and that is a finding. */
async function expectRefusedUpload(
    world: World,
    findings: Findings,
    body: FormData,
    code: 'payload-too-large' | 'unsupported-media-type',
    what: string,
): Promise<void> {
    const result = await world.owner.call(R.uploadFile, { body });
    if (result.kind === 'ok') {
        const fileId = result.data.id;
        world.ctx.resources.defer((signal) =>
            world.owner.withSignal(signal).send(R.deleteFile, { params: { fileId } }),
        );
        findings.add(`POST /files: ${what} was stored instead of refused with ${code}`);
        return;
    }
    if (result.problem.code !== code) findings.add(`POST /files: ${what} got ${result.problem.code}, not ${code}`);
}

function total(counts: Readonly<Record<string, number>>): number {
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export const FILE_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.files.paging',
        suite: SUITE,
        title: 'GET /files pages without gaps or duplicates, and its filters list only matching files',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.files);
            const findings = new Findings();
            const label = `page-${randomToken(ctx.random, 6)}`;
            const created: string[] = [];
            for (let index = 0; index < CREATED; index++) created.push((await upload(world, label, 'page\n')).id);
            const q = `conformance-${ctx.runId}-${label}`;
            await attempt(findings, () => checkStableWalk(world, findings, R.listFiles, { q }));
            await attempt(findings, async () => {
                const listed = await world.owner.ok(R.listFiles, { query: { q, limit: 100 } });
                const missing = created.filter((id) => !listed.items.some((file) => file.id === id));
                if (missing.length > 0)
                    findings.add(`GET /files: ${String(missing.length)} uploaded files are missing`);
                checkFilter(findings, R.listFiles, 'q', listed.items, ({ name }) => name.includes(q));
                const uploads = await world.owner.ok(R.listFiles, { query: { purpose: 'upload', limit: 50 } });
                checkFilter(
                    findings,
                    R.listFiles,
                    'purpose=upload',
                    uploads.items,
                    ({ purpose }) => purpose === 'upload',
                );
                const clean = await world.owner.ok(R.listFiles, { query: { scan: 'clean', limit: 50 } });
                checkFilter(findings, R.listFiles, 'scan=clean', clean.items, ({ scan }) => scan.status === 'clean');
                const problems = await world.owner.ok(R.listFiles, { query: { scan: 'infected,failed', limit: 50 } });
                checkFilter(
                    findings,
                    R.listFiles,
                    'scan=infected,failed',
                    problems.items,
                    ({ scan }) => scan.status === 'infected' || scan.status === 'failed',
                );
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.files.download-attachment',
        suite: SUITE,
        title: 'File content comes back byte for byte, as an attachment with nosniff, for the file and each version',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.files);
            const findings = new Findings();
            const text = `conformance ${randomToken(ctx.random, 12)}\n`;
            const file = await upload(world, 'download', text);
            if (file.scan.status === 'infected') skip('the engine’s scanner flagged a plain text upload');
            const params = { fileId: file.id };
            const [version] = (await world.owner.ok(R.listFileVersions, { params })).items;
            const requests = [
                { params },
                ...(version === undefined ? [] : [{ params, query: { version: version.id } }]),
            ];
            for (const request of requests) {
                const response = await world.owner.send(R.downloadFile, request);
                const where = `GET /files/{fileId}/content${request.query === undefined ? '' : '?version='}`;
                if (response.status !== 200) {
                    findings.add(`${where}: status ${String(response.status)}`);
                    continue;
                }
                if (!/^attachment\b/i.test(response.headers.get('content-disposition') ?? '')) {
                    findings.add(`${where}: Content-Disposition is not attachment`);
                }
                if (response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
                    findings.add(`${where}: X-Content-Type-Options is not nosniff`);
                }
                if (decoder.decode(response.bytes) !== text)
                    findings.add(`${where}: the content differs from the upload`);
            }
            if (version === undefined) findings.add('GET /files/{fileId}/versions: an uploaded file has no version');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.files.infected-refused',
        suite: SUITE,
        title: 'An infected file is never downloadable: 409 file-infected, without its bytes',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.files);
            const [infected] = (await world.owner.ok(R.listFiles, { query: { scan: 'infected', limit: 1 } })).items;
            if (infected === undefined) skip('the engine lists no infected file to try');
            const findings = new Findings();
            const params = { fileId: infected.id };
            await attempt(findings, async () => {
                await world.owner.problem(R.downloadFile, { params }, 'file-infected');
            });
            const [version] = (await world.owner.ok(R.listFileVersions, { params })).items;
            if (version !== undefined) {
                await attempt(findings, async () => {
                    const result = await world.owner.call(R.downloadFile, { params, query: { version: version.id } });
                    if (result.kind === 'ok')
                        fail('GET /files/{fileId}/content?version=: an infected version came back');
                    if (result.problem.code !== 'file-infected') {
                        fail(`GET /files/{fileId}/content?version=: got ${result.problem.code}, not file-infected`);
                    }
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.files.stats',
        suite: SUITE,
        title: 'GET /files/stats counts every file once by purpose and once by scan status, and counts a new upload',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.files);
            const findings = new Findings();
            const check = (stats: FileStats, when: string): void => {
                if (total(stats.byPurpose) !== total(stats.byScan)) {
                    findings.add(`GET /files/stats ${when}: the purpose and scan counts add up to different totals`);
                }
            };
            const before = await world.owner.ok(R.getFileStats, {});
            check(before, 'before an upload');
            await upload(world, 'stats', 'stats\n');
            const after = await world.owner.ok(R.getFileStats, {});
            check(after, 'after an upload');
            if (after.byPurpose.upload < before.byPurpose.upload + 1) {
                findings.add('GET /files/stats: an upload is not counted under byPurpose.upload');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.files.upload-policy',
        suite: SUITE,
        title: 'Every purpose has an upload policy, and an upload over its size or outside its types is refused',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.files);
            const findings = new Findings();
            const policies: FileUploadPolicy[] = [];
            for (const purpose of FILE_PURPOSES) {
                const policy = await world.owner.ok(R.getFileUploadPolicy, { query: { purpose } });
                if (policy.purpose !== purpose) {
                    findings.add(`GET /files/upload-policy?purpose=${purpose}: answered for ${policy.purpose}`);
                }
                policies.push(policy);
            }
            const unaccepted = { name: `${world.name('unaccepted')}${UNACCEPTED.extension}`, type: UNACCEPTED.type };
            const strict = policies.find(({ accept }) => accept.length > 0 && !acceptsFile(accept, unaccepted));
            if (strict !== undefined) {
                await attempt(findings, () =>
                    expectRefusedUpload(
                        world,
                        findings,
                        form(strict.purpose, new Blob(['x'], { type: unaccepted.type }), unaccepted.name),
                        'unsupported-media-type',
                        `a ${strict.purpose} file of a type its policy does not accept`,
                    ),
                );
            }
            const [smallest] = [...policies].sort((a, b) => a.maxBytes - b.maxBytes);
            if (smallest !== undefined) {
                const sample = acceptedSample(world, 'too-large', smallest.accept);
                await attempt(findings, () =>
                    expectRefusedUpload(
                        world,
                        findings,
                        form(
                            smallest.purpose,
                            new Blob([new Uint8Array(smallest.maxBytes + 1)], { type: sample.type }),
                            sample.name,
                        ),
                        'payload-too-large',
                        `a ${smallest.purpose} file one byte over its policy's maxBytes`,
                    ),
                );
            }
            return findings.outcome();
        },
    },
];
