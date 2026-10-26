import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { setMedia } from '@ptbk/ui';
import vectors from '@ptbk/protocol/fingerprint-vectors.json';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const AT = '2026-10-01T11:00:00Z';
const SHA = 'ab'.repeat(32);
/** Unusual key order, spacing and a trailing newline: the panel must show these bytes, not a re-serialisation. */
const RAW_HEARTBEAT = '{ "members":2,"v" :1,\n  "seq":   17, "engineId":"memoryengine234567abcdefgh"  }\n';
const SIGNATURE = `ed25519=${'A'.repeat(86)}`;

const FULL_OVERVIEW = {
    engine: { version: '1.4.0', releaseLogIndex: 123_456, releaseLogEntryUuid: 'c'.repeat(80) },
    update: {
        status: 'pending',
        policy: 'auto',
        pinnedVersion: null,
        availableVersion: '1.5.0',
        eligibleAt: '2026-10-03T00:00:00Z',
    },
    ui: {
        version: '1.0.0',
        bundleSha256: SHA,
        releaseLogIndex: 654_321,
        releaseLogEntryUuid: 'd'.repeat(64),
        lastUpdateCheck: { at: AT, outcome: 'up-to-date', version: '1.0.0', reason: null, revocationReason: null },
    },
    tls: {
        certificateSha256: 'ef'.repeat(32),
        notAfter: '2026-12-01T00:00:00Z',
        lastCtCheck: { at: AT, result: 'ok', unexpectedCertificates: [] },
    },
    relays: [
        { hostname: 'relay-a.ptbk.io', status: 'connected', since: AT, lastPingRttMs: 42 },
        { hostname: 'relay-b.ptbk.io', status: 'disconnected', since: AT, lastPingRttMs: null },
    ],
    hostnames: [
        {
            hostname: 'memoryengine234567abcdefgh.ptbk.io',
            kind: 'default',
            certificateStatus: 'valid',
            claimRegistered: null,
        },
        { hostname: 'ai.example.com', kind: 'custom', certificateStatus: 'pending', claimRegistered: true },
    ],
    lastHeartbeat: { sentAt: AT, body: RAW_HEARTBEAT, signature: SIGNATURE },
    clockSkew: null,
    outboundDestinations: ['https://app.ptbk.io', 'wss://relay-a.ptbk.io'],
} as const;

function renderSecurity(options: Parameters<typeof createSecurityEngine>[0] = {}, path = '/security') {
    const engine = createSecurityEngine({ ...options, seed: { security: FULL_OVERVIEW, ...options.seed } });
    return { ...renderWithProviders({ path, engineApi: engine.client }), engine };
}

const card = (name: string) => screen.getByRole('heading', { name }).closest('section') as HTMLElement;

afterEach(() => {
    setMedia('(prefers-reduced-motion: reduce)', false);
});

describe('security panel: trust panel', { timeout: TIMEOUT_MS }, () => {
    it("shows the shared test vector's fingerprint for the in-memory engine, in the mark's accessible name", async () => {
        renderSecurity();
        const vector = vectors.vectors.find(({ engineId }) => engineId === 'memoryengine234567abcdefgh');
        if (vector === undefined) throw new Error('no vector for the in-memory engine ID');
        await screen.findByRole('heading', { name: 'Private engine: your data stays on your server' });
        const trust = screen.getByRole('heading', { name: /Private engine/ }).closest('section') as HTMLElement;
        const mark = within(trust).getByRole('img', { name: new RegExp(vector.formatted) });
        expect(mark.textContent).toContain(vector.formatted);
        expect(within(trust).getByText('memoryengine234567abcdefgh')).toBeDefined();
        expect(await within(trust).findByText('memoryengine234567abcdefgh.ptbk.io')).toBeDefined();
    });

    it('plays the verify animation once the data has loaded and the bundle version matches', async () => {
        const { container } = renderSecurity();
        await waitFor(() => {
            expect(container.querySelector('#trust svg')?.classList.contains('trust-mark-sealing')).toBe(true);
        });
    });

    it('does not play the verify animation under reduced motion', async () => {
        setMedia('(prefers-reduced-motion: reduce)', true);
        const { container } = renderSecurity();
        await waitFor(() => {
            expect(container.querySelector('#trust svg')?.getAttribute('data-state')).toBe('verified');
        });
        expect(container.querySelector('.trust-mark-sealing')).toBeNull();
    });

    it("opens from the shell's trust mark and moves focus to the trust panel heading", async () => {
        const { user, router } = renderSecurity({}, '/settings');
        await user.click(await screen.findByRole('link', { name: /Engine security/ }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security');
        });
        const heading = await screen.findByRole('heading', { name: 'Private engine: your data stays on your server' });
        await waitFor(() => {
            expect(document.activeElement).toBe(heading);
        });
    });
});

