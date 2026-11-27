import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, OWNER_PERMISSIONS, supports } from '@ptbk/engine-api';
import type { AiTool, AiToolSignIn, Permission } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { randomToken } from '../../random';
import type { EngineApi } from './api';
import { describe } from './api';
import { requireCapability } from './capability-support';
import { PLACEHOLDER_ID } from './requests';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, allPermissionsExcept, createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;
const AI_TOOLS = KNOWN_CAPABILITIES.aiTools;
/** A real check or verification is a model call through the tool; give it as long as a chat reply. */
const SETTLE_TIMEOUT_MS = REPLY_TIMEOUT_MS;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tools(world: World): Promise<readonly AiTool[]> {
    return (await world.owner.ok(R.listAiTools)).items;
}

/** An installed tool the owner may sign in with `method` from the browser, or a skip. */
async function toolWith(world: World, method: 'account' | 'api-key'): Promise<AiTool> {
    const tool = (await tools(world)).find(
        (candidate) => candidate.status !== 'not-installed' && candidate.signInMethods.includes(method),
    );
    if (tool === undefined) skip(`no installed AI tool signs in with ${method} from the browser`);
    return tool;
}

/** What a sign-in must not change before it completes: the tool's status and how it authenticates. */
const credentialsOf = (tool: AiTool): string => JSON.stringify({ status: tool.status, auth: tool.auth });

/** Starts a sign-in as the owner, or skips when the engine wants a fresh passkey the suite cannot give. */
async function startSignIn(world: World, tool: AiTool, method: 'account' | 'api-key'): Promise<AiToolSignIn> {
    const result = await world.owner.call(R.startAiToolSignIn, {
        params: { aiToolId: tool.id },
        body: { method },
    });
    if (result.kind === 'problem') {
        if (result.problem.code === 'step-up-required') skip('the engine wants a fresh step-up the suite cannot give');
        fail(`${describe(R.startAiToolSignIn)}: expected 201, got ${String(result.status)} ${result.problem.code}`);
    }
    const signIn = result.data;
    world.ctx.resources.defer((signal) =>
        world.owner
            .withSignal(signal)
            .send(R.cancelAiToolSignIn, { params: { aiToolId: tool.id, signInId: signIn.id } }),
    );
    return signIn;
}

/** Reads the sign-in again until the engine is no longer verifying, as the UI polls. */
async function settled(world: World, signIn: AiToolSignIn): Promise<AiToolSignIn> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let current = signIn;
    while (current.status === 'working') {
        if (Date.now() > deadline) fail(`the sign-in was still working after ${String(SETTLE_TIMEOUT_MS)} ms`);
        await sleep(POLL_MS);
        current = await world.owner.ok(R.getAiToolSignIn, {
            params: { aiToolId: signIn.aiToolId, signInId: signIn.id },
        });
    }
    return current;
}

