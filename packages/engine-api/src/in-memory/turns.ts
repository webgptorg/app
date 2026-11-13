import { MAX_REPLY_STEP_TEXT_LENGTH, MAX_REPLY_STEPS, ReplyStep } from '../chats';
import type { Message, ParticipantRef, ReplyStepKind, ReplyStepLevel } from '../chats';
import { Timestamp } from '../common';
import type { EngineContext } from './kit';
import { time } from './kit';
import type { ChatRecord, WorkingRecord } from './threads';
import { appendMessage, join, sameParticipant, touch } from './threads';

/** Step changes reach listeners at most this often per thread; anything else is announced at once. */
export const STEP_ANNOUNCE_INTERVAL_MS = 1_000;
/** How long after a failed reply the engine attempts it again by itself. */
export const RECHECK_DELAY_MS = 2 * 60_000;
export const REPLY_FAILED_CAUSE = 'The reply failed.';

/** A step as a script or a lever reports it; the engine cuts its text to one line and the contract's length. */
export interface StepInput {
    readonly kind: ReplyStepKind;
    /** Required for a `tool` step, refused on any other. */
    readonly tool?: string | null;
    readonly text: string;
    readonly level?: ReplyStepLevel;
}

export function toStep(input: StepInput): ReplyStep {
    const text = input.text.replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_STEP_TEXT_LENGTH);
    return ReplyStep.parse({ kind: input.kind, tool: input.tool ?? null, text, level: input.level ?? 'info' });
}

/** The readable form of a `progress` message, for clients that do not show steps: one line per step. */
export function renderSteps(steps: readonly ReplyStep[]): string {
    return steps
        .map((step) => {
            switch (step.kind) {
                case 'reasoning':
                    return `- thinking: ${step.text}`;
                case 'tool':
                    return `- ${step.tool ?? ''} ${step.text}`.trimEnd();
                case 'note':
                    return step.level === 'info' ? `- ${step.text}` : `- ${step.level}: ${step.text}`;
            }
        })
        .join('\n');
}

export function workingOf(record: ChatRecord, author: ParticipantRef): WorkingRecord | undefined {
    return record.working.find((working) => sameParticipant(working.author, author));
}

/** An agent's turn starts: the thread shows it working before it has written or done anything. Callers announce it. */
export function beginTurn(
    ctx: EngineContext,
    record: ChatRecord,
    input: { readonly author: ParticipantRef; readonly prompt: string; readonly rounds?: number },
): WorkingRecord {
    join(ctx, record, input.author);
    const working: WorkingRecord = {
        startedAt: ctx.now(),
        author: input.author,
        messageId: null,
        steps: [],
        prompt: input.prompt,
        rounds: input.rounds ?? 0,
    };
    record.working.push(working);
    return working;
}

/** A step of a turn in progress; listeners hear of it within `STEP_ANNOUNCE_INTERVAL_MS`. */
export function addStep(ctx: EngineContext, record: ChatRecord, working: WorkingRecord, step: ReplyStep): void {
    working.steps.push(step);
    announceSteps(ctx, record);
}

/**
 * A busy agent may report many steps a second; announcing each would make every listener refetch the thread as often.
 * The first change is announced at once, later ones together once the interval has passed since the last.
 */
function announceSteps(ctx: EngineContext, record: ChatRecord): void {
    if (record.stepsAnnouncePending) return;
    const nowMs = time(ctx.now());
    const wait =
        record.stepsAnnouncedAt === null ? 0 : Math.max(0, record.stepsAnnouncedAt + STEP_ANNOUNCE_INTERVAL_MS - nowMs);
    if (wait === 0) {
        record.stepsAnnouncedAt = nowMs;
        touch(ctx, record);
        return;
    }
    record.stepsAnnouncePending = true;
    ctx.replies.sleep(wait, new AbortController().signal).then(
        () => {
            record.stepsAnnouncePending = false;
            record.stepsAnnouncedAt = time(ctx.now());
            touch(ctx, record);
        },
        () => {
            record.stepsAnnouncePending = false;
        },
    );
}

/**
 * The agent starts writing its reply: the turn's steps are saved first as `progress` messages (as many as the step
 * limit needs), then the reply itself, `final` when progress came before it.
 */
export function startText(
    ctx: EngineContext,
    record: ChatRecord,
    working: WorkingRecord,
    input: { readonly content: string; readonly status: Message['status']; readonly choices?: readonly string[] },
): Message {
    for (let start = 0; start < working.steps.length; start += MAX_REPLY_STEPS) {
        const steps = working.steps.slice(start, start + MAX_REPLY_STEPS);
        appendMessage(ctx, record, {
            author: working.author,
            content: renderSteps(steps),
            status: 'completed',
            phase: 'progress',
            steps,
        });
    }
    const reply = appendMessage(ctx, record, {
        author: working.author,
        content: input.content,
        status: input.status,
        phase: working.steps.length > 0 ? 'final' : null,
        ...(input.choices === undefined ? {} : { choices: input.choices }),
    });
    working.messageId = reply.id;
    return reply;
}

export type TurnOutcome =
    | { readonly kind: 'completed' }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'failed'; readonly cause: string };

/**
 * The turn is over; a failed one leaves a recheck the engine attempts at `nextAt`, or sooner when asked to. Callers
 * announce it, together with the reply's own change.
 */
export function endTurn(ctx: EngineContext, record: ChatRecord, working: WorkingRecord, outcome: TurnOutcome): void {
    const index = record.working.indexOf(working);
    if (index === -1) return;
    record.working.splice(index, 1);
    if (outcome.kind === 'failed') {
        record.recheck = {
            cause: outcome.cause,
            nextAt: Timestamp.parse(new Date(time(ctx.now()) + RECHECK_DELAY_MS).toISOString()),
            rounds: working.rounds + 1,
            author: working.author,
            prompt: working.prompt,
        };
    }
}

/** The turn writing `messageId`, if one still does. */
export function turnWriting(record: ChatRecord, messageId: string): WorkingRecord | undefined {
    return record.working.find((working) => working.messageId === messageId);
}
