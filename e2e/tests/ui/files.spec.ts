// Flow 14: files. A knowledge upload downloads as an attachment; the mock engine does not scan by default
// (`file-scanning@1` is optional), so nothing about scans shows; no file other than a raster image is rendered inline.
import type { Page } from '@playwright/test';

import { apiList, required } from '../../src/ui-app.ts';
import { expect, test } from '../../src/ui-fixtures.ts';

interface FileMetadata {
    readonly id: string;
    readonly name: string;
    readonly contentType: string;
    readonly scan: { readonly status: string } | null;
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

test('an uploaded knowledge file downloads as an attachment, with no scan status', async ({ page, signIn, appUrl }) => {
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
    await expect(row).toBeVisible();
    await expect(row.getByText(/^(Scanning|Clean)$/)).toHaveCount(0);

    const uploaded = required(
        (await apiList<FileMetadata>(page, `/files?agentId=${agent.id}`)).find((file) => file.name === name),
        'uploaded file',
    );
    expect(uploaded.scan).toBeNull();
    await row.getByRole('link', { name, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'File details' });
    await expect(drawer.locator(INLINE_ELEMENTS)).toHaveCount(0);
    const download = page.waitForEvent('download');
    await drawer.getByRole('link', { name: `Download ${name}`, exact: true }).click();
    expect((await download).suggestedFilename()).toBe(name);
    expect(await contentDisposition(page, uploaded.id)).toMatch(/^attachment\b/);
});

test('an engine without a scanner reports no scan results and filters none', async ({ page, signIn, appUrl }) => {
    await signIn();
    await page.goto(appUrl('/'));
    const files = await apiList<FileMetadata>(page, '/files');
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.scan === null)).toBe(true);
    expect(await apiList<FileMetadata>(page, '/files?scan=infected')).toEqual([]);
    await page.goto(appUrl('/files'));
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Scan' })).toHaveCount(0);
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
        if (RASTER.test(file.contentType) && (file.scan === null || file.scan.status === 'clean')) continue;
        await expect(drawer.locator(INLINE_ELEMENTS), `${file.contentType} is not rendered`).toHaveCount(0);
    }
});
