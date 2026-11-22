import { expect, it } from 'vitest';

import { createWebsiteLicenseHttpApi } from './website-license-api';
import type { LicenseSnapshot } from '../../domain/licensing/license-contract';

const subject = '4408b4d6-6005-4b77-97eb-fdd67847ee92';
const snapshot: LicenseSnapshot = {
    version: 1,
    subject,
    generatedAt: '2026-11-13T00:00:00.000Z',
    refreshAfterSeconds: 900,
    enforcement: 'advisory',
    manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
    grants: [],
};
const signal = new AbortController().signal;

function api(answer: (url: string, init: RequestInit | undefined) => Response, websiteOrigin = 'https://www.ptbk.io') {
    return createWebsiteLicenseHttpApi({
        websiteOrigin,
        secret: 'server-only',
        fetch: (url, init) => Promise.resolve(answer(url instanceof Request ? url.url : url.toString(), init)),
    });
}

it('asks for the subject with the bearer secret and keeps known fields only, without status or plan name', async () => {
    let requested = '';
    const license = await api((url, init) => {
        requested = url;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-only');
        expect(init?.redirect).toBe('error');
        return Response.json({ ...snapshot, futureField: true });
    }).lookup({ subject }, signal);
    expect(requested).toBe(`https://www.ptbk.io/api/promptbook-billing/app/licenses?subject=${subject}`);
    expect(license).toEqual({ snapshot, status: null, label: null });
});

it('rejects anything but a valid answer, so an outage is never "no licence"', async () => {
    for (const status of [401, 404, 429, 503]) {
        await expect(
            api(() => Response.json({ error: 'x' }, { status })).lookup({ subject }, signal),
        ).rejects.toThrow();
    }
    await expect(api(() => Response.json({ ...snapshot, version: 2 })).lookup({ subject }, signal)).rejects.toThrow();
});

it('accepts a manage link anywhere on the configured website and nothing off it', async () => {
    const read = (manageUrl: string, websiteOrigin?: string) =>
        api(() => Response.json({ ...snapshot, manageUrl }), websiteOrigin).lookup({ subject }, signal);
    await expect(read('https://www.ptbk.io/en/pricing/subscription?tab=team')).resolves.toBeDefined();
    await expect(read('https://staging.ptbk.io/cs/predplatne', 'https://staging.ptbk.io')).resolves.toBeDefined();
    for (const offSite of [
        'https://evil.example/cs/pricing/predplatne',
        'http://www.ptbk.io/cs/pricing/predplatne',
        'https://user:pass@www.ptbk.io/cs',
        'https://www.ptbk.io.evil.example/cs',
        'javascript:alert(1)',
    ]) {
        await expect(read(offSite)).rejects.toThrow();
    }
});

it('reads the website timestamps as it writes them, with offsets and microseconds', async () => {
    const license = await api(() =>
        Response.json({
            ...snapshot,
            grants: [
                {
                    id: '4408b4d6-6005-4b77-97eb-fdd67847ee94',
                    validFrom: '2026-11-13T17:13:19.123456+00:00',
                    validUntil: '2026-11-27T17:13:19.123456+01:00',
                    capabilities: {
                        engineProjects: 1,
                        specialists: 10,
                        controllingUsers: 5,
                        harnessInstances: null,
                        browserProfiles: 5,
                        remoteControl: true,
                    },
                },
            ],
        }),
    ).lookup({ subject }, signal);
    expect(license.snapshot.grants).toHaveLength(1);
});
