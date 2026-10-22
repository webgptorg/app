// Flow 14: files. A knowledge upload is scanned and then downloads as an attachment; the seeded infected file offers no
// download; no file other than a raster image is ever rendered inline.
import type { Page } from '@playwright/test';

import { apiCall, apiList, required } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

interface FileMetadata {
    readonly id: string;
    readonly name: string;
    readonly contentType: string;
    readonly scan: { readonly status: string };
}

const RASTER = /^image\/(?:png|jpeg|gif|webp|avif)$/;
const INLINE_ELEMENTS = 'img, object, iframe, embed, video, audio, svg image';

async function contentDisposition(page: Page, fileId: string): Promise<string | null> {
    return page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/files/${id}/content`);
        await response.body?.cancel();
        return response.headers.get('content-disposition');
    }, fileId);
}

test('an uploaded knowledge file is scanned clean and downloads as an attachment', async ({ page, signIn, appUrl }) => {
    test.setTimeout(60_000);
    const name = `notes-${crypto.randomUUID().slice(0, 8)}.md`;
    await signIn();
    await page.goto(appUrl('/'));
    const agent = required((await apiList<{ id: string }>(page, '/agents'))[0], 'agent');
    await page.goto(appUrl(`/agents/${agent.id}/files`));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose files' }).click();
    await (
        await chooser
    ).setFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nPlain text.\n') });
    await expect(page.getByRole('list', { name: 'Uploads' }).getByText('Uploaded')).toBeVisible();

    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
    // The mock engine scans an upload as it stores it; an engine with a slower scanner shows "Scanning" first.
    await expect(row.getByText(/^(Scanning|Clean)$/)).toBeVisible();
    await expect(row.getByText('Clean', { exact: true })).toBeVisible();

    const uploaded = required(
        (await apiList<FileMetadata>(page, `/files?agentId=${agent.id}`)).find((file) => file.name === name),
        'uploaded file',
    );
    expect(uploaded.scan.status).toBe('clean');
    await row.getByRole('link', { name, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'File details' });
    await expect(drawer.locator(INLINE_ELEMENTS)).toHaveCount(0);
    const download = page.waitForEvent('download');
    await drawer.getByRole('link', { name: `Download ${name}`, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(name);
    expect(await contentDisposition(page, uploaded.id)).toMatch(/^attachment\b/);
});

test('the seeded infected file offers no download', async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/'));
    const infected = required((await apiList<FileMetadata>(page, '/files?scan=infected'))[0], 'infected file');
    await page.goto(appUrl(`/files?file=${infected.id}`));
    const drawer = page.getByRole('dialog', { name: 'File details' });
    await expect(drawer.getByRole('button', { name: `Download ${infected.name}`, exact: true })).toHaveAttribute(
        'aria-disabled',
        'true',
    );
    await expect(drawer.getByRole('link', { name: `Download ${infected.name}`, exact: true })).toHaveCount(0);
    await expect(drawer.locator(INLINE_ELEMENTS)).toHaveCount(0);
    expect((await apiCall(page, 'GET', `/files/${infected.id}/content`)).status).not.toBe(200);
});

test('only raster images are ever rendered inline', async ({ page, signIn, appUrl }) => {
    test.setTimeout(90_000);
    await signIn();
    await page.goto(appUrl('/'));
    const files = await apiList<FileMetadata>(page, '/files');
    const kinds = new Map<string, FileMetadata>();
    for (const file of files) if (!kinds.has(file.contentType)) kinds.set(file.contentType, file);
    expect(
        [...kinds.keys()].some((type) => !RASTER.test(type)),
        'the seed has non-raster files',
    ).toBe(true);

    for (const file of kinds.values()) {
        await page.goto(appUrl(`/files?file=${file.id}`));
        const drawer = page.getByRole('dialog', { name: 'File details' });
        await expect(drawer.getByText(file.name).first()).toBeVisible();
        if (RASTER.test(file.contentType) && file.scan.status === 'clean') continue;
        await expect(drawer.locator(INLINE_ELEMENTS), `${file.contentType} is not rendered`).toHaveCount(0);
    }
});
