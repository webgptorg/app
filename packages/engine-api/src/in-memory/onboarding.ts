import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { MAX_ONBOARDING_FILES } from '../capabilities/onboarding';
import type {
    HarnessLoginStatus,
    OnboardingActivity,
    OnboardingAlternative,
    OnboardingAnswer,
    OnboardingPrompt,
    OnboardingState,
} from '../capabilities/onboarding';
import { OpaqueId, Timestamp } from '../common';
import { advertises, fail, invalid, ok, previewText, time } from './kit';
import type { EngineContext, Handlers } from './kit';

/**
 * The reference engine's onboarding script, a small stand-in for Reborn's App flow (`specs/app/onboarding.md`): the
 * brief with files, the harnesses, installing, signing in to and checking each one, the project's name and folder, a
 * review, then creating the project. It uses every prompt kind but `upload`; the texts are the engine's, and a real
 * engine words and orders its steps itself.
 */
type Step =
    | 'intent'
    | 'harnesses'
    | 'install'
    | 'sign-in'
    | 'api-key'
    | 'check'
    | 'title'
    | 'folder'
    | 'review'
    | 'create'
    | 'done';
export type OnboardingHarness = 'codex' | 'claude';

/**
 * `pending`: setup waits for the owner and the engine already has a project, so it may be skipped. `no-project`: an
 * engine paired before setup (Reborn `ptbk init --prepare-only --link`), which cannot be skipped until it is done.
 */
export type OnboardingSeed = 'pending' | 'no-project' | 'completed';

export type HarnessLoginOutcome = Extract<HarnessLoginStatus, 'succeeded' | 'failed' | 'expired' | 'denied'>;

interface Login {
    readonly status: HarnessLoginStatus;
    readonly userCode: string | null;
    readonly startedAt: number;
    readonly diagnostic: string | null;
}

export interface OnboardingRecord {
    step: Step;
    hasProject: boolean;
    deferred: boolean;
    promptId: string;
    error: string | null;
    intent: string;
    intentFileIds: readonly string[];
    harnesses: readonly OnboardingHarness[];
    /** Index into `harnesses` of the one being prepared. */
    preparing: number;
    /** Engine time the current step started; a working step ends a fixed time after it. */
    since: number;
    login: Login | null;
    attempts: number;
    ready: OnboardingHarness[];
    readonly failingChecks: Map<OnboardingHarness, string>;
    activity: OnboardingActivity[];
    title: string | null;
    folder: string | null;
}