describe('security panel: sections', { timeout: TIMEOUT_MS }, () => {
    it('renders every section from the in-memory engine and passes axe', async () => {
        const { container } = renderSecurity();
        await screen.findByText('relay-a.ptbk.io');
        for (const title of [
            'Engine',
            'Update policy',
            'UI bundle',
            'Certificate and Certificate Transparency',
            'Relays and tunnel',
            'Hostnames',
            'Outbound destinations',
            'Last heartbeat',
        ]) {
            expect(screen.getByRole('heading', { name: title }), title).toBeDefined();
        }
        const engine = card('Engine');
        expect(within(engine).getByText('1.4.0')).toBeDefined();
        expect(within(engine).getByText('123456')).toBeDefined();
        expect(
            within(engine)
                .getByRole('link', { name: /Look it up in Rekor/ })
                .getAttribute('href'),
        ).toBe('https://search.sigstore.dev/?logIndex=123456');
        expect(within(engine).getByText('Update waiting to install')).toBeDefined();
        expect(within(engine).getByText('1.5.0')).toBeDefined();
        const bundle = card('UI bundle');
        expect(bundle.textContent).toContain(SHA);
        expect(within(bundle).queryByText('The UI version does not match')).toBeNull();
        expect(card('Hostnames').textContent).toContain('signed claim registered');
        expect(card('Outbound destinations').textContent).toContain('https://app.ptbk.io');
        expect(card('Last heartbeat').textContent).toContain(SIGNATURE);
        await expectNoAxeViolations(container);
    });

    it('shows the last heartbeat byte for byte, as sent', async () => {
        renderSecurity();
        const body = await screen.findByTestId('heartbeat-body');
        expect(body.tagName).toBe('PRE');
        expect(body.textContent).toBe(RAW_HEARTBEAT);
        // Only line-break opportunities between fields: no markup of the payload's own.
        expect([...body.children].every((child) => child.tagName === 'WBR')).toBe(true);
    });

    it('warns when the served UI version differs from the one compiled into the page', async () => {
        renderSecurity({ seed: { security: { ...FULL_OVERVIEW, ui: { ...FULL_OVERVIEW.ui, version: '0.9.0' } } } });
        expect(await screen.findByText('The UI version does not match')).toBeDefined();
        expect(screen.getByRole('img', { name: /not the version this page was built as/ })).toBeDefined();
    });

    it('raises a danger banner for a foreign certificate found in CT logs', async () => {
        const foreign = { sha256: '99'.repeat(32), issuer: 'CN=<b>Other</b> CA', notBefore: AT, notAfter: AT };
        renderSecurity({
            seed: {
                security: {
                    ...FULL_OVERVIEW,
                    tls: {
                        ...FULL_OVERVIEW.tls,
                        lastCtCheck: { at: AT, result: 'unexpected-certificate', unexpectedCertificates: [foreign] },
                    },
                },
            },
        });
        const banner = await screen.findByText('A certificate this engine did not request exists for its hostname');
        const region = banner.closest('[role="alert"], [role="status"], div') as HTMLElement;
        expect(region.textContent).toContain('99'.repeat(32));
        expect(region.textContent).toContain('Issuer: CN=<b>Other</b> CA');
        expect(document.querySelector('b')).toBeNull();
    });

    it('says a relay is disconnected in words, not only by colour', async () => {
        renderSecurity();
        const relays = await screen.findByText('relay-b.ptbk.io');
        expect(relays.closest('li')?.textContent).toContain('Disconnected');
        expect(screen.getByText('relay-a.ptbk.io').closest('li')?.textContent).toContain('last ping 42 ms');
    });

    it('explains a refused UI release and the clock skew', async () => {
        renderSecurity({
            seed: {
                security: {
                    ...FULL_OVERVIEW,
                    ui: {
                        ...FULL_OVERVIEW.ui,
                        lastUpdateCheck: {
                            at: AT,
                            outcome: 'refused',
                            version: '1.1.0',
                            reason: 'revocations-unverifiable',
                            revocationReason: 'rolled-back',
                        },
                    },
                    clockSkew: { seconds: -300, measuredAt: AT },
                },
            },
        });
        expect(await screen.findByText('The engine refused a UI release')).toBeDefined();
        expect(screen.getByText('Reason: the revocation list could not be verified')).toBeDefined();
        expect(screen.getByText('Revocation list: older than one already accepted')).toBeDefined();
        expect(card('Last heartbeat').textContent).toContain("The engine's clock is 300 s behind the dashboard's");
    });

    it('shows its empty states', async () => {
        renderSecurity({
            seed: {
                security: {
                    ...FULL_OVERVIEW,
                    relays: [],
                    hostnames: [FULL_OVERVIEW.hostnames[0]],
                    lastHeartbeat: null,
                    outboundDestinations: [],
                    tls: { ...FULL_OVERVIEW.tls, lastCtCheck: null },
                },
            },
        });
        expect(await screen.findByText('No relays')).toBeDefined();
        expect(screen.getByText('No custom domains')).toBeDefined();
        expect(screen.getByText('No outbound destinations')).toBeDefined();
        expect(screen.getByText('No heartbeat sent yet')).toBeDefined();
        expect(screen.getByText('Not checked yet')).toBeDefined();
    });

    it('keeps the trust panel when the overview fails, with a retry in each section', async () => {
        const engine = createSecurityEngine({ seed: { security: FULL_OVERVIEW } });
        const get = vi.spyOn(engine.client.security, 'get').mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/security', engineApi: engine.client });
        const retries = await screen.findAllByRole('button', { name: 'Try again' }, { timeout: 10_000 });
        expect(retries.length).toBeGreaterThanOrEqual(8);
        expect(screen.getByRole('heading', { name: /Private engine/ })).toBeDefined();
        expect(screen.getByText('memoryengine234567abcdefgh')).toBeDefined();

        get.mockRestore();
        const [first] = retries;
        if (first !== undefined) await user.click(first);
        expect(await screen.findByText('relay-a.ptbk.io')).toBeDefined();
    });
});

