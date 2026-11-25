import type { AuditAction, AuditActor, AuditDetails, AuditTarget } from '../audit';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type {
    AiTool,
    AiToolAuthMethod,
    AiToolProblem,
    AiToolSignIn,
    AiToolSignInPrompt,
} from '../capabilities/ai-tools';
import type { HarnessLoginStatus, OnboardingAlternative } from '../capabilities/onboarding';
import { AiToolId, AiToolSignInId, OpaqueId, Timestamp } from '../common';
import type { ClientInfo, MemberId, SessionId } from '../common';
import { advertises, fail, invalid, notFound, ok, time } from './kit';
import type { EngineContext, HandlerContext, HandlerResult, Handlers } from './kit';

/**
 * The in-memory engine's AI tools (`ai-tools@1`): three fake harnesses with deterministic behaviour. Claude Code signs
 * in with a code pasted back (any 6 or more of `[A-Za-z0-9#_-]`), Codex with a device code that the provider confirms
 * `DEVICE_LOGIN_MS` of engine time after it starts, both also with an API key of their provider's shape; Gemini CLI is
 * not installed. A "real call" is instant here. Keys are tested against their shape and then dropped: the fake keeps
 * that a tool has a key, never the key.
 */

export const AI_TOOL_DEVICE_LOGIN_MS = 5_000;
/** An unfinished sign-in is forgotten this long after it started, as the provider's login link runs out. */
export const AI_TOOL_SIGN_IN_TTL_MS = 15 * 60 * 1000;
const RETURN_CODE = /^[A-Za-z0-9#_-]{6,512}$/;
const DEVICE_CODES = ['Q4TW-7KMB', 'J8RD-2HXP', 'C3NV-9FZL'];

interface FakeTool {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
    readonly login: 'device-code' | 'return-code';
    readonly loginUrl: string;
    readonly provider: string;
    readonly keyLabel: string;
    readonly keyPlaceholder: string;
    readonly keyPattern: RegExp;
    readonly keyHelpUrl: string;
    /** What the provider calls the account a login signs in. */
    readonly account: string;
}

const FAKE_TOOLS: readonly FakeTool[] = [
    {
        id: 'claude-code',
        name: 'Claude Code',
        version: '2.1.330',
        login: 'return-code',
        loginUrl: 'https://claude.ai/oauth/authorize',
        provider: 'Anthropic',
        keyLabel: 'Anthropic API key',
        keyPlaceholder: 'sk-ant-…',
        keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
        keyHelpUrl: 'https://console.anthropic.com/settings/keys',
        account: 'Claude Max',
    },
    {
        id: 'codex',
        name: 'OpenAI Codex',
        version: '0.60.1',
        login: 'device-code',
        loginUrl: 'https://auth.openai.com/codex/device',
        provider: 'OpenAI',
        keyLabel: 'OpenAI API key',
        keyPlaceholder: 'sk-…',
        keyPattern: /^sk-(?!ant-)[A-Za-z0-9_-]{20,}$/,
        keyHelpUrl: 'https://platform.openai.com/api-keys',
        account: 'ChatGPT Plus',
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        version: null,
        login: 'return-code',
        loginUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        provider: 'Google',
        keyLabel: 'Gemini API key',
        keyPlaceholder: 'AI…',
        keyPattern: /^AI[A-Za-z0-9_-]{20,}$/,
        keyHelpUrl: 'https://aistudio.google.com/apikey',
        account: 'Google account',
    },
];

interface Credential {
    readonly method: AiToolAuthMethod;
    readonly account: string | null;
    /** `false` once the provider stopped accepting it (expired, revoked). */
    valid: boolean;
}

interface ToolRecord {
    readonly fake: FakeTool;
    readonly installed: boolean;
    credential: Credential | null;
    checkedAt: Timestamp | null;
    /** What the last check found besides an invalid credential; cleared by a passing check or new credentials. */
    failure: AiToolProblem | null;
    /** A lever: what the provider answers every check and verification with until cleared. */
    failingCheck: AiToolProblem | null;
}

interface Login {
    readonly status: HarnessLoginStatus;
    readonly userCode: string | null;
    readonly startedAt: number;
    readonly diagnostic: string | null;
}

interface SignInRecord {
    readonly id: AiToolSignInId;
    readonly aiToolId: string;
    readonly memberId: MemberId;
    readonly sessionId: SessionId;
    readonly client: ClientInfo;
    readonly startedAt: number;
    method: AiToolAuthMethod;
    done: boolean;
    promptSeq: number;
    error: string | null;
    login: Login | null;
}

export interface AiToolAuditInput {
    readonly actor: AuditActor;
    readonly action: AuditAction;
    readonly target: AuditTarget | null;
    readonly outcome: 'success' | 'denied' | 'failed';
    readonly client: ClientInfo | null;
    readonly details: AuditDetails | null;
}

/** Mutable on purpose, like the rest of the in-memory state. */
export interface InMemoryAiTools {
    /** In the engine's order; the first installed one is what chats run on. */
    readonly tools: Map<string, ToolRecord>;
    readonly signIns: Map<string, SignInRecord>;
    signInCount: number;
    /** Where a completed sign-in is audited, which no route's own rule sees; the core sets it. */
    audit: (input: AiToolAuditInput) => void;
}

/** Claude Code signed in with an account, Codex with an API key, Gemini CLI not installed; all checked at `now`. */
export function createInMemoryAiTools(now: Timestamp): InMemoryAiTools {
    const tools = new Map<string, ToolRecord>();
    for (const fake of FAKE_TOOLS) {
        const installed = fake.version !== null;
        tools.set(fake.id, {
            fake,
            installed,
            credential: !installed
                ? null
                : fake.id === 'codex'
                  ? { method: 'api-key', account: null, valid: true }
                  : { method: 'account', account: fake.account, valid: true },
            checkedAt: installed ? now : null,
            failure: null,
            failingCheck: null,
        });
    }
    return { tools, signIns: new Map(), signInCount: 0, audit: () => undefined };
}

const timestamp = (ms: number): Timestamp => Timestamp.parse(new Date(ms).toISOString());

function problemOf(record: ToolRecord): AiToolProblem | null {
    if (!record.installed) {
        return { code: 'not-installed', message: `${record.fake.name} is not installed on this server.` };
    }
    if (record.credential === null) {
        return { code: 'not-signed-in', message: `${record.fake.name} is not signed in on this project.` };
    }
    if (!record.credential.valid) {
        return {
            code: 'sign-in-expired',
            message: `${record.fake.provider} no longer accepts the ${record.fake.name} sign-in. Sign in again.`,
        };
    }
    return record.failure;
}

export function aiToolView(record: ToolRecord): AiTool {
    const problem = problemOf(record);
    const status = !record.installed
        ? 'not-installed'
        : problem === null
          ? 'signed-in'
          : problem.code === 'not-signed-in' || problem.code === 'sign-in-expired'
            ? 'needs-sign-in'
            : 'error';
    return {
        id: AiToolId.parse(record.fake.id),
        name: record.fake.name,
        version: record.fake.version,
        auth:
            record.credential === null
                ? null
                : { method: record.credential.method, account: record.credential.account },
        signInMethods: record.installed ? ['account', 'api-key'] : [],
        checkedAt: record.checkedAt,
        checking: false,
        status,
        problem,
    };
}

function changed(ctx: EngineContext, record: ToolRecord): void {
    ctx.publish({ type: 'ai-tool.changed', aiToolId: AiToolId.parse(record.fake.id) });
}

/** A real call through the tool: it answers, or the credential or the provider fails it. */
function runCheck(ctx: EngineContext, record: ToolRecord): void {
    record.checkedAt = ctx.now();
    const failing = record.failingCheck;
    if (record.credential === null || !record.credential.valid) {
        record.failure = null;
    } else if (failing?.code === 'sign-in-expired' || failing?.code === 'not-signed-in') {
        record.credential.valid = false;
        record.failure = null;
    } else {
        record.failure = failing;
    }
    changed(ctx, record);
}

/** The tool a new chat turn runs on, when it cannot: its sign-in needs renewing. `null` when chats can run. */
export function blockingAiTool(ctx: EngineContext): AiToolId | null {
    if (!advertises(ctx, KNOWN_CAPABILITIES.aiTools)) return null;
    const first = [...ctx.state.aiTools.tools.values()].find((record) => record.installed);
    return first !== undefined && aiToolView(first).status === 'needs-sign-in' ? AiToolId.parse(first.fake.id) : null;
}

const loginAlternative = (fake: FakeTool): OnboardingAlternative => ({
    id: OpaqueId.parse('api-key'),
    label: 'Use an API key instead',
    description: `Paste an ${fake.provider} API key; usage is billed to that key.`,
    href: null,
});
const keyAlternative = (fake: FakeTool): OnboardingAlternative => ({
    id: OpaqueId.parse('account'),
    label: 'Sign in with your account instead',
    description: `Use your ${fake.provider} account, as ${fake.name} does on a computer.`,
    href: null,
});

function promptOf(signIn: SignInRecord, fake: FakeTool): AiToolSignInPrompt {
    const base = {
        id: OpaqueId.parse(`${signIn.id}-prompt-${String(signIn.promptSeq)}`),
        error: signIn.error,
        canGoBack: false,
        details: [],
    };
    if (signIn.method === 'api-key') {
        return {
            ...base,
            kind: 'secret',
            title: `${fake.name} API key`,
            question: `Paste an ${fake.provider} API key for ${fake.name}.`,
            hint: 'The project keeps the key and never shows it again. It replaces the sign-in once it works.',
            alternatives: [keyAlternative(fake)],
            label: fake.keyLabel,
            placeholder: fake.keyPlaceholder,
            helpUrl: fake.keyHelpUrl,
        };
    }
    const login = signIn.login ?? { status: 'waiting', userCode: null, startedAt: signIn.startedAt, diagnostic: null };
    const device = fake.login === 'device-code';
    return {
        ...base,
        kind: 'harness-login',
        title: `Sign in to ${fake.name}`,
        question: device
            ? `Open the link on your phone or computer, sign in to ${fake.provider} and enter the code.`
            : `Open the link, sign in with your ${fake.provider} account and paste the code it shows you here.`,
        hint: device ? null : 'The code works for a few minutes. If it runs out, start the sign-in again.',
        alternatives: [loginAlternative(fake)],
        harness: fake.name,
        method: fake.login,
        url: fake.loginUrl,
        userCode: login.userCode,
        status: login.status,
        diagnostic: login.diagnostic,
        expiresAt: timestamp(login.startedAt + AI_TOOL_SIGN_IN_TTL_MS),
    };
}

function startLogin(ctx: EngineContext, signIn: SignInRecord, fake: FakeTool): void {
    signIn.promptSeq++;
    signIn.error = null;
    signIn.login = {
        status: 'waiting',
        userCode:
            fake.login === 'device-code'
                ? (DEVICE_CODES[ctx.state.aiTools.signInCount % DEVICE_CODES.length] ?? null)
                : null,
        startedAt: time(ctx.now()),
        diagnostic: null,
    };
}

function refuse(signIn: SignInRecord, error: string): void {
    signIn.promptSeq++;
    signIn.error = error;
}

/**
 * New credentials, verified with a real call before they replace anything: a failing provider leaves the old ones in
 * place and the sign-in where it was, with the provider's reason.
 */
function verify(ctx: EngineContext, signIn: SignInRecord, record: ToolRecord, credential: Credential): void {
    const failing = record.failingCheck;
    if (failing !== null) {
        if (signIn.method === 'api-key') {
            refuse(signIn, failing.message);
        } else if (signIn.login !== null) {
            signIn.login = { ...signIn.login, status: 'failed', diagnostic: failing.message };
        }
        return;
    }
    record.credential = credential;
    record.failure = null;
    record.checkedAt = ctx.now();
    signIn.done = true;
    signIn.login = null;
    changed(ctx, record);
    ctx.state.aiTools.audit({
        actor: { kind: 'member', memberId: signIn.memberId },
        action: 'ai-tool.sign-in.complete',
        target: { kind: 'ai-tool', id: record.fake.id, name: record.fake.name },
        outcome: 'success',
        client: signIn.client,
        details: { method: credential.method },
    });
}

/** Engine time moves a sign-in on: the device login confirms, a returned code runs out, the whole sign-in expires. */
function tick(ctx: EngineContext, signIn: SignInRecord): SignInRecord | null {
    const now = time(ctx.now());
    if (now >= signIn.startedAt + AI_TOOL_SIGN_IN_TTL_MS && !signIn.done) {
        ctx.state.aiTools.signIns.delete(signIn.id);
        return null;
    }
    const record = ctx.state.aiTools.tools.get(signIn.aiToolId);
    const login = signIn.login;
    if (record === undefined || login?.status !== 'waiting' || record.fake.login !== 'device-code') return signIn;
    if (now >= login.startedAt + AI_TOOL_DEVICE_LOGIN_MS) {
        verify(ctx, signIn, record, { method: 'account', account: record.fake.account, valid: true });
    }
    return signIn;
}

function signInView(signIn: SignInRecord, record: ToolRecord): AiToolSignIn {
    return {
        id: signIn.id,
        aiToolId: AiToolId.parse(record.fake.id),
        method: signIn.method,
        status: signIn.done ? 'completed' : 'pending',
        prompt: signIn.done ? null : promptOf(signIn, record.fake),
        activity: [],
        expiresAt: timestamp(signIn.startedAt + AI_TOOL_SIGN_IN_TTL_MS),
        tool: aiToolView(record),
    };
}

function installedTool(ctx: EngineContext, aiToolId: string): HandlerResult<ToolRecord> {
    const record = ctx.state.aiTools.tools.get(aiToolId);
    if (record === undefined) return notFound('AI tool');
    if (!record.installed) return fail('ai-tool-not-installed');
    return ok(record);
}

/** A sign-in of this tool that this gateway session started; anyone else's reads as missing. */
function ownSignIn(ctx: HandlerContext, aiToolId: string, signInId: string): SignInRecord | null {
    const signIn = ctx.state.aiTools.signIns.get(signInId);
    if (signIn?.aiToolId !== aiToolId || signIn.sessionId !== ctx.actor.sessionId) return null;
    return tick(ctx, signIn);
}

function answer(
    ctx: HandlerContext,
    signIn: SignInRecord,
    record: ToolRecord,
    body: Parameters<Handlers['answerAiToolSignIn']>[0]['body'],
): HandlerResult<null> {
    const prompt = promptOf(signIn, record.fake);
    if (body.action === 'alternative') {
        const offered = prompt.alternatives.some(({ id, href }) => id === body.alternativeId && href === null);
        if (!offered) return invalid('body.alternativeId', 'The prompt offers no such alternative to send.');
        if (signIn.method === 'api-key') {
            signIn.method = 'account';
            startLogin(ctx, signIn, record.fake);
        } else {
            signIn.method = 'api-key';
            signIn.login = null;
            signIn.promptSeq++;
            signIn.error = null;
        }
        return ok(null);
    }
    if (body.answer.kind !== prompt.kind) {
        return invalid('body.answer.kind', `The prompt asks for a ${prompt.kind} answer.`);
    }
    if (body.answer.kind === 'secret') {
        // Tested against the provider's shape, then dropped: a refusal is the same fixed text whatever was pasted.
        if (!record.fake.keyPattern.test(body.answer.value.trim())) {
            refuse(signIn, `${record.fake.provider} did not accept this key. Copy the whole key and try again.`);
            return ok(null);
        }
        verify(ctx, signIn, record, { method: 'api-key', account: null, valid: true });
        return ok(null);
    }
    const login = signIn.login;
    if (body.answer.returnCode === null || login?.status !== 'waiting') {
        ctx.state.aiTools.signInCount++;
        startLogin(ctx, signIn, record.fake);
        return ok(null);
    }
    if (record.fake.login === 'device-code') {
        refuse(signIn, 'This sign-in needs no code here: enter it on the provider’s page.');
        return ok(null);
    }
    if (!RETURN_CODE.test(body.answer.returnCode)) {
        refuse(signIn, 'That code does not look complete. Copy it again from the provider’s page.');
        return ok(null);
    }
    verify(ctx, signIn, record, { method: 'account', account: record.fake.account, valid: true });
    return ok(null);
}

export const AI_TOOL_HANDLERS: Pick<
    Handlers,
    | 'listAiTools'
    | 'getAiTool'
    | 'checkAiTool'
    | 'startAiToolSignIn'
    | 'getAiToolSignIn'
    | 'answerAiToolSignIn'
    | 'cancelAiToolSignIn'
    | 'signOutAiTool'
> = {
    listAiTools: (_, ctx) => ok({ items: [...ctx.state.aiTools.tools.values()].map(aiToolView) }),
    getAiTool: ({ params }, ctx) => {
        const record = ctx.state.aiTools.tools.get(params.aiToolId);
        return record === undefined ? notFound('AI tool') : ok(aiToolView(record));
    },
    checkAiTool: ({ params }, ctx) => {
        const tool = installedTool(ctx, params.aiToolId);
        if (tool.kind === 'problem') return tool;
        runCheck(ctx, tool.data);
        return ok(aiToolView(tool.data));
    },
    startAiToolSignIn: ({ params, body }, ctx) => {
        const tool = installedTool(ctx, params.aiToolId);
        if (tool.kind === 'problem') return tool;
        const record = tool.data;
        if (!aiToolView(record).signInMethods.includes(body.method)) return fail('ai-tool-method-unsupported');
        const { aiTools } = ctx.state;
        for (const [id, other] of aiTools.signIns) if (other.aiToolId === params.aiToolId) aiTools.signIns.delete(id);
        aiTools.signInCount++;
        const signIn: SignInRecord = {
            id: ctx.newId(AiToolSignInId, 'ai-tool-sign-in'),
            aiToolId: params.aiToolId,
            memberId: ctx.actor.memberId,
            sessionId: ctx.actor.sessionId,
            client: ctx.actor.client,
            startedAt: time(ctx.now()),
            method: body.method,
            done: false,
            promptSeq: 0,
            error: null,
            login: null,
        };
        if (body.method === 'account') startLogin(ctx, signIn, record.fake);
        aiTools.signIns.set(signIn.id, signIn);
        return ok(signInView(signIn, record));
    },
    getAiToolSignIn: ({ params }, ctx) => {
        const signIn = ownSignIn(ctx, params.aiToolId, params.signInId);
        const record = ctx.state.aiTools.tools.get(params.aiToolId);
        if (signIn === null || record === undefined) return notFound('sign-in');
        return ok(signInView(signIn, record));
    },
    answerAiToolSignIn: ({ params, body }, ctx) => {
        const signIn = ownSignIn(ctx, params.aiToolId, params.signInId);
        const record = ctx.state.aiTools.tools.get(params.aiToolId);
        if (signIn === null || record === undefined) return notFound('sign-in');
        if (signIn.done || body.promptId !== promptOf(signIn, record.fake).id) return fail('ai-tool-sign-in-stale');
        const answered = answer(ctx, signIn, record, body);
        if (answered.kind === 'problem') return answered;
        return ok(signInView(signIn, record));
    },
    cancelAiToolSignIn: ({ params }, ctx) => {
        const signIn = ownSignIn(ctx, params.aiToolId, params.signInId);
        if (signIn === null) return notFound('sign-in');
        ctx.state.aiTools.signIns.delete(signIn.id);
        return ok(null);
    },
    signOutAiTool: ({ params }, ctx) => {
        const tool = installedTool(ctx, params.aiToolId);
        if (tool.kind === 'problem') return tool;
        const record = tool.data;
        if (record.credential !== null || record.failure !== null) {
            record.credential = null;
            record.failure = null;
            changed(ctx, record);
        }
        return ok(aiToolView(record));
    },
};

function toolRecord(ctx: EngineContext, aiToolId: string): ToolRecord {
    const record = ctx.state.aiTools.tools.get(aiToolId);
    if (record === undefined) throw new Error(`No AI tool ${aiToolId}`);
    return record;
}

/** A lever: the provider stops accepting the tool's sign-in, as when a refresh token is rotated away. */
export function expireAiToolSignIn(ctx: EngineContext, aiToolId: string): AiTool {
    const record = toolRecord(ctx, aiToolId);
    if (record.credential === null) throw new Error(`${aiToolId} has no sign-in to expire`);
    record.credential.valid = false;
    changed(ctx, record);
    return aiToolView(record);
}

/** A lever: the provider accepts the tool's sign-in again, as after signing in on the host; a key-less tool gets one. */
export function renewAiToolSignIn(ctx: EngineContext, aiToolId: string): AiTool {
    const record = toolRecord(ctx, aiToolId);
    if (!record.installed) throw new Error(`${aiToolId} is not installed`);
    record.credential = record.credential ?? { method: 'account', account: record.fake.account, valid: true };
    record.credential.valid = true;
    record.failure = null;
    record.checkedAt = ctx.now();
    changed(ctx, record);
    return aiToolView(record);
}

/**
 * A lever: every check and verification of the tool fails this way until `null` heals it. `sign-in-expired` or
 * `not-signed-in` makes the next check find the sign-in expired.
 */
export function failAiToolCheck(ctx: EngineContext, aiToolId: string, problem: AiToolProblem | null): void {
    toolRecord(ctx, aiToolId).failingCheck = problem;
}

/** A lever: the provider answered the device login of the tool's open sign-in. */
export function settleAiToolSignIn(
    ctx: EngineContext,
    aiToolId: string,
    outcome: Extract<HarnessLoginStatus, 'succeeded' | 'failed' | 'expired' | 'denied'>,
    diagnostic?: string,
): void {
    const record = toolRecord(ctx, aiToolId);
    const signIn = [...ctx.state.aiTools.signIns.values()].find((candidate) => candidate.aiToolId === aiToolId);
    const open = signIn === undefined ? null : tick(ctx, signIn);
    if (open?.login?.status !== 'waiting') throw new Error(`No sign-in of ${aiToolId} waits for the provider`);
    if (outcome === 'succeeded') {
        verify(ctx, open, record, { method: 'account', account: record.fake.account, valid: true });
        return;
    }
    open.login = { ...open.login, status: outcome, diagnostic: diagnostic ?? 'The sign-in did not finish.' };
}

/** The tools as a member with `ai-tools.read` sees them. */
export function listAiTools(ctx: EngineContext): readonly AiTool[] {
    return [...ctx.state.aiTools.tools.values()].map(aiToolView);
}
