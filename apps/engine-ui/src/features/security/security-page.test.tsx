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

/** A checklist row by its title: the summary line and the details under it. */
const row = (title: string) => screen.getByRole('region', { name: title });

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

describe('security panel: checklist', { timeout: TIMEOUT_MS }, () => {
    it('sums up every claim in one line, with the reported values in its details, and passes axe', async () => {
        const { container } = renderSecurity();
        await screen.findByText('relay-a.ptbk.io');
        expect(row('Engine').textContent).toContain('Version 1.4.0 · Update waiting to install');
        expect(row('UI bundle').textContent).toContain('Version 1.0.0, signed and verified by the engine');
        expect(row('Certificate and Certificate Transparency').textContent).toContain(
            'Valid until Dec 1, 2026; no foreign certificates in CT logs',
        );
        expect(row('Relays and tunnel').textContent).toContain('1 of 2 relays connected');
        expect(row('Hostnames').textContent).toContain('memoryengine234567abcdefgh.ptbk.io and 1 custom domain');
        expect(row('Outbound destinations').textContent).toContain('2 destinations reported');
        expect(row('Last heartbeat').textContent).toMatch(/Sent/);

        const engine = row('Engine');
        expect(within(engine).getByText('123456')).toBeDefined();
        expect(
            within(engine)
                .getByRole('link', { name: /Look it up in Rekor/, hidden: true })
                .getAttribute('href'),
        ).toBe('https://search.sigstore.dev/?logIndex=123456');
        expect(within(engine).getByText('1.5.0')).toBeDefined();
        expect(row('UI bundle').textContent).toContain(SHA);
        expect(row('Hostnames').textContent).toContain('signed claim registered');
        expect(row('Outbound destinations').textContent).toContain('https://app.ptbk.io');
        expect(row('Last heartbeat').textContent).toContain(SIGNATURE);
        await expectNoAxeViolations(container);
    });

    it('keeps healthy rows closed and opens the ones that need a look', async () => {
        renderSecurity();
        await screen.findByText('relay-a.ptbk.io');
        const open = (title: string) => (row(title).querySelector('details') as HTMLDetailsElement).open;
        expect(open('UI bundle')).toBe(false);
        expect(open('Certificate and Certificate Transparency')).toBe(false);
        expect(open('Relays and tunnel')).toBe(true);
    });

    it('opens a row on click', async () => {
        const { user } = renderSecurity();
        await screen.findByText('relay-a.ptbk.io');
        const details = row('UI bundle').querySelector('details') as HTMLDetailsElement;
        await user.click(screen.getByText('UI bundle', { selector: 'summary span' }));
        expect(details.open).toBe(true);
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
        expect((await screen.findAllByText('The UI version does not match')).length).toBeGreaterThan(0);
        expect((row('UI bundle').querySelector('details') as HTMLDetailsElement).open).toBe(true);
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
        await screen.findByText('relay-a.ptbk.io');
        const certificate = row('Certificate and Certificate Transparency');
        expect((certificate.querySelector('details') as HTMLDetailsElement).open).toBe(true);
        expect(certificate.querySelector('summary')?.textContent).toContain(
            'A certificate this engine did not request exists for its hostname',
        );
        expect(certificate.textContent).toContain('99'.repeat(32));
        expect(certificate.textContent).toContain('Issuer: CN=<b>Other</b> CA');
        expect(document.querySelector('b')).toBeNull();
    });

    it('flags a failed CT check without alarm', async () => {
        renderSecurity({
            seed: {
                security: {
                    ...FULL_OVERVIEW,
                    tls: {
                        ...FULL_OVERVIEW.tls,
                        lastCtCheck: { at: AT, result: 'failed', unexpectedCertificates: [] },
                    },
                },
            },
        });
        await screen.findByText('relay-a.ptbk.io');
        expect(row('Certificate and Certificate Transparency').querySelector('summary')?.textContent).toContain(
            'The last CT check failed',
        );
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
        expect((await screen.findAllByText('The engine refused a UI release')).length).toBeGreaterThan(0);
        expect(screen.getByText('Reason: the revocation list could not be verified')).toBeDefined();
        expect(screen.getByText('Revocation list: older than one already accepted')).toBeDefined();
        const heartbeat = row('Last heartbeat');
        expect(heartbeat.querySelector('summary')?.textContent).toContain("The engine's clock is off");
        expect(heartbeat.textContent).toContain("The engine's clock is 300 s behind the dashboard's");
    });

    it('says what is missing in one line instead of empty boxes', async () => {
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
        await screen.findAllByText('This engine is reached directly, not through a relay.');
        expect(row('Hostnames').textContent).toContain('memoryengine234567abcdefgh.ptbk.io, no custom domains');
        expect(row('Outbound destinations').querySelector('summary')?.textContent).toContain(
            'No outbound destinations',
        );
        expect(row('Last heartbeat').querySelector('summary')?.textContent).toContain('No heartbeat sent yet');
        expect(row('Certificate and Certificate Transparency').textContent).toContain('not checked in CT logs yet');
        expect(screen.queryByRole('heading', { name: 'No relays' })).toBeNull();
    });

    it('keeps the trust panel when the overview fails, with one retry', async () => {
        const engine = createSecurityEngine({ seed: { security: FULL_OVERVIEW } });
        const get = vi.spyOn(engine.client.security, 'get').mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/security', engineApi: engine.client });
        const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
        expect(screen.getByRole('heading', { name: /Private engine/ })).toBeDefined();
        expect(screen.getByText('memoryengine234567abcdefgh')).toBeDefined();

        get.mockRestore();
        await user.click(retry);
        expect(await screen.findByText('relay-a.ptbk.io')).toBeDefined();
    });
});

describe('security panel: access', { timeout: TIMEOUT_MS }, () => {
    it('shows every member their passkeys and the engine identity, without the reported claims', async () => {
        const { user, router, container } = renderSecurity({
            permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'security.read'),
        });
        expect(await screen.findByRole('heading', { name: /Private engine/ })).toBeDefined();
        expect(screen.getByText('memoryengine234567abcdefgh')).toBeDefined();
        expect(screen.getByText('engine.localhost')).toBeDefined();
        expect(screen.queryByRole('heading', { name: 'Verification' })).toBeNull();
        expect(screen.getByRole('heading', { name: 'Access' })).toBeDefined();
        await expectNoAxeViolations(container);

        await user.click(screen.getByRole('link', { name: 'Manage passkeys' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security/passkeys');
        });
        await user.click(await screen.findByRole('link', { name: 'Back to security' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security');
        });
    });

    it('never asks for the overview without security.read', async () => {
        const engine = createSecurityEngine({
            seed: { security: FULL_OVERVIEW },
            permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'security.read'),
        });
        const get = vi.spyOn(engine.client.security, 'get');
        renderWithProviders({ path: '/security', engineApi: engine.client });
        await screen.findByRole('heading', { name: 'Access' });
        expect(get).not.toHaveBeenCalled();
    });

    it('points to the audit log only for members who may read it', async () => {
        renderSecurity();
        expect(await screen.findByRole('link', { name: 'Open the audit log' })).toBeDefined();
    });

    it('hides the audit log pointer without audit.read', async () => {
        renderSecurity({ permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'audit.read') });
        await screen.findByRole('heading', { name: 'Access' });
        expect(screen.queryByRole('link', { name: 'Open the audit log' })).toBeNull();
    });

    it('sends old passkey links to the new place', async () => {
        const { router } = renderSecurity({}, '/settings/passkeys');
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/security/passkeys');
        });
    });
});
