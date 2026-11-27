import type { EngineApiResponse, FileMetadata, UploadOptions } from '@ptbk/engine-api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createFilesEngine } from '../../testing/files-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
/** The first render loads the agent route and the upload policy, slower than the default wait on a busy runner. */
const FIRST_RENDER_MS = 10_000;

/** The picker's input: hidden, since the visible "Choose files" button is the one control people use. */
function fileInput(scope: HTMLElement): HTMLInputElement {
    const input = scope.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    return input;
}

const notes = () => new File(['# Notes'], 'notes.md', { type: '' });

async function agentTab(engine = createFilesEngine()) {
    const app = renderWithProviders({ path: '/agents/agent-ada/files', engineApi: engine.client });
    await screen.findByRole('button', { name: 'Choose files' }, { timeout: FIRST_RENDER_MS });
    const input = fileInput(document.body);
    return { app, engine, input };
}

/** An upload the test drives: progress comes when the test sends it, the engine's answer when it calls `finish`. */
function controlledUpload(engine: ReturnType<typeof createFilesEngine>) {
    const state: { options?: UploadOptions; signal?: AbortSignal; finish?: () => void } = {};
    engine.spies.upload.mockImplementation(
        (body, signal, options) =>
            new Promise<EngineApiResponse<FileMetadata>>((resolve, reject) => {
                state.options = options ?? {};
                state.signal = signal;
                const answer = engine.original.upload(body, AbortSignal.timeout(5_000));
                state.finish = () => {
                    void answer.then(resolve);
                };
                signal.addEventListener('abort', () => {
                    reject(signal.reason as Error);
                });
            }),
    );
    return state;
}

describe('knowledge upload', { timeout: TIMEOUT_MS }, () => {
    it('shows the engine’s limits and takes files with the picker', async () => {
        const { input } = await agentTab();
        expect(screen.getByText('Up to 1 kB per file. Accepted: .md, text/plain')).toBeDefined();
        expect(input.getAttribute('accept')).toBe('.md,text/plain');
    });

    it('reports progress, then success, and lists the new knowledge', async () => {
        const { app, engine, input } = await agentTab();
        const upload = controlledUpload(engine);
        await app.user.upload(input, notes());
        const list = await screen.findByRole('list', { name: 'Uploads' });
        await waitFor(() => {
            expect(upload.options?.onProgress).toBeDefined();
        });
        upload.options?.onProgress?.({ loadedBytes: 40, totalBytes: 100 });
        const progress = await within(list).findByRole('progressbar', { name: 'Upload progress of notes.md' });
        await waitFor(() => {
            expect(progress.getAttribute('value')).toBe('40');
        });
        expect(progress.getAttribute('max')).toBe('100');
        expect(engine.spies.upload.mock.calls[0]?.[0]).toMatchObject({
            name: 'notes.md',
            purpose: 'knowledge',
            agentId: 'agent-ada',
        });
        expect(within(list).getByText('Uploading…')).toBeDefined();
        upload.finish?.();
        expect(await within(list).findByText('Uploaded')).toBeDefined();
        expect(await screen.findByRole('link', { name: 'notes.md' })).toBeDefined();
    });

    it('cancels an upload in flight', async () => {
        const { app, engine, input } = await agentTab();
        const upload = controlledUpload(engine);
        await app.user.upload(input, notes());
        await app.user.click(await screen.findByRole('button', { name: 'Cancel uploading notes.md' }));
        expect(await screen.findByText('Cancelled')).toBeDefined();
        expect(upload.signal?.aborted).toBe(true);
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('rejects an over-limit file and a type the engine does not accept before uploading anything', async () => {
        const { engine } = await agentTab();
        const large = new File(['x'.repeat(1001)], 'large.md');
        const image = new File(['x'], 'photo.png', { type: 'image/png' });
        const zone = screen.getByText('Drop files here, or').parentElement as HTMLElement;
        fireEvent.drop(zone, { dataTransfer: { files: [large, image] } });
        expect(await screen.findByText('Too large: the project accepts up to 1 kB. Not uploaded.')).toBeDefined();
        expect(screen.getByText('This type of file is not accepted as knowledge. Not uploaded.')).toBeDefined();
        expect(engine.spies.upload).not.toHaveBeenCalled();
    });

    it('takes dropped files', async () => {
        const { engine } = await agentTab();
        const zone = screen.getByText('Drop files here, or').parentElement as HTMLElement;
        const transfer = { files: [notes()] };
        fireEvent.dragOver(zone, { dataTransfer: transfer });
        fireEvent.drop(zone, { dataTransfer: transfer });
        expect(await screen.findByText('Uploaded')).toBeDefined();
        expect(engine.spies.upload).toHaveBeenCalledTimes(1);
    });

    it('shows an upload the engine refuses, and a failed one', async () => {
        const { app, engine, input } = await agentTab();
        engine.spies.upload.mockImplementationOnce(() => problemResponse('unsupported-media-type'));
        engine.spies.upload.mockImplementationOnce(() => Promise.reject(new TypeError('offline')));
        await app.user.upload(input, [notes(), new File(['b'], 'second.md')]);
        expect(await screen.findByText('This type of file is not accepted as knowledge. Not uploaded.')).toBeDefined();
        expect(await screen.findByText('Upload failed')).toBeDefined();
    });

    it('says when the limits cannot be loaded, and retries', async () => {
        const engine = createFilesEngine();
        engine.spies.uploadPolicy.mockImplementation(() => problemResponse('validation-failed'));
        const app = renderWithProviders({ path: '/agents/agent-ada/files', engineApi: engine.client });
        expect(await screen.findByText('Could not load the upload limits')).toBeDefined();
        engine.spies.uploadPolicy.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('button', { name: 'Choose files' })).toBeDefined();
    });

    it('passes axe with files in every state', async () => {
        const { app, input } = await agentTab();
        await app.user.upload(input, [notes(), new File(['x'.repeat(1001)], 'large.md')]);
        await screen.findByText('Uploaded');
        await expectNoAxeViolations(document.body);
    });
});

describe('upload from the files page', { timeout: TIMEOUT_MS }, () => {
    it('asks for the agent first, then uploads knowledge for it', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'Upload knowledge' }));
        const dialog = await screen.findByRole('dialog', { name: 'Upload knowledge' });
        expect(within(dialog).getByText('Choose the agent the knowledge is for.')).toBeDefined();
        await app.user.click(await within(dialog).findByRole('combobox', { name: /^Agent/ }));
        await app.user.click(await screen.findByRole('option', { name: 'Grace' }));
        await within(dialog).findByRole('button', { name: 'Choose files' });
        await app.user.upload(fileInput(dialog), notes());
        expect(await within(dialog).findByText('Uploaded')).toBeDefined();
        expect(engine.spies.upload.mock.calls[0]?.[0]).toMatchObject({ agentId: 'agent-grace' });
        expect(app.router.state.location.search).toMatchObject({ upload: true });
        await app.user.keyboard('{Escape}');
        await waitFor(() => {
            expect(app.router.state.location.search).not.toHaveProperty('upload');
        });
    });
});
