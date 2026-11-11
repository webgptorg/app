import {
    buildHeartbeat,
    createWebCryptoSigner,
    deriveEngineId,
    EngineVersion,
    generateEd25519KeyPair,
    HEARTBEAT_SIGNATURE_HEADER,
    heartbeatPath,
    LinkCode,
    REGISTER_PATH,
    signHeartbeat,
    signRegistration,
    Timestamp,
} from '@ptbk/protocol';

import { expect, expectNoBrowserErrors, outboxLink, test, uniqueEmail } from './fixtures.ts';

const ENGINE_DOMAIN = 'engines.ptbk.test';

// The built app with the dev config: the `none` plan cannot link engines, the fake Checkout's `standard` plan (with its
// trial) can.
test('link an engine, see it online, open its page and revoke it, under the production CSP', async ({
    page,
    authenticators,
    browserReport,
    checkScreen,
}) => {
    await authenticators.add();
    const email = uniqueEmail('engines');
    await page.goto('/signup');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await page.goto(await outboxLink(page.request, email, 'signup-link'));
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Engines', level: 1 })).toBeVisible();

    await page.goto('/engines/all');
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();
    await page.getByRole('link', { name: 'Link an engine' }).click();
    await expect(page.getByRole('heading', { name: 'Link an engine', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a plan to link your engine' })).toBeVisible();
    await checkScreen('/engines/new plan step');

    // The fake Checkout starts the dev plan's trial and comes back here, where the code is issued without a click.
    await page.getByRole('button', { name: 'Start your 14-day trial of Standard' }).click();
    await expect(page.getByText('Thank you, your trial has started.')).toBeVisible();
    const command = page.getByText(/^bun run dev:link [a-z2-7]{26}$/);
    await expect(command).toBeVisible();
    await expect(page).toHaveURL(/\/engines\/new\?.*link=[a-z2-7]{26}/);
    await expect(page.getByText(/^Copy it now: it is shown only once and works until .+\.$/)).toBeVisible();
    const progress = page.locator('section[data-link-state]');
    await expect(progress).toHaveAttribute('data-link-state', 'waiting');
    await checkScreen('/engines/new install command');
    await expect(page.getByRole('link', { name: /^How Promptbook protects you/ })).toHaveAttribute('href', '/trust');
    for (const tab of ['Docker Compose', 'Already running Promptbook']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('tabpanel', { name: tab }).locator('pre code')).toContainText(/[a-z2-7]{26}/);
        await checkScreen(`/engines/new ${tab} tab`);
    }
    await page.getByRole('tab', { name: 'Linux server with Docker' }).click();

    // The engine side, as M-06 does it: register with the code, then signed heartbeats.
    const linkCode = LinkCode.parse((await command.textContent())?.split(' ').at(-1));
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const engineId = await deriveEngineId(signer.publicKey());
    const registration = await signRegistration(signer, {
        linkCode,
        engineVersion: EngineVersion.parse('1.0.0'),
        mode: 'tunnel',
    });
    expect((await page.request.post(REGISTER_PATH, { data: registration })).status()).toBe(200);
    await expect(progress).toHaveAttribute('data-link-state', 'linked');
    await expect(command).toHaveCount(0);
    await expect(progress.getByText(`${engineId}.${ENGINE_DOMAIN}`)).toBeVisible();
    await checkScreen('/engines/new linked');

    let seq = Date.now();
    async function beat(members: number): Promise<void> {
        const heartbeat = buildHeartbeat({
            engineId,
            seq: seq++,
            ts: Timestamp.parse(new Date().toISOString()),
            version: EngineVersion.parse('1.0.0'),
            uptimeS: 60,
            diskPct: 40,
            ramPct: 60,
            cpuLoad: 'low',
            update: 'none',
            agents: 1,
            members,
        });
        const response = await page.request.post(heartbeatPath(engineId), {
            data: Buffer.from(heartbeat),
            headers: {
                'Content-Type': 'application/json',
                [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(signer, heartbeat),
            },
        });
        expect(response.status()).toBe(204);
    }

    // Until the owner's first passkey the engine counts no member (M-08).
    await beat(0);
    await expect(progress).toHaveAttribute('data-link-state', 'owner-pending');
    await expect(progress.getByText('Engine online, version 1.0.0.', { exact: true }).first()).toBeVisible();
    await checkScreen('/engines/new owner pending');

    await beat(1);
    await expect(progress).toHaveAttribute('data-link-state', 'ready');
    const ready = progress.getByRole('link', { name: /^Open engine/ });
    await expect(ready).toHaveAttribute('href', `https://${engineId}.${ENGINE_DOMAIN}/`);
    await expect(ready).toHaveAttribute('rel', 'noopener noreferrer');
    await checkScreen('/engines/new ready');

    // On a phone the fingerprint code wraps under the seal; both stay centred in the panel.
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 375, height: 812 });
    const panelBox = await page.locator('[data-link-ready]').boundingBox();
    const sealBox = await page.locator('[data-link-ready] svg[data-state]').boundingBox();
    expect(panelBox).not.toBeNull();
    expect(sealBox).not.toBeNull();
    const centreOf = (box: { readonly x: number; readonly width: number } | null) =>
        (box?.x ?? 0) + (box?.width ?? 0) / 2;
    expect(Math.abs(centreOf(sealBox) - centreOf(panelBox))).toBeLessThan(2);
    if (desktop !== null) await page.setViewportSize(desktop);

    await page.goto('/engines/all');
    await expect(page.getByText('Online')).toBeVisible();
    const open = page.getByRole('link', { name: /^Open engine/ });
    await expect(open).toHaveAttribute('href', `https://${engineId}.${ENGINE_DOMAIN}/`);
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(open).toHaveAttribute('referrerpolicy', 'no-referrer');
    await checkScreen('/engines');

    await page.getByRole('link', { name: `${engineId.slice(0, 8)}…`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Last heartbeat' })).toBeVisible();
    await checkScreen('/engines/$engineId');

    await page.getByRole('button', { name: /^Actions for engine/ }).click();
    await page.getByRole('menuitem', { name: 'Revoke engine' }).click();
    const dialog = page.getByRole('dialog', { name: `Revoke engine ${engineId.slice(0, 8)}…?` });
    // axe measures colours as rendered, so the dialog's opening animation has to be over; and it is checked before
    // typing, since enabling the confirm button starts a colour transition too.
    await dialog.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    await checkScreen('/engines/$engineId revoke dialog');
    await dialog.getByRole('textbox').fill(engineId.slice(0, 8));
    // A sign-up is no step-up, so the confirm button runs the passkey check itself, without a second dialog.
    await dialog.getByRole('button', { name: 'Revoke with passkey' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toHaveCount(0);
    await expect(page.getByText(/You revoked this engine/)).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open engine/ })).toHaveCount(0);

    expectNoBrowserErrors(browserReport());
});
