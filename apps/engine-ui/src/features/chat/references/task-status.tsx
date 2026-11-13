import { cx } from '../../../app/cx';
import { m } from '../../../paraglide/messages';
import type { ReadChatTask } from './thread-references';

export type ChatTaskState = ReadChatTask['state'];

/** How loud a state is: live work pulses, trouble is red, done is green, the rest is quiet. */
export type ChatTaskTone = 'live' | 'waiting' | 'trouble' | 'done' | 'quiet';

export function chatTaskTone(state: ChatTaskState): ChatTaskTone {
    switch (state) {
        case 'running':
            return 'live';
        case 'queued':
        case 'waiting':
            return 'waiting';
        case 'blocked':
        case 'failed':
            return 'trouble';
        case 'completed':
            return 'done';
        case 'cancelled':
        case 'retired':
        case 'unknown':
            return 'quiet';
    }
}

export function chatTaskStateLabel(state: ChatTaskState): string {
    switch (state) {
        case 'queued':
            return m.chat_task_state_queued();
        case 'running':
            return m.chat_task_state_running();
        case 'waiting':
            return m.chat_task_state_waiting();
        case 'blocked':
            return m.chat_task_state_blocked();
        case 'completed':
            return m.chat_task_state_completed();
        case 'failed':
            return m.chat_task_state_failed();
        case 'cancelled':
            return m.chat_task_state_cancelled();
        case 'retired':
            return m.chat_task_state_retired();
        case 'unknown':
            return m.chat_task_state_unknown();
    }
}

/** `--tint` for a soft surface in a task's state colour. */
export const CHAT_TASK_TINT_CLASSES: Readonly<Record<ChatTaskTone, string>> = {
    live: '[--tint:var(--color-live)]',
    waiting: '[--tint:var(--color-info)]',
    trouble: '[--tint:var(--color-danger)]',
    done: '[--tint:var(--color-success)]',
    quiet: '[--tint:var(--color-text-muted)]',
};

const DOT_CLASSES: Readonly<Record<ChatTaskTone, string>> = {
    live: 'bg-live motion-safe:animate-breathe',
    waiting: 'bg-info',
    trouble: 'bg-danger',
    done: 'bg-success',
    quiet: 'bg-text-muted',
};

/** The small status dot; decorative, so a label always goes with it. */
export function StatusDot({ tone, className }: { readonly tone: ChatTaskTone; readonly className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cx('inline-block size-2 shrink-0 rounded-full', DOT_CLASSES[tone], className)}
        />
    );
}

/** The dot and the state in words, never colour alone. */
export function TaskStatus({ state, className }: { readonly state: ChatTaskState; readonly className?: string }) {
    return (
        <span className={cx('inline-flex items-center gap-1.5', className)}>
            <StatusDot tone={chatTaskTone(state)} />
            {chatTaskStateLabel(state)}
        </span>
    );
}
