import {
    ENGINE_API_ROUTES,
    KNOWN_CAPABILITIES,
    MAX_SPEECH_TEXT_LENGTH,
    MAX_VOICE_CLIP_BYTES,
    MAX_VOICE_CLIP_MS,
    OWNER_PERMISSIONS,
    SPEECH_FORMATS,
    matchMediaType,
    supports,
} from '@ptbk/engine-api';
import type { SpeechFormat } from '@ptbk/engine-api';

import type { CheckContext, ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import { SILENT_CLIP_MS, markedWav, silentWav } from '../../fixtures/audio';
import { randomToken } from '../../random';
import type { ApiResult } from './api';
import { describe } from './api';
import { CAPABILITY_NOT_ADVERTISED, requireCapability } from './capability-support';
import { PLACEHOLDER_ID } from './requests';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { allPermissionsExcept, createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;
const INPUT = KNOWN_CAPABILITIES.voiceInput;
const OUTPUT = KNOWN_CAPABILITIES.voiceOutput;
/** An engine decodes the clip itself; container framing and rounding may shift the duration a little. */
const DURATION_TOLERANCE_MS = 250;
/** A multiple of 3, so its base64 form is the same at every byte offset that is a multiple of 3 from the start. */
const MARKER_LENGTH = 24;

/** Runtime unavailability is not a broken contract: the check cannot judge what the provider would have done. */
function skipIfUnavailable(result: ApiResult<unknown>): void {
    if (result.kind === 'problem' && result.problem.code === 'voice-unavailable') skip('voice-unavailable');
}

/** The IDs of the thread's entries, newest first, so a check can tell whether anything was added. */
async function entryIds(world: World, chatId: string): Promise<string> {
    const page = await world.owner.ok(R.listChatEntries, { params: { chatId }, query: { limit: 100 } });
    return page.items.map(({ id }) => id).join(',');
}

/** One byte past the cap, as a WAV whose header alone is valid: only its size may refuse it. */
function oversizeClip(): Blob {
    const head = silentWav(SILENT_CLIP_MS);
    return new Blob([head, new Uint8Array(MAX_VOICE_CLIP_BYTES + 1 - head.size)], { type: 'audio/wav' });
}

function retyped(clip: Blob, type: string): Blob {
    return new Blob([clip], { type });
}

function base64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** The marker as text and in base64 at each of the three byte alignments the encoded audio may have. */
function markerForms(marker: string): readonly string[] {
    const bytes = new TextEncoder().encode(marker);
    return [
        marker,
        ...[0, 1, 2].map((shift) => base64(bytes.subarray(shift, shift + 3 * Math.floor((bytes.length - shift) / 3)))),
    ];
}

function directiveOf(header: string, name: string): string | null {
    for (const item of header.split(',')) {
        const [key, ...value] = item.trim().split('=');
        if (key?.trim().toLowerCase() === name) return value.join('=').trim();
    }
    return null;
}

function policyFindings(findings: Findings, where: string, header: string | null, expected: string): void {
    if (header === null) {
        findings.add(`${where}: no Permissions-Policy header`);
        return;
    }
    const microphone = directiveOf(header, 'microphone');
    if (microphone === null) findings.add(`${where}: Permissions-Policy has no microphone directive`);
    else if (microphone.includes('*') || /["']?https?:/i.test(microphone)) {
        findings.add(`${where}: Permissions-Policy grants the microphone to other origins`);
    } else if (microphone !== expected) {
        findings.add(`${where}: microphone=${microphone}, expected microphone=${expected}`);
    }
}

async function anonymousPage(ctx: CheckContext): Promise<Headers> {
    const response = await ctx.target.fetch(`${ctx.target.baseUrl.origin}/`, {
        headers: {
            Accept: 'text/html',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
        },
        redirect: 'manual',
        signal: ctx.signal,
    });
    await response.body?.cancel();
    return response.headers;
}

export const VOICE_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.voice.transcription-caps',
        suite: SUITE,
        title: 'A clip of another type is 415, over the byte cap 413, over a minute 422 voice-clip-too-long, in an unknown chat 404; none adds an entry',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, INPUT);
            const findings = new Findings();
            const chatId = (await world.chat()).id;
            const before = await entryIds(world, chatId);
            const clip = silentWav(SILENT_CLIP_MS);
            const refusals: readonly [
                label: string,
                body: Blob,
                code: 'unsupported-media-type' | 'payload-too-large' | 'voice-clip-too-long',
            ][] = [
                ['an audio/mpeg clip', retyped(clip, 'audio/mpeg'), 'unsupported-media-type'],
                ['a text/plain body', retyped(clip, 'text/plain'), 'unsupported-media-type'],
                ['a clip without Content-Type', retyped(clip, ''), 'unsupported-media-type'],
                ['a clip one byte over MAX_VOICE_CLIP_BYTES', oversizeClip(), 'payload-too-large'],
                ['a clip a second over MAX_VOICE_CLIP_MS', silentWav(MAX_VOICE_CLIP_MS + 1_000), 'voice-clip-too-long'],
            ];
            for (const [label, body, code] of refusals) {
                await attempt(findings, async () => {
                    const result = await world.owner.call(R.transcribeVoiceClip, { params: { chatId }, body });
                    skipIfUnavailable(result);
                    if (result.kind === 'ok') findings.add(`${describe(R.transcribeVoiceClip)}: accepted ${label}`);
                    else if (result.problem.code !== code) {
                        findings.add(
                            `${describe(R.transcribeVoiceClip)}: ${label} got ${result.problem.code}, not ${code}`,
                        );
                    }
                });
            }
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.transcribeVoiceClip,
                    { params: { chatId: PLACEHOLDER_ID }, body: clip },
                    'not-found',
                );
            });
            if ((await entryIds(world, chatId)) !== before) {
                findings.add(`${describe(R.transcribeVoiceClip)}: a refused clip added an entry to the chat`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.voice.transcription-draft',
        suite: SUITE,
        title: 'A clip becomes a draft with its duration, adds nothing to the chat, and no answer or audit entry echoes the audio',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, INPUT);
            const findings = new Findings();
            const marker = randomToken(ctx.random, MARKER_LENGTH);
            const forms = markerForms(marker);
            const leaks = new Set<string>();
            const decoder = new TextDecoder();
            world.owner.observe((route, bytes) => {
                const text = decoder.decode(bytes);
                if (forms.some((form) => text.includes(form))) leaks.add(describe(route));
            });
            const chatId = (await world.chat()).id;
            const before = await entryIds(world, chatId);
            const clip = markedWav(SILENT_CLIP_MS, marker);
            const result = await world.owner.call(R.transcribeVoiceClip, { params: { chatId }, body: clip });
            skipIfUnavailable(result);
            if (result.kind === 'problem') {
                findings.add(`${describe(R.transcribeVoiceClip)}: a one-second WAV got ${result.problem.code}`);
            } else if (Math.abs(result.data.durationMs - SILENT_CLIP_MS) > DURATION_TOLERANCE_MS) {
                findings.add(
                    `${describe(R.transcribeVoiceClip)}: durationMs is ${String(result.data.durationMs)} for a ${String(SILENT_CLIP_MS)} ms clip`,
                );
            }
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.transcribeVoiceClip,
                    { params: { chatId }, body: retyped(clip, 'audio/mpeg') },
                    'unsupported-media-type',
                );
            });
            await attempt(findings, async () => {
                const oversize = new Blob([clip, new Uint8Array(MAX_VOICE_CLIP_BYTES + 1 - clip.size)], {
                    type: 'audio/wav',
                });
                await world.owner.problem(
                    R.transcribeVoiceClip,
                    { params: { chatId }, body: oversize },
                    'payload-too-large',
                );
            });
            if ((await entryIds(world, chatId)) !== before) {
                findings.add(
                    `${describe(R.transcribeVoiceClip)}: a transcript added an entry to the chat before anything was sent`,
                );
            }
            if (supports(await world.engine(), KNOWN_CAPABILITIES.audit)) {
                await world.owner.ok(R.listAuditEntries, { query: { limit: 100 } });
            }
            for (const where of leaks) findings.add(`${where}: an answer contains the uploaded audio`);
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.voice.speech',
        suite: SUITE,
        title: 'Speech answers in the first offered format it can make or 415, refuses unknown messages with 404 and long ones with 422 speech-too-long',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, OUTPUT);
            const findings = new Findings();
            const { userMessage, replyMessageId } = await world.reply();
            const chatId = userMessage.chatId;
            const params = { chatId, messageId: replyMessageId };
            const made: SpeechFormat[] = [];
            for (const format of SPEECH_FORMATS) {
                const result = await world.owner.call(R.speakChatMessage, { params, body: { formats: [format] } });
                skipIfUnavailable(result);
                if (result.kind === 'problem') {
                    if (result.problem.code !== 'unsupported-media-type') {
                        findings.add(
                            `${describe(R.speakChatMessage)}: only ${format} offered got ${result.problem.code}`,
                        );
                    }
                    continue;
                }
                made.push(format);
                if (matchMediaType(result.raw.headers.get('content-type'), [format]) === null) {
                    findings.add(`${describe(R.speakChatMessage)}: only ${format} offered, answered in another format`);
                }
                if (result.raw.bytes.length === 0)
                    findings.add(`${describe(R.speakChatMessage)}: ${format} audio is empty`);
            }
            const preferred = made[0];
            if (preferred === undefined)
                findings.add(`${describe(R.speakChatMessage)}: no format of SPEECH_FORMATS is made`);
            else {
                await attempt(findings, async () => {
                    const result = await world.owner.call(R.speakChatMessage, {
                        params,
                        body: { formats: [...SPEECH_FORMATS] },
                    });
                    skipIfUnavailable(result);
                    if (result.kind === 'problem') {
                        findings.add(
                            `${describe(R.speakChatMessage)}: every format offered got ${result.problem.code}`,
                        );
                    } else if (matchMediaType(result.raw.headers.get('content-type'), [preferred]) === null) {
                        findings.add(
                            `${describe(R.speakChatMessage)}: did not answer in ${preferred}, the first offered format it makes`,
                        );
                    }
                });
            }
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.speakChatMessage,
                    { params: { chatId, messageId: PLACEHOLDER_ID }, body: { formats: [...SPEECH_FORMATS] } },
                    'not-found',
                );
            });
            await attempt(findings, async () => {
                const content = 'Read this aloud. '
                    .repeat(Math.ceil((MAX_SPEECH_TEXT_LENGTH + 1) / 17))
                    .slice(0, MAX_SPEECH_TEXT_LENGTH + 1);
                const sent = await world.owner.ok(R.sendChatMessage, { params: { chatId }, body: { content } });
                await world.owner.problem(
                    R.speakChatMessage,
                    { params: { chatId, messageId: sent.message.id }, body: { formats: [...SPEECH_FORMATS] } },
                    'speech-too-long',
                );
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.voice.permissions',
        suite: SUITE,
        title: 'A member without chats.write cannot transcribe and one without chats.read cannot hear a message: 403',
        async run(ctx) {
            const world = await createWorld(ctx);
            const engine = await world.engine();
            const input = supports(engine, INPUT);
            const output = supports(engine, OUTPUT);
            if (!input && !output) skip(CAPABILITY_NOT_ADVERTISED);
            const findings = new Findings();
            if (input) {
                const writer = await sessionFor(
                    ctx,
                    { kind: 'member', permissions: allPermissionsExcept('chats.write', OWNER_PERMISSIONS) },
                    'a member without chats.write',
                );
                const chatId = (await world.chat()).id;
                await attempt(findings, async () => {
                    await writer.problem(
                        R.transcribeVoiceClip,
                        { params: { chatId }, body: silentWav(SILENT_CLIP_MS) },
                        'forbidden',
                    );
                });
            }
            if (output) {
                const reader = await sessionFor(
                    ctx,
                    { kind: 'member', permissions: allPermissionsExcept('chats.read', OWNER_PERMISSIONS) },
                    'a member without chats.read',
                );
                const { userMessage, replyMessageId } = await world.reply();
                await attempt(findings, async () => {
                    await reader.problem(
                        R.speakChatMessage,
                        {
                            params: { chatId: userMessage.chatId, messageId: replyMessageId },
                            body: { formats: [...SPEECH_FORMATS] },
                        },
                        'forbidden',
                    );
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.voice.permissions-policy',
        suite: SUITE,
        title: 'Permissions-Policy allows microphone=(self) exactly while voice-input@1 is advertised, microphone=() otherwise, never another origin',
        async run(ctx) {
            if (ctx.target.gateway === false) skip('the target runs the API without the engine gateway');
            const world = await createWorld(ctx);
            const expected = supports(await world.engine(), INPUT) ? '(self)' : '()';
            const findings = new Findings();
            const api = await world.owner.send(R.getEngine);
            policyFindings(findings, describe(R.getEngine), api.headers.get('permissions-policy'), expected);
            const page = await anonymousPage(ctx);
            policyFindings(findings, 'GET / (anonymous)', page.get('permissions-policy'), expected);
            return findings.outcome();
        },
    },
];