/** A Codex device sign-in completes this long after it starts, unless a lever decides it first. */
export const DEVICE_LOGIN_MS = 5_000;
/** How long installing a harness, checking it and creating the project take in engine time. */
export const INSTALL_MS = 2_000;
export const CHECK_MS = 2_000;
export const CREATE_MS = 3_000;
export const HARNESS_TERMINAL_PATH = '/_ptbk/harness-terminal';
const LOGIN_TTL_MS = 15 * 60 * 1000;
const STAGES = 6;
const MAX_TITLE = 80;
const MAX_FOLDER = 40;
const RETURN_CODE = /^[A-Za-z0-9#_-]{6,512}$/;
/** What the reference engine takes for a key OpenAI accepts; anything else is refused as the provider would. */
const OPENAI_KEY = /^sk-[A-Za-z0-9_-]{20,}$/;
const FOLDER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Shaped like the codes Codex shows; not secret, they open nothing. */
const DEVICE_CODES = ['K7QF-3MRP', 'H2WD-8XNL', 'B9TC-4JZV', 'R5MG-6YKT'];

const HARNESSES: Readonly<
    Record<OnboardingHarness, { readonly label: string; readonly description: string; readonly preinstalled: boolean }>
> = {
    codex: { label: 'OpenAI Codex', description: 'Sign in with your ChatGPT account.', preinstalled: false },
    claude: { label: 'Claude Code', description: 'Sign in with your Claude account.', preinstalled: true },
};
const HARNESS_IDS = Object.keys(HARNESSES) as OnboardingHarness[];

const WORK_MS: Readonly<Partial<Record<Step, number>>> = { install: INSTALL_MS, check: CHECK_MS, create: CREATE_MS };
const STAGE: Readonly<Record<Step, number | null>> = {
    intent: 1,
    harnesses: 2,
    install: 3,
    'sign-in': 3,
    'api-key': 3,
    check: 3,
    title: 4,
    folder: 5,
    review: 6,
    create: 6,
    done: null,
};
const BACK: Readonly<Partial<Record<Step, Step>>> = {
    harnesses: 'intent',
    'sign-in': 'harnesses',
    'api-key': 'sign-in',
    title: 'harnesses',
    folder: 'title',
    review: 'folder',
};

const API_KEY: OnboardingAlternative = {
    id: 'api-key',
    label: 'Use an API key instead',
    description: 'Paste an OpenAI API key; usage is billed to that key.',
    href: null,
};
const TERMINAL: OnboardingAlternative = {
    id: 'terminal',
    label: 'Sign in in a terminal instead',
    description: 'Opens the engine’s own sign-in terminal in a new tab. Come back here when you are done.',
    href: HARNESS_TERMINAL_PATH,
};

export function createOnboardingRecord(seed: OnboardingSeed): OnboardingRecord {
    return {
        step: seed === 'completed' ? 'done' : 'intent',
        hasProject: seed !== 'no-project',
        deferred: false,
        promptId: 'onboarding-1',
        error: null,
        intent: '',
        intentFileIds: [],
        harnesses: ['codex'],
        preparing: 0,
        since: 0,
        login: null,
        attempts: 0,
        ready: [],
        failingChecks: new Map(),
        activity: [],
        title: null,
        folder: null,
    };
}

function enter(record: OnboardingRecord, step: Step, at: number, error: string | null = null): void {
    record.step = step;
    record.error = error;
    record.since = at;
    record.promptId = OpaqueId.parse(`onboarding-${String(Number(record.promptId.split('-')[1] ?? 0) + 1)}`);
}

function current(record: OnboardingRecord): OnboardingHarness {
    const harness = record.harnesses[record.preparing];
    if (harness === undefined) throw new Error('no harness is being prepared');
    return harness;
}

function report(record: OnboardingRecord, item: OnboardingActivity): void {
    const index = record.activity.findIndex(({ id }) => id === item.id);
    if (index === -1) record.activity.push(item);
    else record.activity[index] = item;
}

function reportInstall(record: OnboardingRecord, status: OnboardingActivity['status'], detail: string | null): void {
    const harness = current(record);
    report(record, {
        id: OpaqueId.parse(`install-${harness}`),
        label: `Install ${HARNESSES[harness].label}`,
        status,
        detail,
    });
}

function reportCheck(record: OnboardingRecord, status: OnboardingActivity['status'], detail: string | null): void {
    const harness = current(record);
    report(record, {
        id: OpaqueId.parse(`check-${harness}`),
        label: `Check ${HARNESSES[harness].label}`,
        status,
        detail,
    });
}

function install(record: OnboardingRecord, at: number): void {
    if (HARNESSES[current(record)].preinstalled) {
        reportInstall(record, 'skipped', 'Already installed on this engine.');
        signIn(record, at);
        return;
    }
    reportInstall(record, 'running', null);
    enter(record, 'install', at);
}

function signIn(record: OnboardingRecord, at: number): void {
    enter(record, 'sign-in', at);
    record.attempts++;
    record.login = {
        status: 'waiting',
        userCode:
            current(record) === 'codex' ? (DEVICE_CODES[(record.attempts - 1) % DEVICE_CODES.length] ?? null) : null,
        startedAt: at,
        diagnostic: null,
    };
}

function check(record: OnboardingRecord, at: number): void {
    reportCheck(record, 'running', null);
    enter(record, 'check', at);
}

function checked(record: OnboardingRecord, at: number): void {
    const harness = current(record);
    const reason = record.failingChecks.get(harness);
    reportCheck(record, reason === undefined ? 'done' : 'failed', reason ?? null);
    if (reason === undefined) record.ready.push(harness);
    record.login = null;
    record.preparing++;
    if (record.preparing < record.harnesses.length) {
        install(record, at);
    } else if (record.ready.length === 0) {
        enter(record, 'harnesses', at, 'None of the chosen tools passed its check. Choose another one.');
    } else {
        record.title ??= suggestedTitle(record.intent);
        enter(record, 'title', at);
    }
}

function suggestedTitle(intent: string): string {
    const line = previewText(intent.split('\n')[0] ?? '', MAX_TITLE);
    return line === null ? 'My project' : line.split(' ').slice(0, 5).join(' ');
}

function suggestedFolder(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, MAX_FOLDER)
        .replace(/^-+|-+$/g, '');
    return FOLDER.test(slug) ? slug : 'my-project';
}

