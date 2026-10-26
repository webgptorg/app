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

// The built app with the dev config: the `none` plan cannot link engines, the fake Checkout's `standard` plan can.
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
    await expect(page.getByRole('heading', { name: 'Your engines' })).toBeVisible();

    await page.getByRole('link', { name: 'Link an engine' }).click();
    await expect(page.getByRole('heading', { name: 'Link an engine', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Create link code' }).click();
    await expect(page.getByRole('link', { name: 'Go to billing' })).toBeVisible();
    await checkScreen('/engines/new not entitled');

    await page.getByRole('link', { name: 'Go to billing' }).click();
    await page.getByRole('button', { name: 'Subscribe to Standard' }).click();
    await expect(page).toHaveURL(/\/billing\?checkout=success$/);

    await page.goto('/engines/new');
    await page.getByRole('button', { name: 'Create link code' }).click();
    const command = page.getByText(/^bun run dev:link [a-z2-7]{26}$/);
    await expect(command).toBeVisible();
    await expect(page.getByText(/^Expires in \d+:\d\d$/)).toBeVisible();
    await checkScreen('/engines/new install command');

    // The engine side, as M-06 does it: register with the code, then one signed heartbeat.
    const linkCode = LinkCode.parse((await command.textContent())?.split(' ').at(-1));
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const engineId = await deriveEngineId(signer.publicKey());
    const registration = await signRegistration(signer, {
        linkCode,
        engineVersion: EngineVersion.parse('1.0.0'),
        mode: 'tunnel',
    });
    expect((await page.request.post(REGISTER_PATH, { data: registration })).status()).toBe(200);
    const heartbeat = buildHeartbeat({
        engineId,
        seq: Date.now(),
        ts: Timestamp.parse(new Date().toISOString()),
        version: EngineVersion.parse('1.0.0'),
        uptimeS: 60,
        diskPct: 40,
        ramPct: 60,
        cpuLoad: 'low',
        update: 'none',
        agents: 1,
        members: 1,
    });
    const beat = await page.request.post(heartbeatPath(engineId), {
        data: Buffer.from(heartbeat),
        headers: {
            'Content-Type': 'application/json',
            [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(signer, heartbeat),
        },
    });
    expect(beat.status()).toBe(204);

    await page.goto('/engines');
    await expect(page.getByText('Online')).toBeVisible();
    const open = page.getByRole('link', { name: /^Open engine/ });
    await expect(open).toHaveAttribute('href', `https://${engineId}.${ENGINE_DOMAIN}/`);
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(open).toHaveAttribute('referrerpolicy', 'no-referrer');
    await checkScreen('/engines');

    await page.getByRole('link', { name: `${engineId.slice(0, 8)}…` }).click();
    await expect(page.getByRole('heading', { name: 'Last heartbeat' })).toBeVisible();
    await checkScreen('/engines/$engineId');

    await page.getByRole('button', { name: 'Revoke engine' }).click();
    const dialog = page.getByRole('dialog', { name: `Revoke engine ${engineId.slice(0, 8)}?` });
    // axe measures colours as rendered, so the dialog's opening animation has to be over; and it is checked before
    // typing, since enabling the confirm button starts a colour transition too.
    await dialog.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    await checkScreen('/engines/$engineId revoke dialog');
    await dialog.getByRole('textbox').fill(engineId.slice(0, 8));
    await dialog.getByRole('button', { name: 'Revoke permanently' }).click();
    // A sign-up is no step-up, so the API asks for one and the step-up dialog runs in place.
    await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Use passkey' }).click();
    await expect(page.getByText(/You revoked this engine/)).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open engine/ })).toHaveCount(0);

    expectNoBrowserErrors(browserReport());
});
