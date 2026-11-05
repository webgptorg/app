import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type {
    HarnessLoginStatus,
    OnboardingAnswer,
    OnboardingPrompt,
    OnboardingState,
} from '../capabilities/onboarding';
import { OpaqueId, Timestamp } from '../common';
import { advertises, fail, invalid, ok, time } from './kit';
import type { EngineContext, Handlers } from './kit';

/**
 * The reference engine's onboarding script, a small stand-in for Reborn's `ptbk init`: intent, one harness, its
 * native sign-in, optional files, done. The texts are the engine's; a real engine words and orders them itself.
 */
type Step = 'intent' | 'harness' | 'login' | 'files' | 'done';
type Harness = 'codex' | 'claude';

export type HarnessLoginOutcome = Extract<HarnessLoginStatus, 'succeeded' | 'failed' | 'expired' | 'denied'>;

interface Login {
    readonly status: HarnessLoginStatus;
    readonly userCode: string | null;
    readonly startedAt: number;
    readonly diagnostic: string | null;
}

export interface OnboardingRecord {
    step: Step;
    deferred: boolean;
    promptId: string;
    error: string | null;
    intent: string;
    intentFileIds: readonly string[];
    harness: Harness;
    login: Login | null;
    attempts: number;
    fileIds: readonly string[];
}

