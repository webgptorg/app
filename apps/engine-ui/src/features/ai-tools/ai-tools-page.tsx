import type { AiToolAuthMethod, ReadAiTool } from '@ptbk/engine-api';
import {
    ActionMenu,
    Button,
    ConfirmDialog,
    EmptyState,
    RelativeTime,
    Section,
    Skeleton,
    StatusPill,
    useToast,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, KeyRound, LogIn, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { MetaDot } from '../security/security-parts';
import { Crumb, Page } from '../shell/page';
import { AiToolSignInDialog } from './ai-tool-sign-in-dialog';
import { authLabel, problemLabel, statusLabel, statusTone } from './ai-tool-labels';
import { AI_TOOLS_MANAGE, aiToolKeys, useAiTools } from './ai-tools-queries';

const REQUEST_TIMEOUT_MS = 30_000;

interface SigningIn {
    readonly tool: ReadAiTool;
    readonly method: AiToolAuthMethod;
}

/** The method the owner most likely wants: the account sign-in the tool had, else the first the engine offers. */
function preferredMethod(tool: ReadAiTool): AiToolAuthMethod | null {
    const offered = tool.signInMethods.filter((method) => method !== 'unknown');
    const current = tool.auth?.method;
    if (current !== undefined && current !== 'unknown' && offered.includes(current)) return current;
    return offered[0] ?? null;
}

function ToolRow({
    tool,
    manages,
    checking,
    onCheck,
    onSignIn,
    onSignOut,
}: {
    readonly tool: ReadAiTool;
    readonly manages: boolean;
    readonly checking: boolean;
    readonly onCheck: () => void;
    readonly onSignIn: (method: AiToolAuthMethod) => void;
    readonly onSignOut: () => void;
}) {
    const installed = tool.status !== 'not-installed';
    const preferred = preferredMethod(tool);
    const auth = authLabel(tool.auth);
    const menu: MenuEntry[] = [];
    if (manages && installed) {
        for (const method of tool.signInMethods) {
            if (method === 'unknown') continue;
            menu.push({
                kind: 'item',
                id: `sign-in-${method}`,
                label: method === 'api-key' ? m.ai_tools_use_api_key() : m.ai_tools_sign_in_account(),
                icon: method === 'api-key' ? <KeyRound aria-hidden /> : <LogIn aria-hidden />,
                onSelect: () => {
                    onSignIn(method);
                },
            });
        }
        if (tool.auth !== null) {
            if (menu.length > 0) menu.push({ kind: 'separator', id: 'separator' });
            menu.push({
                kind: 'item',
                id: 'sign-out',
                label: m.ai_tools_sign_out(),
                icon: <LogOut aria-hidden />,
                tone: 'danger',
                onSelect: onSignOut,
            });
        }
    }
    return (
        <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
                <span
                    aria-hidden
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-neutral-soft text-text-muted [&>svg]:size-4"
                >
                    <Bot />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        {/* Tool names and the engine's messages are text nodes only. */}
                        <span className="text-sm font-medium">{tool.name}</span>
                        <StatusPill tone={tool.checking ? 'live' : statusTone(tool.status)}>
                            {tool.checking ? m.ai_tools_checking() : statusLabel(tool.status)}
                        </StatusPill>
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-muted tabular-nums">
                        {auth === null ? null : <span>{auth}</span>}
                        {installed ? (
                            <>
                                {auth === null ? null : <MetaDot />}
                                {tool.checkedAt === null ? (
                                    <span>{m.ai_tools_never_checked()}</span>
                                ) : (
                                    <span>
                                        {m.ai_tools_checked()} <RelativeTime value={new Date(tool.checkedAt)} />
                                    </span>
                                )}
                            </>
                        ) : null}
                    </span>
                    {tool.problem === null ? null : (
                        <p className="text-sm [overflow-wrap:anywhere]">
                            <span className={tool.status === 'needs-sign-in' ? 'text-danger' : undefined}>
                                {problemLabel(tool.problem.code)}
                            </span>{' '}
                            <span className="text-text-muted">{tool.problem.message}</span>
                        </p>
                    )}
                </div>
            </div>
            {installed ? (
                <div className="flex shrink-0 items-center gap-1 ps-11 sm:ps-0">
                    {manages && tool.status === 'needs-sign-in' && preferred !== null ? (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                                onSignIn(preferred);
                            }}
                        >
                            {m.ai_tools_sign_in_again()}
                        </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" loading={checking || tool.checking} onClick={onCheck}>
                        {m.ai_tools_check_now()}
                    </Button>
                    {menu.length === 0 ? null : (
                        <ActionMenu
                            label={m.ai_tools_actions_for({ name: tool.name })}
                            variant="ghost"
                            size="sm"
                            items={menu}
                        />
                    )}
                </div>
            ) : null}
        </li>
    );
}

/**
 * The AI tools the project's agents work with: whether each one can work right now, how it signs in, and the owner's
 * way to sign it in again from the browser. `?signIn=<tool>` opens that tool's sign-in, e.g. from a failed chat reply.
 */
export function AiToolsPage() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const toast = useToast();
    const tools = useAiTools();
    const manages = useAllows(AI_TOOLS_MANAGE);
    const search = useSearch({ from: '/settings_/ai-tools' });
    const navigate = useNavigate({ from: '/settings/ai-tools' });
    const [signingIn, setSigningIn] = useState<SigningIn | null>(null);
    const [signingOut, setSigningOut] = useState<ReadAiTool | null>(null);

    // A link that asks for one tool's sign-in opens it once the list is in, then drops the request from the URL so a
    // reload does not start another sign-in.
    const asked = search.signIn === undefined ? undefined : tools.data?.find(({ id }) => id === search.signIn);
    const [answered, setAnswered] = useState<string | undefined>(undefined);
    if (asked !== undefined && asked.id !== answered) {
        setAnswered(asked.id);
        const method = preferredMethod(asked);
        if (manages && method !== null && asked.status !== 'not-installed') setSigningIn({ tool: asked, method });
    }
    useEffect(() => {
        if (answered !== undefined) void navigate({ search: {}, replace: true });
    }, [answered, navigate]);

    const check = useStepUpAwareMutation({
        mutationFn: async (tool: ReadAiTool) =>
            unwrap(await engineApi.aiTools.check(tool.id, AbortSignal.timeout(REQUEST_TIMEOUT_MS))),
        invalidates: [aiToolKeys.list()],
        errorMessage: (_, tool) => m.ai_tools_check_failed({ name: tool.name }),
        // A check still running reports through the list; one that finds a problem is a warning, never a success.
        onSuccess: (checked) => {
            if (checked.checking) return;
            if (checked.status === 'signed-in') {
                toast.show({ tone: 'success', title: m.ai_tools_check_passed({ name: checked.name }) });
            } else {
                toast.show({ tone: 'warning', title: m.ai_tools_check_problem({ name: checked.name }) });
            }
        },
    });
    const signOut = useStepUpAwareMutation({
        mutationFn: async (tool: ReadAiTool) =>
            unwrap(await engineApi.aiTools.signOut(tool.id, AbortSignal.timeout(REQUEST_TIMEOUT_MS))),
        invalidates: [aiToolKeys.list()],
        successMessage: (_, tool) => m.ai_tools_signed_out({ name: tool.name }),
        errorMessage: (_, tool) => m.ai_tools_sign_out_failed({ name: tool.name }),
        onSuccess: () => {
            setSigningOut(null);
        },
    });

    return (
        <Page
            title={m.ai_tools_title()}
            description={m.ai_tools_intro()}
            width="reading"
            breadcrumbs={[
                <Crumb key="settings" to="/settings">
                    {m.settings_title()}
                </Crumb>,
            ]}
        >
            <Section title={m.ai_tools_section()} divided={false}>
                {tools.data === undefined ? (
                    tools.isError ? (
                        <EmptyState variant="inline" headingLevel={3} icon={<Bot />} title={m.ai_tools_load_failed()} />
                    ) : (
                        <Skeleton shape="block" className="h-32 w-full" />
                    )
                ) : tools.data.length === 0 ? (
                    <EmptyState variant="inline" headingLevel={3} icon={<Bot />} title={m.ai_tools_empty()} />
                ) : (
                    <ul className="flex flex-col divide-y divide-hairline">
                        {tools.data.map((tool) => (
                            <ToolRow
                                key={tool.id}
                                tool={tool}
                                manages={manages}
                                checking={check.isPending && check.variables.id === tool.id}
                                onCheck={() => {
                                    check.mutate(tool);
                                }}
                                onSignIn={(method) => {
                                    setSigningIn({ tool, method });
                                }}
                                onSignOut={() => {
                                    setSigningOut(tool);
                                }}
                            />
                        ))}
                    </ul>
                )}
            </Section>
            <p className="text-xs text-text-muted">{m.ai_tools_trust()}</p>
            {signingIn === null ? null : (
                <AiToolSignInDialog
                    tool={signingIn.tool}
                    method={signingIn.method}
                    onClose={() => {
                        setSigningIn(null);
                        void queryClient.invalidateQueries({ queryKey: aiToolKeys.list() });
                    }}
                />
            )}
            <ConfirmDialog
                open={signingOut !== null}
                onClose={() => {
                    setSigningOut(null);
                }}
                onConfirm={() => {
                    if (signingOut !== null) signOut.mutate(signingOut);
                }}
                title={m.ai_tools_sign_out_title({ name: signingOut?.name ?? '' })}
                description={m.ai_tools_sign_out_body({ name: signingOut?.name ?? '' })}
                confirmLabel={m.ai_tools_sign_out()}
                tone="danger"
                loading={signOut.isPending}
            />
        </Page>
    );
}
