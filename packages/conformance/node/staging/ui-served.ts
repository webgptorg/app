import { createHash } from 'node:crypto';

import type { ReadSecurityOverview } from '@ptbk/engine-api';
import { compareEngineVersions } from '@ptbk/protocol';

import type { Fetched } from './bounded-get';
import { mediaType } from './bounded-get';
import type { StagingContext } from './context';
import { COOKIE_FIX, COOKIE_REFUSED_FIX } from './context';
import type { JsonRead } from './session';
import { SECURITY_PATH } from './session';
import type { CheckedRelease } from './ui-release';
import type { StagingResult } from './types';

const ID = 'staging.ui.served';
const ASSET_REFERENCE = /\b(?:src|href)="(\/assets\/[A-Za-z0-9._/-]+)"/g;
export const NO_UI_FIX =
    'no verified UI release: start the engine with PTBK_UI_RELEASE_URL=https://ui.ptbk.link/ and PTBK_UI_TRUST_POLICY_FILE=<absolute path to apps/engine-ui/release/trust-policy.staging.json> outside production (NODE_ENV not production); releases install about 5 minutes after the engine first sees them';

/**
 * What a signed-in browser loads is the release, byte for byte: the entry page and the first script and stylesheet it
 * references hash to the manifest's entries, and the engine's own report names the same version and archive.
 */
export async function checkUiServed(
    ctx: StagingContext,
    signedInRoot: Fetched | null,
    security: JsonRead<ReadSecurityOverview> | null,
    release: CheckedRelease | null,
): Promise<StagingResult> {
    if (signedInRoot === null || security === null) {
        return { id: ID, status: 'skip', detail: 'needs an owner session', fix: COOKIE_FIX };
    }
    if (signedInRoot.kind === 'failed') return fail(`GET /: ${signedInRoot.reason}`, NO_UI_FIX);
    if (signedInRoot.status === 401 || (signedInRoot.status >= 300 && signedInRoot.status < 400)) {
        return fail(`GET / with the owner cookie answered ${String(signedInRoot.status)}`, COOKIE_REFUSED_FIX);
    }
    const lastCheck = security.kind === 'ok' ? lastUpdateCheck(security.value) : '';
    const type = mediaType(signedInRoot);
    if (signedInRoot.status !== 200 || type !== 'text/html') {
        const answer = `${String(signedInRoot.status)}${type === null ? '' : ` ${type}`}`;
        return fail(`GET / answered ${answer}, not the UI's index.html${lastCheck}`, NO_UI_FIX);
    }
    if (release === null) {
        return {
            id: ID,
            status: 'skip',
            detail: 'needs a release from staging.ui.release',
            fix: 'fix staging.ui.release first',
        };
    }
    if (security.kind === 'problem') {
        return fail(security.detail, `answer GET ${SECURITY_PATH} with SecurityOverview from @ptbk/engine-api`);
    }
    const ui = security.value.ui;
    if (String(ui.version) !== String(release.version)) {
        return fail(
            `the engine reports UI ${ui.version}, which is not a release in ${ctx.options.releaseUrl.href}${lastCheck}`,
            NO_UI_FIX,
        );
    }
    if (ui.bundleSha256 !== release.artifact.sha256) {
        return fail(
            `the engine reports bundle ${ui.bundleSha256} for UI ${ui.version}, but the release's ui artifact is ${release.artifact.sha256}`,
            'report the SHA-256 of the installed ui archive as ui.bundleSha256 in GET /api/v1/security',
        );
    }

    const servedFix = `serve exactly the files of the installed release: GET / is the manifest's index.html and /assets/* the files under assets/, unmodified`;
    const indexProblem = compare('index.html', signedInRoot.body, release);
    if (indexProblem !== null) return fail(indexProblem, servedFix);
    const assets = referencedAssets(new TextDecoder().decode(signedInRoot.body));
    for (const path of assets) {
        const fetched = await ctx.engineGet(path, 'asset', true);
        if (fetched.kind === 'failed') return fail(`GET ${path}: ${fetched.reason}`, servedFix);
        if (fetched.status !== 200) return fail(`GET ${path} answered ${String(fetched.status)}`, servedFix);
        const problem = compare(path.slice(1), fetched.body, release);
        if (problem !== null) return fail(problem, servedFix);
    }
    const older =
        compareEngineVersions(release.version, release.latest) < 0
            ? `; older than the latest ${release.latest}, which installs after the release delay${lastCheck}`
            : '';
    return {
        id: ID,
        status: 'pass',
        detail: `UI ${release.version}: index.html and ${String(assets.length)} assets match the manifest${older}`,
    };
}

function fail(detail: string, fix: string): StagingResult {
    return { id: ID, status: 'fail', detail, fix };
}

function compare(path: string, body: Uint8Array, release: CheckedRelease): string | null {
    const file = release.manifest.files.find((candidate) => candidate.path === path);
    if (file === undefined) return `${path} is served but not in the manifest of UI ${release.version}`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    return sha256 === file.sha256 ? null : `${path} differs from the manifest of UI ${release.version}`;
}

/** The first script and the first stylesheet the entry page loads, enough to show the bundle is the release's. */
export function referencedAssets(html: string): readonly string[] {
    const paths = [...html.matchAll(ASSET_REFERENCE)].map((match) => match[1] ?? '');
    const script = paths.find((path) => path.endsWith('.js'));
    const style = paths.find((path) => path.endsWith('.css'));
    return [script, style].filter((path) => path !== undefined);
}

function lastUpdateCheck(security: ReadSecurityOverview): string {
    const check = security.ui.lastUpdateCheck;
    if (check === null) return '; the engine has not checked the store yet';
    const reason = check.reason === null ? '' : `: ${check.reason}`;
    const eligible = check.eligibleAt === null ? '' : `, eligible at ${check.eligibleAt}`;
    return `; last update check ${check.at}: ${check.outcome}${check.version === null ? '' : ` ${check.version}`}${reason}${eligible}`;
}