/** When the current step ends by itself in engine time; `null` while it waits for the member or a lever. */
function dueAt(record: OnboardingRecord): number | null {
    const work = WORK_MS[record.step];
    if (work !== undefined) return record.since + work;
    const login = record.login;
    if (record.step !== 'sign-in' || login?.status !== 'waiting') return null;
    return login.startedAt + (current(record) === 'codex' ? DEVICE_LOGIN_MS : LOGIN_TTL_MS);
}

function advance(record: OnboardingRecord, at: number): void {
    if (record.step === 'install') {
        reportInstall(record, 'done', null);
        signIn(record, at);
    } else if (record.step === 'check') {
        checked(record, at);
    } else if (record.step === 'create') {
        record.activity = record.activity.map((item) => ({ ...item, status: 'done' }));
        record.hasProject = true;
        enter(record, 'done', at);
    } else if (current(record) === 'codex') {
        // A waiting sign-in: Codex's device flow completes; Claude's returned code was never pasted in time.
        check(record, at);
    } else if (record.login !== null) {
        record.login = {
            ...record.login,
            status: 'expired',
            diagnostic: 'The sign-in expired. Start it again for a new link.',
        };
    }
}

/** Engine time moves setup along: every step that ends by itself and is due by now has ended, in order. */
function tick(ctx: EngineContext): OnboardingRecord {
    const record = ctx.state.onboarding;
    const now = time(ctx.now());
    for (let due = dueAt(record); due !== null && due <= now; due = dueAt(record)) advance(record, due);
    return record;
}

/** A lever for tests and the mock's control listener: the provider answered the running sign-in. */
export function settleHarnessLogin(ctx: EngineContext, outcome: HarnessLoginOutcome, diagnostic?: string): void {
    const record = tick(ctx);
    if (record.step !== 'sign-in' || record.login === null) throw new Error('no harness sign-in is running');
    if (outcome === 'succeeded') {
        check(record, time(ctx.now()));
        return;
    }
    record.login = { ...record.login, status: outcome, diagnostic: diagnostic ?? 'The sign-in did not finish.' };
}

/** A lever for tests and the mock's control listener: the harness's check fails with `reason` whenever it runs. */
export function failHarnessCheck(ctx: EngineContext, harness: OnboardingHarness, reason: string): void {
    tick(ctx).failingChecks.set(harness, reason);
}

function base(record: OnboardingRecord) {
    return {
        id: record.promptId,
        error: record.error,
        canGoBack: BACK[record.step] !== undefined,
        details: [],
        alternatives: [],
    };
}

function loginPrompt(record: OnboardingRecord): OnboardingPrompt {
    const harness = current(record);
    const login = record.login ?? { status: 'waiting', userCode: null, startedAt: record.since, diagnostic: null };
    const codex = harness === 'codex';
    return {
        ...base(record),
        kind: 'harness-login',
        title: `Sign in to ${HARNESSES[harness].label}`,
        question: codex
            ? 'Open the link on your phone or computer, sign in with ChatGPT and enter the code.'
            : 'Open the link, sign in with your Claude account and paste the code it shows you here.',
        hint: codex
            ? 'Device-code sign-in may first need enabling in your ChatGPT security settings.'
            : 'The code works for a few minutes. If it runs out, start the sign-in again.',
        alternatives: codex ? [API_KEY, TERMINAL] : [TERMINAL],
        harness: HARNESSES[harness].label,
        method: codex ? 'device-code' : 'return-code',
        url: codex ? 'https://auth.openai.com/codex/device' : 'https://claude.ai/oauth/authorize',
        userCode: login.userCode,
        status: login.status,
        diagnostic: login.diagnostic,
        expiresAt: Timestamp.parse(new Date(login.startedAt + LOGIN_TTL_MS).toISOString()),
    };
}

function reviewDetails(record: OnboardingRecord) {
    const files = record.intentFileIds.length;
    return [
        { label: 'Project', text: record.title ?? '' },
        { label: 'Folder', text: record.folder ?? '' },
        { label: 'AI tools', text: record.ready.map((harness) => HARNESSES[harness].label).join(', ') },
        {
            label: 'Brief',
            text: previewText(record.intent, 280) ?? 'None yet: the project starts with a readiness review.',
        },
        ...(files === 0 ? [] : [{ label: 'Files', text: `${String(files)} attached` }]),
    ];
}

