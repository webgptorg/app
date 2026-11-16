// Flow 9: what a session may do is what the UI offers. A member without some permissions sees neither the actions nor
// the nav items and gets "no access" and 403s; each role sees exactly what its permissions allow; without a session
// every route leads to sign-in, no engine-ui file is served and the API answers 401.
import { PERMISSIONS, SIGN_IN_PATH } from '@ptbk/engine-api';
import type { Permission, Role } from '@ptbk/engine-api';
import type { Page } from '@playwright/test';

import { apiCall, apiGet, apiList, openRowMenu, required } from '../../src/ui-app.ts';
import { downloadUiRelease } from '../../src/ui-release.ts';
import { UI_RELEASES } from '../../src/stack.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

const WITHHELD: readonly Permission[] = ['agents.delete', 'wallet.read', 'wallet.manage', 'audit.read'];

/** The sidebar entries engine-ui gates by permission (its feature registry); Home, Security and Settings are everyone's. */
const NAV_PERMISSIONS: Readonly<Record<string, Permission>> = {
    Agents: 'agents.read',
    Tasks: 'tasks.read',
    Runs: 'runs.read',
    Files: 'files.read',
    Triggers: 'triggers.read',
    Integrations: 'integrations.read',
    Members: 'members.read',
    Wallet: 'wallet.read',
    'Audit log': 'audit.read',
};

const ROUTES = [
    '/',
    '/agents',
    '/agents/new',
    '/tasks',
    '/runs',
    '/files',
    '/triggers',
    '/integrations',
    '/security',
    '/wallet',
    '/audit',
    '/members',
    '/settings',
];

function navLink(page: Page, label: string) {
    return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label, exact: true });
}

test('a member without delete, Wallet and audit permissions is offered none of them', async ({
    page,
    signIn,
    appUrl,
}) => {
    await signIn({ kind: 'member', permissions: PERMISSIONS.filter((permission) => !WITHHELD.includes(permission)) });
    await page.goto(appUrl('/agents?view=table'));
    await expect(navLink(page, 'Agents')).toBeVisible();
    await expect(navLink(page, 'Wallet')).toHaveCount(0);
    await expect(navLink(page, 'Audit log')).toHaveCount(0);

    const agent = required((await apiList<{ id: string; name: string }>(page, '/agents'))[0], 'agent');
    const actions = page.getByRole('button', { name: `Actions for ${agent.name}`, exact: true });
    if ((await actions.count()) > 0) {
        await expect((await openRowMenu(page, agent.name)).getByRole('menuitem', { name: 'Delete agent' })).toHaveCount(
            0,
        );
        await page.keyboard.press('Escape');
    }

    for (const path of ['/wallet', '/audit']) {
        await page.goto(appUrl(path));
        await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
    }
    expect((await apiCall(page, 'DELETE', `/agents/${agent.id}`)).status).toBe(403);
    expect((await apiCall(page, 'GET', '/wallet')).status).toBe(403);
    expect(
        (
            await apiCall(page, 'POST', '/wallet/records', {
                origin: 'http://not-allowed.test',
                username: 'x',
                password: 'x',
            })
        ).status,
    ).toBe(403);
    expect((await apiCall(page, 'GET', '/audit')).status).toBe(403);
});

for (const role of ['admin', 'member', 'viewer'] as const satisfies readonly Role[]) {
    test(`a ${role} sees exactly the sections the role's permissions allow`, async ({ page, signIn, appUrl }) => {
        await signIn({ kind: 'member', role });
        await page.goto(appUrl('/'));
        const me = await apiGet<{ role: Role; permissions: readonly Permission[] }>(page, '/me');
        expect(me.role).toBe(role);
        await expect(navLink(page, 'Home')).toBeVisible();
        await expect(navLink(page, 'Security')).toBeVisible();
        for (const [label, permission] of Object.entries(NAV_PERMISSIONS)) {
            await expect(navLink(page, label), `${label} for a ${role}`).toHaveCount(
                me.permissions.includes(permission) ? 1 : 0,
            );
        }
        if (!me.permissions.includes('audit.read')) {
            await page.goto(appUrl('/audit'));
            await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
        }
    });
}

test('without a session every route leads to sign-in, no UI file is served and the API answers 401', async ({
    page,
    appUrl,
    caCertificatePem,
}) => {
    for (const path of ROUTES) {
        await page.goto(appUrl(path));
        expect(new URL(page.url()).pathname, path).toBe(SIGN_IN_PATH);
        await expect(page.locator('html[data-ui-version]')).toHaveCount(0);
    }

    const release = await downloadUiRelease(UI_RELEASES.installed, caCertificatePem);
    const served = await page.evaluate(
        async (paths) => {
            const hex = (buffer: ArrayBuffer) =>
                Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
            return Promise.all(
                paths.map(async (path) => {
                    const response = await fetch(`/${path}`, { cache: 'no-store' });
                    return hex(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
                }),
            );
        },
        release.manifest.files.map((file) => file.path),
    );
    const bundleHashes = new Set(release.manifest.files.map((file) => file.sha256));
    expect(served.filter((hash) => bundleHashes.has(hash))).toEqual([]);

    for (const path of ['/engine', '/me', '/agents', '/wallet', '/audit', '/runs', '/security']) {
        const answer = await apiCall<{ code?: string }>(page, 'GET', path);
        expect(answer.status, path).toBe(401);
    }
});