describe('security panel: update policy', { timeout: TIMEOUT_MS }, () => {
    it('changes the policy and reports it', async () => {
        const { user } = renderSecurity();
        const policy = await screen.findByRole('combobox', { name: 'Policy' });
        await user.selectOptions(policy, 'pinned');
        await user.type(screen.getByRole('textbox', { name: /^Version/ }), 'nope');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('Enter a version such as 1.4.0.')).toBeDefined();

        await user.clear(screen.getByRole('textbox', { name: /^Version/ }));
        await user.type(screen.getByRole('textbox', { name: /^Version/ }), '1.4.0');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('Update policy set to Pinned to 1.4.0')).toBeDefined();
        expect(screen.getByText(/recorded in the audit log/)).toBeDefined();
    });

    it('asks for a fresh passkey when the engine wants step-up, and changes nothing', async () => {
        const { user, engine } = renderSecurity({ stepUp: 'required' });
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Policy' }), 'manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
        const overview = await engine.client.security.get(AbortSignal.timeout(1000));
        expect(overview.kind === 'ok' && overview.data.update.policy).toBe('auto');
    });

    it('reports a refused change', async () => {
        const { user, engine } = renderSecurity();
        vi.spyOn(engine.client.settings, 'setUpdatePolicy').mockImplementation(() => problemResponse('internal-error'));
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Policy' }), 'manual');
        await user.click(screen.getByRole('button', { name: 'Save policy' }));
        expect(await screen.findByText('The update policy could not be changed.')).toBeDefined();
    });

    it('is read-only without settings.manage', async () => {
        renderSecurity({ permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage') });
        const section = await waitFor(() => card('Update policy'));
        await within(section).findByText('Automatic');
        expect(within(section).queryByRole('combobox')).toBeNull();
        expect(within(section).queryByRole('button')).toBeNull();
    });
});