function prompt(ctx: EngineContext, record: OnboardingRecord): OnboardingPrompt | null {
    const text = {
        ...base(record),
        kind: 'text' as const,
        hint: null,
        multiline: false,
        required: true,
        placeholder: null,
        attachments: false,
    };
    switch (record.step) {
        case 'intent':
            return {
                ...text,
                title: 'Your project',
                question: 'What are you working on?',
                hint:
                    record.intentFileIds.length > 0
                        ? `${String(record.intentFileIds.length)} files are attached. New ones are added to them.`
                        : 'Describe it in your own words and attach notes or documents. A blank brief starts with a readiness review.',
                multiline: true,
                required: false,
                placeholder: 'For example: bookkeeping for my small business',
                initial: record.intent,
                attachments: advertises(ctx, KNOWN_CAPABILITIES.files),
            };
        case 'harnesses':
            return {
                ...base(record),
                kind: 'choice',
                title: 'AI tools',
                question: 'Which AI tools should your agents use?',
                hint: 'The engine installs each one, signs it in with your own account and checks that it answers.',
                multiple: true,
                choices: HARNESS_IDS.map((id) => ({
                    id,
                    label: HARNESSES[id].label,
                    description: HARNESSES[id].description,
                    disabled: false,
                })),
                initial: [...record.harnesses],
            };
        case 'sign-in':
            return loginPrompt(record);
        case 'api-key':
            return {
                ...base(record),
                kind: 'secret',
                title: `Sign in to ${HARNESSES[current(record)].label}`,
                question: 'Paste an OpenAI API key for Codex.',
                hint: 'The engine keeps the key with the project and never shows it again.',
                label: 'OpenAI API key',
                placeholder: 'sk-…',
                helpUrl: 'https://platform.openai.com/api-keys',
            };
        case 'title':
            return {
                ...text,
                title: 'Project name',
                question: 'What should this project be called?',
                initial: record.title ?? '',
            };
        case 'folder':
            return {
                ...text,
                title: 'Project folder',
                question: 'Choose a new folder name in your Promptbook projects home.',
                hint: 'Lowercase letters, digits and dashes.',
                initial: record.folder ?? '',
            };
        case 'review':
            return {
                ...base(record),
                kind: 'confirm',
                title: 'Create and start',
                question: `Create ${record.title ?? ''} in ${record.folder ?? ''} and start its agenda?`,
                hint: 'The engine saves the brief and its files in the project and gives Expert the first task.',
                details: reviewDetails(record),
                confirmLabel: 'Create and start',
                declineLabel: 'Change the folder',
            };
        case 'install':
        case 'check':
        case 'create':
        case 'done':
            return null;
    }
}

export function onboardingState(ctx: EngineContext): OnboardingState {
    const record = tick(ctx);
    const stage = STAGE[record.step];
    return {
        status: record.step === 'done' ? 'completed' : WORK_MS[record.step] === undefined ? 'pending' : 'working',
        deferred: record.deferred,
        canDefer: record.hasProject,
        progress: stage === null ? null : { step: stage, of: STAGES },
        activity: [...record.activity],
        prompt: prompt(ctx, record),
    };
}

function missingFile(ctx: EngineContext, fileIds: readonly string[]): boolean {
    return fileIds.some((id) => !ctx.state.files.has(id));
}

function answerText(ctx: EngineContext, record: OnboardingRecord, text: string, fileIds: readonly string[]): void {
    const at = time(ctx.now());
    if (record.step === 'intent') {
        const all = [...new Set([...record.intentFileIds, ...fileIds])];
        if (all.length > MAX_ONBOARDING_FILES || missingFile(ctx, all)) {
            enter(record, 'intent', at, `Attach up to ${String(MAX_ONBOARDING_FILES)} files you uploaded here.`);
            return;
        }
        record.intent = text;
        record.intentFileIds = all;
        record.title = null;
        record.folder = null;
        enter(record, 'harnesses', at);
    } else if (record.step === 'title') {
        const title = previewText(text, MAX_TITLE);
        if (title === null) {
            enter(record, 'title', at, 'Enter a project name.');
            return;
        }
        if (title !== record.title || record.folder === null) record.folder = suggestedFolder(title);
        record.title = title;
        enter(record, 'folder', at);
    } else {
        const folder = text.trim();
        if (folder.length > MAX_FOLDER || !FOLDER.test(folder)) {
            enter(record, 'folder', at, 'Use lowercase letters, digits and dashes, up to 40 characters.');
            return;
        }
        record.folder = folder;
        enter(record, 'review', at);
    }
}

