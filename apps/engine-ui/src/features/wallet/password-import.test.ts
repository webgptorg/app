import { MAX_WALLET_PASSWORD_LENGTH } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { MAX_IMPORT_ROWS } from './import-csv';
import {
    hasImportConflict,
    importLoginKey,
    ImportPasswords,
    MAX_IMPORT_BYTES,
    parsePasswordImport,
} from './password-import';

function bitwardenItem(uris: readonly unknown[] = [{ uri: 'https://example.com/login' }]) {
    return {
        type: 1,
        name: 'Work',
        notes: 'ignored-note-canary',
        fields: [{ name: 'OTP', value: 'ignored-field-canary' }],
        login: { username: ' ada ', password: ' test-password-canary\n ', totp: 'ignored-otp-canary', uris },
    };
}

function parse(text: string) {
    const result = parsePasswordImport(text);
    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('Expected a parsed test export');
    return result;
}

describe('password manager exports', () => {
    it('reads plaintext Bitwarden JSON and expands distinct website origins without exposing secrets', () => {
        const result = parse(
            JSON.stringify({
                encrypted: false,
                folders: [{ id: 'not-imported' }],
                items: [
                    bitwardenItem([
                        { uri: 'https://www.example.com/a' },
                        { uri: 'https://example.com/b' },
                        { uri: 'http://second.example:8080/a' },
                        { uri: 'androidapp://com.example.app' },
                        { uri: null },
                        { uri: 'https://never.example', match: 5 },
                        { uri: 'https://regex.example', match: 4 },
                    ]),
                ],
            }),
        );
        expect(result.preview.logins).toEqual([
            { id: 0, origin: 'https://example.com', label: 'Work', username: 'ada' },
            { id: 1, origin: 'http://second.example:8080', label: 'Work', username: 'ada' },
        ]);
        expect(JSON.stringify(result)).not.toContain('canary');
        expect(result.passwords.take(0).take()).toBe(' test-password-canary\n ');
        expect(result.passwords.take(0).take()).toBe('');
        result.passwords.clear();
        expect(result.passwords.take(1).take()).toBe('');
    });

    it.each([
        [
            'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,0,login,Work,,,,https://example.com/path,ada,pw,',
        ],
        [
            'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nWork,https://example.com/path,ada,pw,,false,false,,',
        ],
        ['Title,Website,Username,Password\nWork,https://example.com/path,ada,pw'],
        ['url,username,password,extra,name,grouping,fav\nhttps://example.com/path,ada,pw,,Work,,0'],
        ['name,url,username,password,note\nWork,https://example.com/path,ada,pw,'],
        ['hostname,username,password,httpRealm,formActionOrigin\nhttps://example.com/path,ada,pw,,'],
        ['Title,URL,User Name,Password\nWork,https://example.com/path,ada,pw'],
    ])('reads compatible manager and browser CSV headers', (csv) => {
        const result = parse('\uFEFF' + csv);
        expect(result.preview.logins[0]).toMatchObject({ origin: 'https://example.com', username: 'ada' });
        expect(result.passwords.take(0).take()).toBe('pw');
    });

    it('drops every duplicate in a service/account group rather than arbitrarily choosing its password', () => {
        const result = parse(
            'url,username,password\nhttps://www.example.com/a,ADA,one\nhttps://example.com/b,ada,two\nhttps://example.com,ada,three\nhttps://other.example,ada,four',
        );
        expect(result.preview.skipped).toBe(3);
        expect(result.preview.logins).toHaveLength(1);
        expect(result.preview.logins[0]?.origin).toBe('https://other.example');
        expect(result.passwords.take(0).take()).toBe('');
    });

    it('skips non-logins, deleted records, missing passwords and non-website URIs', () => {
        const item = bitwardenItem();
        const result = parse(
            JSON.stringify({
                items: [
                    null,
                    { type: 2, notes: 'note-canary' },
                    { ...item, deletedDate: '2026-01-01' },
                    { ...item, login: { username: 'a', password: '', uris: [{ uri: 'https://empty.example' }] } },
                    { ...item, login: { password: 'pw', username: 'a', uris: null } },
                    bitwardenItem([{ uri: 'javascript:alert(1)' }]),
                ],
            }),
        );
        expect(result.preview).toEqual({ logins: [], skipped: 6 });
        expect(
            parse(
                'url,username,password,type,archived\nhttps://example.com,ada,pw,note,false\nhttps://other.example,ada,pw,login,TRUE',
            ).preview.skipped,
        ).toBe(2);
    });

    it('skips values outside the Wallet contract limits and keeps names optional', () => {
        const result = parse(
            'url,username,password\nhttps://example.com,ada,' +
                'p'.repeat(MAX_WALLET_PASSWORD_LENGTH + 1) +
                '\nhttps://valid.example,ada,pw',
        );
        expect(result.preview.skipped).toBe(1);
        expect(result.preview.logins[0]?.label).toBe('');
    });

    it('does not interpret combined or control-character URI cells as a partial website grant', () => {
        for (const uri of [
            'https://one.example,https://two.example',
            'https://one.example;https://two.example',
            'https://one.\texample',
            'https://one.\nexample',
            'https://one.example/' + 'x'.repeat(2048),
        ]) {
            const csv = `url,username,password\n"${uri}",ada,pw`;
            expect(parse(csv).preview).toEqual({ logins: [], skipped: 1 });
        }
    });

    it.each([
        '{broken',
        '[]',
        '{}',
        'url,username\nhttps://a.example,ada',
        'url,url,username,password\na,b,c,d',
        'url,login_uri,username,password\na,b,c,d',
        'url,username,password\nhttps://example.com,a,pw,extra',
    ])('rejects malformed or ambiguous exports', (text) => {
        expect(parsePasswordImport(text)).toEqual({ kind: 'invalid' });
    });

    it('rejects encrypted exports and bounds bytes, source records and expanded origins', () => {
        expect(parsePasswordImport('{"encrypted":true,"data":"encrypted-canary"}')).toEqual({ kind: 'encrypted' });
        expect(parsePasswordImport('x'.repeat(MAX_IMPORT_BYTES + 1))).toEqual({ kind: 'too-large' });
        expect(parsePasswordImport('ž'.repeat(MAX_IMPORT_BYTES / 2 + 1))).toEqual({ kind: 'too-large' });
        expect(
            parsePasswordImport(JSON.stringify({ items: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => null) })),
        ).toEqual({ kind: 'too-many' });
        const items = Array.from({ length: 501 }, (_, i) =>
            bitwardenItem([{ uri: `https://a${String(i)}.example` }, { uri: `https://b${String(i)}.example` }]),
        );
        expect(parsePasswordImport(JSON.stringify({ items }))).toEqual({ kind: 'too-many' });
    });

    it('protects hidden account metadata conservatively and distinguishes scheme and port', () => {
        const login = { id: 0, label: '', origin: 'https://www.example.com', username: 'ADA' };
        const keys = new Set([importLoginKey({ origin: 'https://example.com', username: null })]);
        expect(hasImportConflict(keys, login)).toBe(true);
        expect(hasImportConflict(keys, { ...login, origin: 'http://example.com' })).toBe(false);
        expect(hasImportConflict(keys, { ...login, origin: 'https://example.com:8443' })).toBe(false);
        const passwords = new ImportPasswords();
        passwords.set(1, 'temporary-canary');
        expect(JSON.stringify(passwords)).toBe('{}');
        passwords.clear();
        expect(passwords.take(1).take()).toBe('');
    });
});
