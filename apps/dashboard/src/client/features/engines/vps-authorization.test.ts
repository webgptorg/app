import { afterEach, expect, it } from 'vitest';
import { beginVps, resumeVps } from './vps-authorization';

afterEach(() => {
    sessionStorage.clear();
});
it('binds OAuth to this tab and organization and resumes after registration or a reload', async () => {
    const link = 'a'.repeat(26);
    const url = new URL(
        await beginVps({ provider: 'digitalocean' }, 'client', 'org', link, 'https://app.example.test', sessionStorage),
    );
    expect(url.origin).toBe('https://cloud.digitalocean.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'test' });
    expect(resumeVps(new URLSearchParams({ state: 'invalid', code: 'test' }), 'org', sessionStorage)).toBeNull();
    expect(resumeVps(callback, 'other', sessionStorage)).toBeNull();
    const tx = resumeVps(callback, 'org', sessionStorage);
    expect(tx?.code).toBe('test');
    expect(tx?.link).toBe(link);
    expect(tx?.verifier).not.toBe(url.searchParams.get('code_challenge'));
    expect(resumeVps(new URLSearchParams(), 'org', sessionStorage)).toEqual(tx);
});