function answerStep(ctx: EngineContext, record: OnboardingRecord, answer: OnboardingAnswer): void {
    const at = time(ctx.now());
    switch (answer.kind) {
        case 'text':
            answerText(ctx, record, answer.text, answer.fileIds);
            return;
        case 'choice': {
            const chosen = [...new Set(answer.choiceIds)];
            const known = chosen.filter((id): id is OnboardingHarness => id in HARNESSES);
            if (known.length === 0 || known.length !== chosen.length) {
                enter(record, 'harnesses', at, 'Choose at least one of the tools offered.');
                return;
            }
            record.harnesses = known;
            record.preparing = 0;
            record.ready = [];
            record.activity = [];
            install(record, at);
            return;
        }
        case 'harness-login': {
            if (answer.returnCode === null || record.login?.status !== 'waiting') {
                signIn(record, at);
                return;
            }
            if (current(record) === 'codex') {
                record.error = 'This sign-in needs no code here: enter it on the provider’s page.';
                return;
            }
            if (!RETURN_CODE.test(answer.returnCode)) {
                record.error = 'That code does not look complete. Copy it again from the provider’s page.';
                return;
            }
            check(record, at);
            return;
        }
        // The value is only tested, never kept: a refusal is the same fixed text whatever was pasted.
        case 'secret':
            if (OPENAI_KEY.test(answer.value)) check(record, at);
            else enter(record, 'api-key', at, 'OpenAI did not accept this key. Copy the whole key and try again.');
            return;
        case 'confirm':
            if (!answer.confirmed) {
                enter(record, 'folder', at);
                return;
            }
            record.activity = [
                {
                    id: OpaqueId.parse('create-project'),
                    label: `Create ${record.title ?? 'the project'}`,
                    status: 'running',
                    detail: null,
                },
            ];
            enter(record, 'create', at);
            return;
        case 'upload':
            // No step of this script asks for files on their own: they come with the brief.
            enter(record, record.step, at, 'This step takes no files.');
            return;
    }
}

function back(record: OnboardingRecord, to: Step, at: number): void {
    if (to === 'harnesses') {
        record.activity = [];
        record.login = null;
    }
    if (to === 'sign-in') signIn(record, at);
    else enter(record, to, at);
}

export const ONBOARDING_HANDLERS: Pick<Handlers, 'getOnboarding' | 'answerOnboarding' | 'deferOnboarding'> = {
    getOnboarding: (_, ctx) => ok(onboardingState(ctx)),
    answerOnboarding: ({ body }, ctx) => {
        const shown = onboardingState(ctx).prompt;
        const record = ctx.state.onboarding;
        if (shown === null || body.promptId !== shown.id) return fail('onboarding-prompt-stale');
        const at = time(ctx.now());
        switch (body.action) {
            case 'back': {
                const previous = BACK[record.step];
                if (previous === undefined) return invalid('body.action', 'This step has no previous one.');
                back(record, previous, at);
                break;
            }
            case 'alternative': {
                const offered = shown.alternatives.some(({ id, href }) => id === body.alternativeId && href === null);
                if (!offered) return invalid('body.alternativeId', 'The prompt offers no such alternative to send.');
                // `api-key` is the only alternative this script sends; the terminal is a link.
                record.login = null;
                enter(record, 'api-key', at);
                break;
            }
            case 'answer':
                if (body.answer.kind !== shown.kind) {
                    return invalid('body.answer.kind', `The prompt asks for a ${shown.kind} answer.`);
                }
                answerStep(ctx, record, body.answer);
        }
        return ok(onboardingState(ctx));
    },
    deferOnboarding: (_, ctx) => {
        const record = tick(ctx);
        if (!record.hasProject) return fail('onboarding-not-deferrable');
        if (record.step !== 'done') record.deferred = true;
        return ok(onboardingState(ctx));
    },
};
