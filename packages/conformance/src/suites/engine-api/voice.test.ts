import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { ConformanceTarget } from '../../target';
import type { FakeEngine, FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

const CHECKS = {
    caps: 'engine-api.voice.transcription-caps',
    draft: 'engine-api.voice.transcription-draft',
    speech: 'engine-api.voice.speech',
    permissions: 'engine-api.voice.permissions',
    policy: 'engine-api.voice.permissions-policy',
} as const;

interface Setup {
    readonly options?: FakeEngineOptions;
    readonly prepare?: (fake: FakeEngine) => void;
    readonly adjust?: (target: ConformanceTarget) => ConformanceTarget;
}

async function outcome(id: string, { options = {}, prepare, adjust = (target) => target }: Setup = {}) {
    const fake = await createFakeEngine(options);
    prepare?.(fake);
    const report = await runConformance({
        target: adjust(fake.target),
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        seed: 11,
    });
    const result = report.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no result for ${id}`);
    return result.outcome satisfies CheckOutcome;
}

const path = (request: Request): string => new URL(request.url).pathname.slice('/api/v1'.length);
const TRANSCRIPTIONS = /^\/chats\/[^/]+\/transcriptions$/;
const SPEECH = /^\/chats\/[^/]+\/messages\/[^/]+\/speech$/;
const ENTRIES = /^\/chats\/([^/]+)\/entries$/;
const DRAFT = { text: 'forged', language: 'en', confidence: null, durationMs: 1_000 };

const posts = (pattern: RegExp) => (request: Request) => request.method === 'POST' && pattern.test(path(request));

function draft(data: Record<string, unknown> = DRAFT): Response {
    return Response.json(data);
}

function audio(type: string, bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])): Response {
    return new Response(bytes, {
        headers: { 'content-type': type, 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' },
    });
}

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ type: 'https://ptbk.io/problems/x', title: 'X', status, code, ...extra }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

/** Replaces the answer to matching requests whose original answer had `status`. */
function when(
    match: (request: Request) => boolean,
    status: number,
    make: (request: Request) => Response | Promise<Response>,
): Tamper {
    return (request, response) => (match(request) && response.status === status ? make(request) : response);
}

const typed = (type: string) => (request: Request) =>
    posts(TRANSCRIPTIONS)(request) && (request.headers.get('content-type') ?? '') === type;

async function speechFormats(request: Request): Promise<readonly string[]> {
    return ((await request.clone().json()) as { formats: string[] }).formats;
}

/** Once a transcription was asked for, the chat's entries show one more, as if the clip had been sent. */
function entryAfterTranscription(onlyIfAccepted: boolean): Tamper {
    let added = false;
    return async (request, response) => {
        if (posts(TRANSCRIPTIONS)(request) && (!onlyIfAccepted || response.status === 200)) added = true;
        const chatId = ENTRIES.exec(path(request))?.[1];
        if (!added || request.method !== 'GET' || chatId === undefined || response.status !== 200) return response;
        const page = (await response.json()) as { items: unknown[] };
        const forged = { type: 'titled', id: 'forged-entry', chatId, createdAt: new Date().toISOString(), title: 'x' };
        return Response.json({ ...page, items: [forged, ...page.items] });
    };
}

/** The 24 marker bytes right after the 44-byte WAV header. */
async function markerOf(request: Request): Promise<string> {
    return new TextDecoder().decode(new Uint8Array(await request.clone().arrayBuffer()).subarray(44, 68));
}

function echoMarkerInAudit(): Tamper {
    let marker: string | undefined;
    return async (request, response) => {
        if (posts(TRANSCRIPTIONS)(request) && request.headers.get('content-type') === 'audio/wav') {
            marker ??= await markerOf(request);
        }
        if (marker === undefined || request.method !== 'GET' || path(request) !== '/audit') return response;
        const page = (await response.json()) as { items: { client: { userAgent: string } | null }[] };
        return Response.json({
            ...page,
            items: page.items.map((entry) =>
                entry.client === null ? entry : { ...entry, client: { ...entry.client, userAgent: marker } },
            ),
        });
    };
}

function withPolicy(value: string | null, pages: 'all' | 'pages' = 'all'): Tamper {
    return (request, response) => {
        if (pages === 'pages' && new URL(request.url).pathname.startsWith('/api/')) return response;
        const headers = new Headers(response.headers);
        if (value === null) headers.delete('permissions-policy');
        else headers.set('permissions-policy', value);
        return new Response(response.body, { status: response.status, headers });
    };
}

const NO_VOICE = Object.values(KNOWN_CAPABILITIES).filter(
    (ref) => ref !== KNOWN_CAPABILITIES.voiceInput && ref !== KNOWN_CAPABILITIES.voiceOutput,
);

describe('the voice checks', () => {
    it.each(Object.values(CHECKS))('pass against the in-memory engine: %s', async (id) => {
        expect(await outcome(id)).toEqual({ kind: 'pass' });
    });

    it.each([CHECKS.caps, CHECKS.draft, CHECKS.speech, CHECKS.permissions])(
        'skip without the capabilities: %s',
        async (id) => {
            expect(await outcome(id, { options: { capabilities: NO_VOICE } })).toEqual({
                kind: 'skip',
                reason: 'capability-not-advertised',
            });
        },
    );

    it('still check Permissions-Policy without voice, which must then deny the microphone', async () => {
        expect(await outcome(CHECKS.policy, { options: { capabilities: NO_VOICE } })).toEqual({ kind: 'pass' });
        expect(
            await outcome(CHECKS.policy, {
                options: {
                    capabilities: NO_VOICE,
                    tamper: withPolicy('camera=(), microphone=(self), geolocation=(), payment=(), usb=()'),
                },
            }),
        ).toMatchObject({ kind: 'fail' });
    });

    it('skip Permissions-Policy without a gateway', async () => {
        expect(await outcome(CHECKS.policy, { adjust: (target) => ({ ...target, gateway: false }) })).toMatchObject({
            kind: 'skip',
        });
    });

    it.each([CHECKS.draft, CHECKS.speech])('skip while the provider is unavailable: %s', async (id) => {
        expect(
            await outcome(id, {
                prepare: (fake) => {
                    fake.core.controller.failVoice('voice-unavailable');
                },
            }),
        ).toEqual({
            kind: 'skip',
            reason: 'voice-unavailable',
        });
    });

    const fails: readonly [name: string, id: string, tamper: Tamper][] = [
        ['an audio/mpeg clip accepted', CHECKS.caps, when(typed('audio/mpeg'), 415, () => draft())],
        ['a text/plain body accepted', CHECKS.caps, when(typed('text/plain'), 415, () => draft())],
        ['a clip without Content-Type accepted', CHECKS.caps, when(typed(''), 415, () => draft())],
        [
            'an unsupported type refused with another code',
            CHECKS.caps,
            when(typed('audio/mpeg'), 415, () => problem('validation-failed', 400)),
        ],
        ['an oversize clip accepted', CHECKS.caps, when(posts(TRANSCRIPTIONS), 413, () => draft())],
        ['an overlong clip accepted', CHECKS.caps, when(posts(TRANSCRIPTIONS), 422, () => draft())],
        ['a clip for an unknown chat accepted', CHECKS.caps, when(posts(TRANSCRIPTIONS), 404, () => draft())],
        ['a refused clip that adds an entry', CHECKS.caps, entryAfterTranscription(false)],
        [
            'a duration far from the clip’s',
            CHECKS.draft,
            when(posts(TRANSCRIPTIONS), 200, () => draft({ ...DRAFT, durationMs: 5_000 })),
        ],
        [
            'a readable clip that fails to transcribe',
            CHECKS.draft,
            when(posts(TRANSCRIPTIONS), 200, () => problem('transcription-failed', 502)),
        ],
        ['a transcript that becomes an entry', CHECKS.draft, entryAfterTranscription(true)],
        [
            'a draft that echoes the audio',
            CHECKS.draft,
            when(posts(TRANSCRIPTIONS), 200, async (request) => draft({ ...DRAFT, text: await markerOf(request) })),
        ],
        [
            'a refusal that echoes the audio in base64',
            CHECKS.draft,
            when(typed('audio/mpeg'), 415, async (request) => {
                const bytes = new Uint8Array(await request.clone().arrayBuffer()).subarray(0, 120);
                return problem('unsupported-media-type', 415, { detail: btoa(String.fromCharCode(...bytes)) });
            }),
        ],
        ['an oversize clip accepted in the draft check', CHECKS.draft, when(posts(TRANSCRIPTIONS), 413, () => draft())],
        ['an audit entry that echoes the audio', CHECKS.draft, echoMarkerInAudit()],
        [
            'speech in another format than the one offered',
            CHECKS.speech,
            when(posts(SPEECH), 200, () => audio('audio/mpeg')),
        ],
        ['empty speech', CHECKS.speech, when(posts(SPEECH), 200, () => audio('audio/wav', new Uint8Array()))],
        [
            'no format made at all',
            CHECKS.speech,
            when(posts(SPEECH), 200, () => problem('unsupported-media-type', 415)),
        ],
        [
            'a format refused with another code',
            CHECKS.speech,
            when(posts(SPEECH), 415, () => problem('validation-failed', 400)),
        ],
        [
            'the browser’s preference ignored',
            CHECKS.speech,
            when(posts(SPEECH), 415, async (request) =>
                (await speechFormats(request)).join() === 'audio/mpeg'
                    ? audio('audio/mpeg')
                    : problem('unsupported-media-type', 415),
            ),
        ],
        ['speech of an unknown message', CHECKS.speech, when(posts(SPEECH), 404, () => audio('audio/wav'))],
        ['speech of an overlong message', CHECKS.speech, when(posts(SPEECH), 422, () => audio('audio/wav'))],
        [
            'a member without chats.write transcribing',
            CHECKS.permissions,
            when(posts(TRANSCRIPTIONS), 403, () => draft()),
        ],
        [
            'a member without chats.read hearing a message',
            CHECKS.permissions,
            when(posts(SPEECH), 403, () => audio('audio/wav')),
        ],
        ['no Permissions-Policy', CHECKS.policy, withPolicy(null)],
        ['no Permissions-Policy on pages', CHECKS.policy, withPolicy(null, 'pages')],
        ['no microphone directive', CHECKS.policy, withPolicy('camera=(), geolocation=()')],
        [
            'the microphone denied although voice-input@1 is advertised',
            CHECKS.policy,
            withPolicy('camera=(), microphone=(), geolocation=()'),
        ],
        ['the microphone for every origin', CHECKS.policy, withPolicy('camera=(), microphone=*')],
        ['the microphone for another origin', CHECKS.policy, withPolicy('microphone=(self "https://other.example")')],
    ];

    it.each(fails)('fail on %s', async (_, id, tamper) => {
        expect((await outcome(id, { options: { tamper } })).kind).toBe('fail');
    });
});