export const AI_TOOL_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.ai-tools.check',
        suite: SUITE,
        title: 'Each listed AI tool reads the same by ID; Check now answers 202 and settles with a fresh checkedAt; a tool that is not installed is 409',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, AI_TOOLS);
            const findings = new Findings();
            const listed = await tools(world);
            for (const tool of listed) {
                await attempt(findings, async () => {
                    const one = await world.owner.ok(R.getAiTool, { params: { aiToolId: tool.id } });
                    if (one.id !== tool.id || one.name !== tool.name) {
                        findings.add(`${describe(R.getAiTool)}: ${tool.id} reads as another tool than in the list`);
                    }
                    if (tool.status === 'not-installed' && tool.signInMethods.length > 0) {
                        findings.add(`${describe(R.listAiTools)}: ${tool.id} is not installed but offers a sign-in`);
                    }
                });
            }
            await attempt(findings, async () => {
                await world.owner.problem(R.getAiTool, { params: { aiToolId: PLACEHOLDER_ID } }, 'not-found');
            });
            const missing = listed.find(({ status }) => status === 'not-installed');
            if (missing !== undefined) {
                await attempt(findings, async () => {
                    await world.owner.problem(
                        R.checkAiTool,
                        { params: { aiToolId: missing.id } },
                        'ai-tool-not-installed',
                    );
                });
            }
            const installed = listed.find(({ status }) => status !== 'not-installed');
            if (installed === undefined) {
                if (findings.count === 0) skip('no AI tool is installed');
                return findings.outcome();
            }
            await attempt(findings, async () => {
                const before = Date.now() - 1_000;
                let tool = await world.owner.ok(R.checkAiTool, { params: { aiToolId: installed.id } });
                const deadline = Date.now() + SETTLE_TIMEOUT_MS;
                while (tool.checking) {
                    if (Date.now() > deadline) fail(`the check of ${installed.id} did not settle in time`);
                    await sleep(POLL_MS);
                    tool = await world.owner.ok(R.getAiTool, { params: { aiToolId: installed.id } });
                }
                if (tool.checkedAt === null || Date.parse(tool.checkedAt) < before) {
                    findings.add(`${describe(R.checkAiTool)}: the settled check did not move checkedAt`);
                }
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.ai-tools.permissions',
        suite: SUITE,
        title: 'Without ai-tools.read a member cannot list, read or check AI tools; without ai-tools.manage one cannot sign a tool in or out: 403, nothing changes',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, AI_TOOLS);
            const findings = new Findings();
            const tool = (await tools(world)).find(({ status }) => status !== 'not-installed');
            if (tool === undefined) skip('no AI tool is installed');
            const params = { aiToolId: tool.id };
            const without = (permission: Permission): Promise<EngineApi> =>
                sessionFor(
                    ctx,
                    { kind: 'member', permissions: allPermissionsExcept(permission, OWNER_PERMISSIONS) },
                    `a member without ${permission}`,
                );
            const outsider = await without('ai-tools.read');
            for (const [route, request] of [
                [R.listAiTools, {}],
                [R.getAiTool, { params }],
                [R.checkAiTool, { params }],
            ] as const) {
                await attempt(findings, async () => {
                    await outsider.problem(route, request, 'forbidden');
                });
            }
            const admin = await without('ai-tools.manage');
            const before = credentialsOf(await world.owner.ok(R.getAiTool, { params }));
            for (const [route, request] of [
                [R.startAiToolSignIn, { params, body: { method: tool.signInMethods[0] ?? 'account' } }],
                [R.signOutAiTool, { params }],
            ] as const) {
                await attempt(findings, async () => {
                    const problem = await admin.problem(route, request, 'forbidden');
                    if (problem.requiredPermission !== 'ai-tools.manage') {
                        findings.add(`${describe(route)}: forbidden names ${problem.requiredPermission ?? 'nothing'}`);
                    }
                });
            }
            if (credentialsOf(await world.owner.ok(R.getAiTool, { params })) !== before) {
                findings.add(`${describe(R.signOutAiTool)}: a refused request changed the tool's credentials`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.ai-tools.sign-in-flow',
        suite: SUITE,
        title: 'A sign-in shows an onboarding prompt, belongs to its session, refuses a stale or mismatched answer, and leaves the credentials alone until it completes or is cancelled',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, AI_TOOLS);
            const findings = new Findings();
            const tool = await toolWith(world, 'account');
            const before = credentialsOf(tool);
            const signIn = await settled(world, await startSignIn(world, tool, 'account'));
            const params = { aiToolId: tool.id, signInId: signIn.id };
            const prompt = signIn.prompt;
            if (signIn.status !== 'pending' || prompt === null) {
                fail(`${describe(R.startAiToolSignIn)}: a new sign-in is ${signIn.status} without a prompt`);
            }
            if (prompt.canGoBack) findings.add(`${describe(R.startAiToolSignIn)}: a sign-in prompt offers Back`);
            const read = await world.owner.ok(R.getAiToolSignIn, { params });
            if (read.prompt?.id !== prompt.id) {
                findings.add(`${describe(R.getAiToolSignIn)}: reading the sign-in again shows another prompt`);
            }
            await attempt(findings, async () => {
                const laptop = await sessionFor(ctx, { kind: 'owner' }, 'a second owner session');
                await laptop.problem(R.getAiToolSignIn, { params }, 'not-found');
                await laptop.problem(R.cancelAiToolSignIn, { params }, 'not-found');
            });
            await attempt(findings, async () => {
                await world.owner.problem(
                    R.answerAiToolSignIn,
                    {
                        params,
                        body: {
                            promptId: `${prompt.id}-stale`,
                            action: 'answer',
                            answer: { kind: 'harness-login', returnCode: null },
                        },
                    },
                    'ai-tool-sign-in-stale',
                );
            });
            await attempt(findings, async () => {
                const mismatched =
                    prompt.kind === 'secret'
                        ? { kind: 'harness-login', returnCode: null }
                        : { kind: 'secret', value: `conformance-${ctx.runId}` };
                await world.owner.problem(
                    R.answerAiToolSignIn,
                    { params, body: { promptId: prompt.id, action: 'answer', answer: mismatched } },
                    'validation-failed',
                );
            });
            if (credentialsOf(await world.owner.ok(R.getAiTool, { params: { aiToolId: tool.id } })) !== before) {
                findings.add(`${describe(R.startAiToolSignIn)}: an unfinished sign-in changed the tool's credentials`);
            }
            await attempt(findings, async () => {
                const cancelled = await world.owner.send(R.cancelAiToolSignIn, { params });
                if (cancelled.status !== 204) {
                    findings.add(`${describe(R.cancelAiToolSignIn)}: answered ${String(cancelled.status)}, not 204`);
                }
                await world.owner.problem(R.getAiToolSignIn, { params }, 'not-found');
            });
            if (credentialsOf(await world.owner.ok(R.getAiTool, { params: { aiToolId: tool.id } })) !== before) {
                findings.add(`${describe(R.cancelAiToolSignIn)}: a cancelled sign-in changed the tool's credentials`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.ai-tools.secret-never-echoed',
        suite: SUITE,
        title: 'An API key the provider refuses comes back as the secret prompt with an error; no response, the tool or the audit log ever contains it',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, AI_TOOLS);
            const findings = new Findings();
            const tool = await toolWith(world, 'api-key');
            const before = credentialsOf(tool);
            const key = `conformance-${ctx.runId}-${randomToken(ctx.random, 24)}`;
            const seen: string[] = [];
            const decoder = new TextDecoder();
            world.owner.observe((_, bytes) => seen.push(decoder.decode(bytes)));
            const signIn = await settled(world, await startSignIn(world, tool, 'api-key'));
            if (signIn.prompt?.kind !== 'secret') {
                fail(`${describe(R.startAiToolSignIn)}: an api-key sign-in shows no secret prompt`);
            }
            const params = { aiToolId: tool.id, signInId: signIn.id };
            const answered = await settled(
                world,
                await world.owner.ok(R.answerAiToolSignIn, {
                    params,
                    body: { promptId: signIn.prompt.id, action: 'answer', answer: { kind: 'secret', value: key } },
                }),
            );
            if (answered.status === 'completed') {
                fail(`${describe(R.answerAiToolSignIn)}: a made-up key was accepted`);
            }
            if (answered.prompt?.kind !== 'secret' || answered.prompt.error === null) {
                findings.add(
                    `${describe(R.answerAiToolSignIn)}: a refused key does not come back as the secret prompt with an error`,
                );
            } else if (answered.prompt.id === signIn.prompt.id) {
                findings.add(`${describe(R.answerAiToolSignIn)}: the refused key's prompt kept its ID`);
            }
            const after = await world.owner.ok(R.getAiTool, { params: { aiToolId: tool.id } });
            if (credentialsOf(after) !== before) {
                findings.add(`${describe(R.answerAiToolSignIn)}: a refused key changed the tool's credentials`);
            }
            await world.owner.ok(R.listAiTools);
            if (supports(await world.engine(), KNOWN_CAPABILITIES.audit)) {
                await world.owner.ok(R.listAuditEntries, { query: { limit: 100 } });
            }
            if (seen.some((text) => text.includes(key))) {
                findings.add('the API key came back in a response (sign-in, tool, list or audit log)');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.ai-tools.sign-in-required',
        suite: SUITE,
        title: 'When the sign-in of the tool chats run on expires, the tool reads needs-sign-in and a new chat turn fails naming it (recheck aiToolId or ai-tool-sign-in-required)',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, AI_TOOLS);
            const levers = ctx.target.aiTools;
            if (levers === undefined) skip('the target has no AI tool levers');
            const findings = new Findings();
            const chat = await world.chat();
            const aiToolId = await levers.expireSignIn();
            ctx.resources.defer(() => levers.renewSignIn(aiToolId));
            const tool = await world.owner.ok(R.getAiTool, { params: { aiToolId } });
            if (tool.status !== 'needs-sign-in' || tool.problem?.code !== 'sign-in-expired') {
                findings.add(
                    `${describe(R.getAiTool)}: an expired sign-in reads ${tool.status} (${tool.problem?.code ?? 'no problem'})`,
                );
            }
            const sent = await world.owner.ok(R.sendChatMessage, {
                params: { chatId: chat.id },
                body: { content: CHAT_MESSAGE },
            });
            const deadline = Date.now() + REPLY_TIMEOUT_MS;
            for (;;) {
                const read = await world.owner.ok(R.getChat, { params: { chatId: chat.id } });
                if (read.recheck !== null) {
                    if (read.recheck.aiToolId !== aiToolId) {
                        findings.add(
                            `${describe(R.getChat)}: the failed turn's recheck names ${read.recheck.aiToolId ?? 'no AI tool'}, not ${aiToolId}`,
                        );
                    }
                    break;
                }
                const { items } = await world.owner.ok(R.listChatEntries, {
                    params: { chatId: chat.id },
                    query: { limit: 20 },
                });
                const reply = items.find(
                    (entry) =>
                        entry.type === 'message' && entry.author.kind === 'agent' && entry.id !== sent.message.id,
                );
                if (reply?.type === 'message' && reply.status !== 'completed') {
                    const stream = await world.owner.stream(
                        R.streamChatReply,
                        { params: { chatId: chat.id, messageId: reply.id } },
                        { maxMs: REPLY_TIMEOUT_MS, until: ({ event }) => event.type !== 'delta' },
                    );
                    const end = stream.items.at(-1)?.event;
                    const problem = end?.type === 'failed' ? (end['problem'] as Record<string, unknown>) : undefined;
                    if (problem?.['code'] !== 'ai-tool-sign-in-required' || problem['aiToolId'] !== aiToolId) {
                        findings.add(
                            `${describe(R.streamChatReply)}: the turn did not fail with ai-tool-sign-in-required naming ${aiToolId}`,
                        );
                    }
                    break;
                }
                if (reply?.type === 'message' && reply.status === 'completed') {
                    findings.add(
                        `${describe(R.sendChatMessage)}: an agent answered although ${aiToolId} needs signing in`,
                    );
                    break;
                }
                if (Date.now() > deadline)
                    fail(`the turn neither failed nor answered within ${String(REPLY_TIMEOUT_MS)} ms`);
                await sleep(POLL_MS);
            }
            return findings.outcome();
        },
    },
];
