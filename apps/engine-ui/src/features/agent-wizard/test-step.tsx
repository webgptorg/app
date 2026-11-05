import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AgentId, ChatId } from '@ptbk/engine-api';
import { Button, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentSourceQueryOptions } from '../book/book-queries';
import { TestChatPanel } from '../book/test-chat/test-chat-panel';
import { ChatPanel } from '../chat/chat-panel';
import { chatKeys } from '../chat/chat-keys';
import { chatQueryOptions } from '../chat/chat-queries';
import { usePermissions } from '../session/use-permissions';
import { StepFrame } from './step-frame';

const CREATE_TIMEOUT_MS = 30_000;

/** Tall enough to read a reply, short enough that the step's actions stay on screen. */
const CHAT_HEIGHT = 'h-[55dvh] min-h-80';

export interface TestStepProps {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly chatId: ChatId | undefined;
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly onChatCreated: (chatId: ChatId) => void;
    readonly onBack: () => void;
    readonly onFinish: () => void;
}

/** A conversation the engine never stores, with the book the agent was just created with. */
function ThrowawayTestChat({ agentId, agentName }: { readonly agentId: AgentId; readonly agentName: string }) {
    const navigate = useNavigate();
    const source = useQuery(agentSourceQueryOptions(useEngineApi(), agentId));
    if (source.isPending) return <Skeleton shape="block" className={`${CHAT_HEIGHT} w-full`} />;
    if (source.isError) {
        return (
            <ErrorState
                message={m.wizard_test_error()}
                onRetry={() => void source.refetch()}
                retrying={source.isFetching}
            />
        );
    }
    return (
        <TestChatPanel
            agentId={agentId}
            book={source.data.source}
            agentName={agentName}
            intro={m.wizard_test_not_kept()}
            // The engine accepted this book when it created the agent; should it refuse it now, the editor shows why.
            onInvalidBook={() => undefined}
            onShowProblems={() => {
                void navigate({ to: '/agents/$agentId/book', params: { agentId } });
            }}
            className={CHAT_HEIGHT}
        />
    );
}

function KeptTestChat({ chatId }: { readonly chatId: ChatId }) {
    const chat = useQuery(chatQueryOptions(useEngineApi(), chatId));
    const { can } = usePermissions();
    if (chat.isPending) return <Skeleton shape="block" className={`${CHAT_HEIGHT} w-full`} />;
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
        <div className={`flex flex-col ${CHAT_HEIGHT}`}>
            <ChatPanel chat={chat.data} canWrite={can('chats.write')} fill />
        </div>
    );
}

/**
 * Step 4: a test conversation with the new agent. Where the engine offers throwaway test chats (`test-chat@1`) it is
 * one, as in the book editor; otherwise it is a real chat, started explicitly and kept with the agent's chats.
 */
export function TestStep({ agentId, agentName, chatId, headingRef, onChatCreated, onBack, onFinish }: TestStepProps) {
    const engineApi = useEngineApi();
    const { can } = usePermissions();
    const throwaway = useAllows({ capability: KNOWN_CAPABILITIES.testChat, permission: 'agents.write' });
    const start = useStepUpAwareMutation({
        mutationFn: async () =>
            unwrap(
                await engineApi.chats.create(
                    { agentId, title: m.wizard_test_chat_title() },
                    AbortSignal.timeout(CREATE_TIMEOUT_MS),
                ),
            ),
        invalidates: [chatKeys.lists()],
        onSuccess: (chat) => {
            onChatCreated(chat.id);
        },
    });

    let content: ReactNode;
    let description = m.wizard_test_body_kept({ name: agentName });
    if (throwaway) {
        content = <ThrowawayTestChat agentId={agentId} agentName={agentName} />;
        description = m.wizard_test_body({ name: agentName });
    } else if (chatId !== undefined) content = <KeptTestChat chatId={chatId} />;
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
            description={description}
            headingRef={headingRef}
            actions={
                <>
                    <Button variant="ghost" onClick={onBack}>
                        {m.wizard_back()}
                    </Button>
                    <Button variant="primary" onClick={onFinish}>
                        {m.wizard_finish()}
                    </Button>
                </>
            }
        >
            {content}
        </StepFrame>
    );
}