/** A Codex device sign-in completes this long after it starts, unless a lever decides it first. */
export const DEVICE_LOGIN_MS = 5_000;
const LOGIN_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOADS = 10;
const RETURN_CODE = /^[A-Za-z0-9#_-]{6,512}$/;
/** Shaped like the codes Codex shows; not secret, they open nothing. */
const DEVICE_CODES = ['K7QF-3MRP', 'H2WD-8XNL', 'B9TC-4JZV', 'R5MG-6YKT'];

const HARNESSES: Readonly<Record<Harness, { readonly label: string; readonly description: string }>> = {
    codex: { label: 'OpenAI Codex', description: 'Sign in with your ChatGPT account.' },
    claude: { label: 'Claude Code', description: 'Sign in with your Claude account.' },
};

export function createOnboardingRecord(status: 'pending' | 'completed'): OnboardingRecord {
    return {
        step: status === 'pending' ? 'intent' : 'done',
        deferred: false,
        promptId: 'onboarding-1',
        error: null,
        intent: '',
        intentFileIds: [],
        harness: 'codex',
        login: null,
        attempts: 0,
        fileIds: [],
    };
}

function withFiles(ctx: EngineContext): boolean {
    return advertises(ctx, KNOWN_CAPABILITIES.files);
}

function steps(ctx: EngineContext): readonly Step[] {
    return withFiles(ctx) ? ['intent', 'harness', 'login', 'files'] : ['intent', 'harness', 'login'];
}

function moveTo(ctx: EngineContext, record: OnboardingRecord, step: Step, error: string | null = null): void {
    record.step = step;
    record.error = error;
    record.promptId = OpaqueId.parse(`onboarding-${String(Number(record.promptId.split('-')[1] ?? 0) + 1)}`);
    if (step === 'login') startLogin(ctx, record);
}

function startLogin(ctx: EngineContext, record: OnboardingRecord): void {
    record.attempts++;
    record.login = {
        status: 'waiting',
        userCode:
            record.harness === 'codex' ? (DEVICE_CODES[(record.attempts - 1) % DEVICE_CODES.length] ?? null) : null,
        startedAt: time(ctx.now()),
        diagnostic: null,
    };
}

function afterLogin(ctx: EngineContext, record: OnboardingRecord): void {
    moveTo(ctx, record, withFiles(ctx) ? 'files' : 'done');
}

/** Engine time decides a device sign-in: it completes after `DEVICE_LOGIN_MS` and expires after 15 minutes. */
function tick(ctx: EngineContext): OnboardingRecord {
    const record = ctx.state.onboarding;
    const login = record.login;
    if (record.step !== 'login' || login?.status !== 'waiting') return record;
    const elapsed = time(ctx.now()) - login.startedAt;
    if (elapsed >= LOGIN_TTL_MS) {
        record.login = {
            ...login,
            status: 'expired',
            diagnostic: 'The sign-in expired. Start it again for a new code.',
        };
    } else if (record.harness === 'codex' && elapsed >= DEVICE_LOGIN_MS) {
        record.login = { ...login, status: 'succeeded' };
        afterLogin(ctx, record);
    }
    return record;
}

/** A lever for tests and the mock's control listener: the provider answered the running sign-in. */
export function settleHarnessLogin(ctx: EngineContext, outcome: HarnessLoginOutcome, diagnostic?: string): void {
    const record = ctx.state.onboarding;
    if (record.step !== 'login' || record.login === null) throw new Error('no harness sign-in is running');
    if (outcome === 'succeeded') {
        record.login = { ...record.login, status: 'succeeded' };
        afterLogin(ctx, record);
        return;
    }
    record.login = { ...record.login, status: outcome, diagnostic: diagnostic ?? 'The sign-in did not finish.' };
}

function prompt(ctx: EngineContext, record: OnboardingRecord): OnboardingPrompt | null {
    const base = { id: record.promptId, error: record.error };
    switch (record.step) {
        case 'intent':
            return {
                ...base,
                kind: 'text',
                title: 'Your project',
                question: 'What are you working on?',
                hint: 'Describe it in your own words. Paste notes or long text: the engine keeps it exactly as written.',
                canGoBack: false,
                multiline: true,
                required: false,
                placeholder: 'For example: bookkeeping for my small business',
                initial: record.intent,
                attachments: false,
            };
        case 'harness':
            return {
                ...base,
                kind: 'choice',
                title: 'AI tool',
                question: 'Which AI tool should your agents use?',
                hint: 'Your agents work through your own subscription. You can add another tool later.',
                canGoBack: true,
                multiple: false,
                choices: (Object.keys(HARNESSES) as Harness[]).map((id) => ({
                    id,
                    label: HARNESSES[id].label,
                    description: HARNESSES[id].description,
                    disabled: false,
                })),
                initial: [record.harness],
            };
        case 'login': {
            const login = record.login ?? { status: 'waiting', userCode: null, startedAt: 0, diagnostic: null };
            const codex = record.harness === 'codex';
            return {
                ...base,
                kind: 'harness-login',
                title: `Sign in to ${HARNESSES[record.harness].label}`,
                question: codex
                    ? 'Open the link on your phone or computer, sign in with ChatGPT and enter the code.'
                    : 'Open the link, sign in with your Claude account and paste the code it shows you here.',
                hint: codex
                    ? 'Device-code sign-in may first need enabling in your ChatGPT security settings.'
                    : 'Sign in on the provider’s page only. Nobody from Promptbook will ask for your password.',
                canGoBack: true,
                harness: HARNESSES[record.harness].label,
                method: codex ? 'device-code' : 'return-code',
                url: codex ? 'https://auth.openai.com/codex/device' : 'https://claude.ai/oauth/authorize',
                userCode: login.userCode,
                status: login.status,
                diagnostic: login.diagnostic,
                expiresAt: Timestamp.parse(new Date(login.startedAt + LOGIN_TTL_MS).toISOString()),
            };
        }
        case 'files':
            return {
                ...base,
                kind: 'upload',
                title: 'Files',
                question: 'Anything the engine should read first?',
                hint: 'Specs, notes or documents. You can skip this and add files later.',
                canGoBack: true,
                required: false,
                maxFiles: MAX_UPLOADS,
            };
        case 'done':
            return null;
    }
}

export function onboardingState(ctx: EngineContext): OnboardingState {
    const record = tick(ctx);
    const current = prompt(ctx, record);
    const all = steps(ctx);
    return {
        status: current === null ? 'completed' : 'pending',
        deferred: record.deferred,
        progress: current === null ? null : { step: all.indexOf(record.step) + 1, of: all.length },
        prompt: current,
    };
}

function missingFile(ctx: EngineContext, fileIds: readonly string[]): boolean {
    return fileIds.some((id) => !ctx.state.files.has(id));
}

function answerStep(ctx: EngineContext, record: OnboardingRecord, answer: OnboardingAnswer): void {
    switch (answer.kind) {
        case 'text':
            if (missingFile(ctx, answer.fileIds)) {
                moveTo(ctx, record, record.step, 'A file is missing.');
                return;
            }
            record.intent = answer.text;
            record.intentFileIds = answer.fileIds;
            moveTo(ctx, record, 'harness');
            return;
        case 'choice': {
            const [choice] = answer.choiceIds;
            if (answer.choiceIds.length !== 1 || (choice !== 'codex' && choice !== 'claude')) {
                moveTo(ctx, record, record.step, 'Choose one tool.');
                return;
            }
            record.harness = choice;
            moveTo(ctx, record, 'login');
            return;
        }
        case 'harness-login': {
            const login = record.login;
            if (answer.returnCode === null || login === null || login.status !== 'waiting') {
                moveTo(ctx, record, 'login');
                return;
            }
            if (record.harness === 'codex') {
                record.error = 'This sign-in needs no code here: enter it on the provider’s page.';
                return;
            }
            if (!RETURN_CODE.test(answer.returnCode)) {
                record.error = 'That code does not look complete. Copy it again from the provider’s page.';
                return;
            }
            record.login = { ...login, status: 'succeeded' };
            afterLogin(ctx, record);
            return;
        }
        case 'upload':
            if (missingFile(ctx, answer.fileIds)) {
                moveTo(ctx, record, record.step, 'A file is missing.');
                return;
            }
            record.fileIds = answer.fileIds;
            moveTo(ctx, record, 'done');
            return;
        case 'confirm': {
            moveTo(ctx, record, record.step);
            return;
        }
    }
}

const BACK: Readonly<Partial<Record<Step, Step>>> = { harness: 'intent', login: 'harness', files: 'harness' };

export const ONBOARDING_HANDLERS: Pick<Handlers, 'getOnboarding' | 'answerOnboarding' | 'deferOnboarding'> = {
    getOnboarding: (_, ctx) => ok(onboardingState(ctx)),
    answerOnboarding: ({ body }, ctx) => {
        const current = onboardingState(ctx).prompt;
        const record = ctx.state.onboarding;
        if (current === null || body.promptId !== current.id) return fail('onboarding-prompt-stale');
        if (body.action === 'back') {
            const previous = BACK[record.step];
            if (previous === undefined) return invalid('body.action', 'This step has no previous one.');
            moveTo(ctx, record, previous);
            return ok(onboardingState(ctx));
        }
        if (body.answer.kind !== current.kind) {
            return invalid('body.answer.kind', `The prompt asks for a ${current.kind} answer.`);
        }
        answerStep(ctx, record, body.answer);
        return ok(onboardingState(ctx));
    },
    deferOnboarding: (_, ctx) => {
        ctx.state.onboarding.deferred = true;
        return ok(onboardingState(ctx));
    },
};
