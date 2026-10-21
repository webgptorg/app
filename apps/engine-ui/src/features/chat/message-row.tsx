import { Badge, Button, Spinner } from '@ptbk/ui';
import type { Ref } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { AgentCreator } from '../agents/agent-creator';
import type { MessageState, MessageView } from './message-views';
import { MessageMarkdown } from './render/lazy-markdown';
import { PlainText } from './render/plain-text';

function StateLabel({ state }: { readonly state: MessageState }) {
    switch (state) {
        case 'streaming':
            return (
                <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" announce={false} />
                    {m.chat_status_streaming()}
                </span>
            );
        case 'stopped':
            return <Badge>{m.chat_status_stopped()}</Badge>;
        case 'interrupted':
            return <Badge tone="warning">{m.chat_status_interrupted()}</Badge>;
        case 'failed':
            return <Badge tone="danger">{m.chat_status_failed()}</Badge>;
        case 'pending':
        case null:
            return null;
    }
}

function Author({ view, agentName }: { readonly view: MessageView; readonly agentName: string }) {
    if (view.role === 'agent') return <span>{agentName}</span>;
    if (view.createdBy === null) return <span>{m.chat_started_by_visitor()}</span>;
    return <AgentCreator memberId={view.createdBy} />;
}

export interface MessageRowProps {
    readonly view: MessageView;
    readonly agentName: string;
    readonly onRetry: () => void;
    /** `data-index` for the virtualiser's measurement; absent when every row is mounted. */
    readonly index?: number;
    readonly ref?: Ref<HTMLElement>;
}

/** One message: who wrote it, its state, and its text. Agent output only ever reaches the DOM as text nodes. */
export function MessageRow({ view, agentName, onRetry, index, ref }: MessageRowProps) {
    const fromMember = view.role === 'user';
    return (
        <article
            ref={ref}
            data-index={index}
            data-message-id={view.id}
            aria-busy={view.state === 'streaming' || view.state === 'pending' || undefined}
            className={cx('flex min-w-0 flex-col gap-1 py-2', fromMember ? 'items-end' : 'items-start')}
        >
            <header className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                <span className="font-medium text-text">
                    <Author view={view} agentName={agentName} />
                </span>
                <StateLabel state={view.state} />
                {view.retry ? (
                    <Button size="sm" onClick={onRetry}>
                        {m.error_retry()}
                    </Button>
                ) : null}
            </header>
            <div
                className={cx(
                    'max-w-full min-w-0 rounded-surface px-4 py-3 sm:max-w-[min(48rem,90%)]',
                    fromMember ? 'bg-accent-soft' : 'border border-divider bg-raised',
                    view.state === 'pending' && 'opacity-80',
                )}
            >
                {view.markdown ? <MessageMarkdown source={view.text} /> : <PlainText text={view.text} />}
            </div>
        </article>
    );
}
