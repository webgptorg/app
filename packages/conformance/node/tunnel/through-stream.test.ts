import { X509Certificate } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTestCa } from '../pki/test-ca';
import type { HttpResponse } from './http1';
import { certificateProblem, credentialHeaders, engineAnswerProblem } from './through-stream';

const HOST = 'e1.engine.localhost';
const ca = createTestCa('through-stream test CA');

function certificate(hostnames: string[], notBefore?: Date, notAfter?: Date): X509Certificate {
    return new X509Certificate(
        ca.issue(hostnames, { ...(notBefore && { notBefore }), ...(notAfter && { notAfter }) }).certPem,
    );
}

function response(status: number, body: string, type = 'application/problem+json'): HttpResponse {
    return { status, headers: new Map([['content-type', type]]), body: Buffer.from(body) };
}

const PROBLEM = JSON.stringify({
    type: 'https://ptbk.io/problems/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    code: 'unauthenticated',
});

describe('certificateProblem', () => {
    it('accepts a certificate for the hostname in its validity period', () => {
        expect(certificateProblem(certificate([HOST]), HOST)).toBeNull();
    });

    it('names what is wrong otherwise', () => {
        expect(certificateProblem(null, HOST)).toBe('the engine presented no certificate');
        expect(certificateProblem(certificate(['other.engine.localhost']), HOST)).toContain('not valid for');
        const past = certificate([HOST], new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 86_400_000));
        expect(certificateProblem(past, HOST)).toContain('validity period');
        const future = certificate([HOST], new Date(Date.now() + 86_400_000), new Date(Date.now() + 2 * 86_400_000));
        expect(certificateProblem(future, HOST)).toContain('validity period');
    });
});

describe('engineAnswerProblem', () => {
    it('accepts the 401 problem without a session and the engine info with one', () => {
        expect(engineAnswerProblem(response(401, PROBLEM), 'e1', false)).toBeNull();
        const info = JSON.stringify({
            engineId: 'e1',
            hostname: HOST,
            mode: 'tunnel',
            apiVersion: '1.9',
            dashboardUrl: null,
            capabilities: [],
        });
        const verdict = engineAnswerProblem(response(200, info, 'application/json'), 'e1', true);
        expect(verdict === null || verdict.includes('EngineInfo')).toBe(true);
    });

    it('refuses everything else', () => {
        expect(engineAnswerProblem(response(401, 'nope'), 'e1', false)).toContain('without a JSON body');
        expect(engineAnswerProblem(response(200, '{}', 'application/json'), 'e1', false)).toContain('not 401');
        expect(engineAnswerProblem(response(401, PROBLEM, 'application/json'), 'e1', false)).toContain('not 401');
        expect(engineAnswerProblem(response(401, '{"code":1}'), 'e1', false)).toContain('not a strict problem');
        expect(engineAnswerProblem(response(401, PROBLEM), 'e1', true)).toContain('with a session answered 401');
        expect(engineAnswerProblem(response(200, '{}', 'application/json'), 'e1', true)).toContain('EngineInfo');
        const missingType: HttpResponse = { status: 401, headers: new Map(), body: Buffer.from(PROBLEM) };
        expect(engineAnswerProblem(missingType, 'e1', false)).toContain('not 401');
    });
});

describe('credentialHeaders', () => {
    it('sends a cookie, a bearer token or nothing', () => {
        expect(credentialHeaders(null)).toEqual({});
        expect(credentialHeaders({ cookie: 'a=b' })).toEqual({ Cookie: 'a=b' });
        expect(credentialHeaders({ bearer: 't' })).toEqual({ Authorization: 'Bearer t' });
    });
});
