import type { AgentId, ChatId } from '@ptbk/engine-api';
import { Button, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { ChatPanel } from '../chat/chat-panel';
import { chatKeys } from '../chat/chat-keys';
import { chatQueryOptions } from '../chat/chat-queries';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { StepFrame } from './step-frame';

const CREATE_TIMEOUT_MS = 30_000;

export interface TestStepProps {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly chatId: ChatId | undefined;
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly onChatCreated: (chatId: ChatId) => void;
    readonly onNext: () => void;
    readonly onCancel: () => void;
}

function TestChat({ chatId, agentName }: { readonly chatId: ChatId; readonly agentName: string }) {
    const chat = useQuery(chatQueryOptions(useEngineApi(), chatId));
    const me = useCurrentMember();
    const { can } = usePermissions();
    if (chat.isPending) return <Skeleton shape="block" className="h-96 w-full" />;
    if (chat.isError) {
        return (
            <ErrorState
                message={m.wizard_test_error()}
                onRetry={() => void chat.refetch()}
                retrying={chat.isFetching}
            />
        );
    }
    return (
        <ChatPanel
            chat={chat.data}
            agentName={agentName}
            canWrite={can('chats.write') && chat.data.createdBy === me.memberId}
        />
    );
}

/** Step 4: a chat with the new agent, through the same panel as the agent's Chat tab. Starting one is explicit. */
export function TestStep({ agentId, agentName, chatId, headingRef, onChatCreated, onNext, onCancel }: TestStepProps) {
    const engineApi = useEngineApi();
    const { can } = usePermissions();
    const start = useStepUpAwareMutation({
        mutationFn: async () =>
            unwrap(
                await engineApi.chats.create(
                    agentId,
                    { title: m.wizard_test_chat_title() },
                    AbortSignal.timeout(CREATE_TIMEOUT_MS),
                ),
            ),
        invalidates: [chatKeys.lists()],
        onSuccess: (chat) => {
            onChatCreated(chat.id);
        },
    });

    let content: ReactNode;
    if (chatId !== undefined) content = <TestChat chatId={chatId} agentName={agentName} />;
    else if (can('chats.write')) {
        content = (
            <Button
                variant="secondary"
                className="self-start"
                loading={start.isPending}
                onClick={() => {
                    if (!start.isPending) start.mutate();
                }}
            >
                <MessageSquare aria-hidden className="size-4" />
                {m.wizard_test_start()}
            </Button>
        );
    } else content = <p className="text-sm text-text-muted">{m.wizard_test_unavailable()}</p>;

    return (
        <StepFrame
            title={m.wizard_test_title()}
            description={m.wizard_test_body({ name: agentName })}
            headingRef={headingRef}
            actions={
                <>
                    <Button variant="ghost" onClick={onCancel}>
                        {m.wizard_cancel()}
                    </Button>
                    <Button variant="primary" onClick={onNext}>
                        {m.wizard_next()}
                    </Button>
                </>
            }
        >
            {content}
        </StepFrame>
    );
}
