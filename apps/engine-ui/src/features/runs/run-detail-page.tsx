import { KNOWN_CAPABILITIES, RunId } from '@ptbk/engine-api';
import type { ChatId, ReadRun, ReadRunDetail, TaskId, TriggerId } from '@ptbk/engine-api';
import {
    Banner,
    CodeText,
    EmptyState,
    ErrorState,
    RelativeTime,
    Section,
    Skeleton,
    useLocale,
    viewTransitionStyle,
} from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { FileText, GitCommitHorizontal, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { isPageLevelFailure } from '../../app/list-errors';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { chatName } from '../chat/chat-name';
import { chatQueryOptions } from '../chat/chat-queries';
import { EntityChip } from '../entities/entity-chip';
import { Crumb, Page } from '../shell/page';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { taskQueryOptions } from '../tasks/tasks-queries';
import { triggerQueryOptions } from '../triggers/triggers-queries';
import { DiffView } from './diff-view';
import { RunActions } from './run-actions';
import { finishedDurationMs, NotReported, RunCost, RunDuration, runTitle } from './run-format';
import { runSourceLabel } from './run-source';
import { RunStatusPill } from './run-status';
import { StepsSection, ToolCallsSection } from './run-timeline';
import { runListQueryOptions, runQueryOptions } from './runs-queries';

const route = getRouteApi('/runs/$runId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One run: what started it, its steps, tool calls, error and outputs, with stop and retry where allowed. */
export function RunDetailPage() {
    const runId = RunId.safeParse(route.useParams().runId).data;
    return runId === undefined ? <RunNotFound /> : <LoadedRunDetail runId={runId} />;
}

/**
 * Where the run sits: the agent's Runs tab when the member opened it there, else all runs. The trail replaces the
 * old "Back to …" link.
 */
function useRunCrumbs(run: Pick<ReadRun, 'agentId' | 'agentName'> | null): ReactNode[] {
    const { from } = route.useSearch();
    if (from === 'agent' && run !== null) {
        return [
            <Crumb key="agent" to="/agents/$agentId" params={{ agentId: run.agentId }}>
                {run.agentName ?? run.agentId}
            </Crumb>,
            <Crumb key="runs" to="/agents/$agentId/runs" params={{ agentId: run.agentId }}>
                {m.runs_title()}
            </Crumb>,
        ];
    }
    return [
        <Crumb key="runs" to="/runs">
            {m.runs_title()}
        </Crumb>,
    ];
}

function LoadedRunDetail({ runId }: { readonly runId: RunId }) {
    const run = useQuery({ ...runQueryOptions(useEngineApi(), runId), throwOnError: isPageLevelFailure });
    const crumbs = useRunCrumbs(null);
    if (run.isPending) return <RunDetailSkeleton />;
    if (run.isError) {
        if (isNotFound(run.error)) return <RunNotFound />;
        return (
            <Page title={m.run_title_loading()} breadcrumbs={crumbs}>
                <ErrorState
                    message={m.run_load_failed()}
                    onRetry={() => {
                        void run.refetch();
                    }}
                    retrying={run.isFetching}
                />
            </Page>
        );
    }
    return <RunDetail run={run.data} />;
}

function RunDetail({ run }: { readonly run: ReadRunDetail }) {
    const narrow = useMediaQuery(NARROW_QUERY);
    const retry = useRetryOf(run);
    const crumbs = useRunCrumbs(run);
    const actions = <RunActions run={run} retried={retry !== null} />;
    const hasOutputs =
        run.outputs.messages.length > 0 || run.outputs.files.length > 0 || run.outputs.projectChanges.length > 0;
    return (
        <Page
            title={runTitle(run)}
            documentTitle={[runTitle(run), m.runs_title()]}
            breadcrumbs={crumbs}
            titleStyle={viewTransitionStyle('run-title', run.id)}
            {...(narrow ? {} : { actions })}
        >
            <RunSummary run={run} />
            {run.error === null ? null : (
                <Banner tone="danger" title={runErrorTitle(run.error.code)}>
                    <span className="flex flex-col gap-1.5">
                        {/* The summary may quote what the agent read: text only. */}
                        <span className="break-words whitespace-pre-wrap">{run.error.summary}</span>
                        <span className="text-xs text-text-muted">
                            {m.run_error_code()} <span className="font-mono">{run.error.code}</span>
                        </span>
                        {retry === null ? null : (
                            <span className="flex flex-wrap items-center gap-2">
                                {m.run_retried_as()}
                                <EntityChip
                                    kind="run"
                                    id={retry.id}
                                    name={m.run_retried_new()}
                                    status={retry.status === 'running' ? 'live' : undefined}
                                />
                            </span>
                        )}
                    </span>
                </Banner>
            )}
            {run.progress === null ? null : <StepsSection run={run} progress={run.progress} />}
            {run.toolCalls.length === 0 ? null : <ToolCallsSection run={run} />}
            {hasOutputs ? <OutputsSection run={run} /> : null}
            <RunDetails run={run} />
            {narrow ? (
                <div className="sticky bottom-0 z-10 -mx-4 border-t border-hairline bg-surface px-4 py-3 empty:hidden">
                    {actions}
                </div>
            ) : null}
        </Page>
    );
}

// Codes are open slugs (the engine may add more); known ones get a plain title, the rest a generic one.
function runErrorTitle(code: string): string {
    switch (code) {
        case 'tool-error':
            return m.run_error_tool();
        case 'tool-timeout':
        case 'timeout':
            return m.run_error_timeout();
        case 'agent-unavailable':
            return m.run_error_agent_unavailable();
        default:
            return m.run_error_generic();
    }
}

/** Only the first page after the failed run is searched: a retry is queued right after it, so it is nearly always there. */
const RETRY_LOOKUP_LIMIT = 50;

/** The run that retried this failed one, if any; the contract has no reverse link, so it is looked up among later runs. */
function useRetryOf(run: ReadRunDetail): ReadRun | null {
    const params = { agentId: run.agentId, from: run.queuedAt, sort: 'queuedAt', limit: RETRY_LOOKUP_LIMIT } as const;
    const later = useQuery({ ...runListQueryOptions(useEngineApi(), params), enabled: run.status === 'failed' });
    return later.data?.items.find((candidate) => candidate.retryOf === run.id) ?? null;
}

function SummaryItem({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
        </div>
    );
}

/** One quiet line under the title: the state, then who ran it, what started it and how long it took, as chips. */
function RunSummary({ run }: { readonly run: ReadRunDetail }) {
    const cost = run.usage?.cost ?? null;
    const showDuration = (run.status === 'running' && run.startedAt !== null) || finishedDurationMs(run) !== null;
    return (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
            <SummaryItem label={m.run_fact_status()}>
                <RunStatusPill status={run.status} cancelling={run.cancelRequestedAt !== null} />
            </SummaryItem>
            <SummaryItem label={m.run_fact_agent()}>
                <EntityChip kind="agent" id={run.agentId} name={run.agentName ?? run.agentId} />
            </SummaryItem>
            <SummaryItem label={m.run_fact_source()}>
                <Source run={run} />
            </SummaryItem>
            {run.taskId === null ? null : (
                <SummaryItem label={m.run_fact_task()}>
                    <RunTask taskId={run.taskId} />
                </SummaryItem>
            )}
            {run.retryOf === null ? null : (
                <SummaryItem label={m.run_fact_retry_of()}>
                    <EntityChip kind="run" id={run.retryOf} name={m.run_fact_retry_of_link()} />
                </SummaryItem>
            )}
            <SummaryItem label={m.run_fact_queued()}>
                <RelativeTime value={new Date(run.queuedAt)} className="tabular-nums" />
            </SummaryItem>
            {showDuration ? (
                <SummaryItem label={m.run_usage_duration()}>
                    <span className="tabular-nums">
                        <RunDuration run={run} />
                    </span>
                </SummaryItem>
            ) : null}
            {cost === null ? null : (
                <SummaryItem label={m.run_usage_cost()}>
                    <span className="tabular-nums">
                        <RunCost cost={cost} />
                    </span>
                </SummaryItem>
            )}
        </dl>
    );
}

/** The task this run worked on, by name; without `tasks@1` the chip is left out. */
function RunTask({ taskId }: { readonly taskId: TaskId }) {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const task = useQuery({ ...taskQueryOptions(useEngineApi(), taskId), enabled: allowed });
    if (!allowed) return null;
    return <EntityChip kind="task" id={taskId} name={task.data?.name ?? m.run_fact_task()} />;
}

/** A chat by its title once the engine has it, else by what the run's reply is ("Open the reply in its chat"). */
function ChatChip({ chatId, fallback }: { readonly chatId: ChatId; readonly fallback: string }) {
    const allowed = useAllows({ permission: 'chats.read' });
    const chat = useQuery({ ...chatQueryOptions(useEngineApi(), chatId), enabled: allowed });
    return <EntityChip kind="chat" id={chatId} name={chat.data === undefined ? fallback : chatName(chat.data)} />;
}

/** How the run started: the chat or the trigger as a chip, the channel quiet before it ("Email · (chat)"). */
function Source({ run }: { readonly run: ReadRunDetail }) {
    const label = runSourceLabel(run.source);
    if (run.chatId !== null) {
        return (
            <>
                {run.source === 'web' ? null : <span>{label}</span>}
                <ChatChip chatId={run.chatId} fallback={m.run_source_web()} />
            </>
        );
    }
    if (run.triggerId !== null) return <TriggerSource label={label} triggerId={run.triggerId} />;
    return <span>{label}</span>;
}

/** "Schedule · (Weekly report)", the trigger by name, never its ID. */
function TriggerSource({ label, triggerId }: { readonly label: string; readonly triggerId: TriggerId }) {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.triggers, permission: 'triggers.read' });
    const trigger = useQuery({ ...triggerQueryOptions(useEngineApi(), triggerId), enabled: allowed });
    let name: ReactNode = null;
    if (trigger.data !== undefined) {
        name = <EntityChip kind="trigger" id={triggerId} name={trigger.data.name} />;
    } else if (trigger.isError && isNotFound(trigger.error)) {
        name = <span>{m.run_source_trigger_deleted()}</span>;
    }
    return (
        <>
            <span>{label}</span>
            {name}
        </>
    );
}

/** One property: its name quiet on the left, the value beside it. */
function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-6 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string | null }) {
    const locale = useLocale();
    if (at === null) return <span className="text-text-muted">{m.run_value_not_yet()}</span>;
    return (
        <time dateTime={at} className="tabular-nums">
            {locale.formatDateTime(new Date(at))}
        </time>
    );
}

function hasTokenUsage(run: ReadRunDetail): boolean {
    return (
        (run.usage?.inputTokens !== null && run.usage?.inputTokens !== undefined) ||
        (run.usage?.outputTokens !== null && run.usage?.outputTokens !== undefined)
    );
}

/** Exact times, how the run ran and what it used, as quiet property rows for whoever investigates. */
function RunDetails({ run }: { readonly run: ReadRunDetail }) {
    const locale = useLocale();
    const tokens = (value: number | null | undefined) =>
        value === null || value === undefined ? (
            <NotReported />
        ) : (
            <span className="tabular-nums">{locale.formatNumber(value)}</span>
        );
    return (
        <Section title={m.run_details_title()}>
            <dl className="flex max-w-2xl flex-col">
                <Property label={m.run_fact_queued()}>
                    <DateTime at={run.queuedAt} />
                </Property>
                <Property label={m.run_fact_started()}>
                    <DateTime at={run.startedAt} />
                </Property>
                <Property label={m.run_fact_completed()}>
                    <DateTime at={run.completedAt} />
                </Property>
                <Property label={m.run_fact_attempt()}>
                    <span className="tabular-nums">{run.attemptCount}</span>
                </Property>
                <Property label={m.run_fact_runner()}>{run.runner ?? <NotReported />}</Property>
                <Property label={m.run_fact_model()}>{run.model ?? <NotReported />}</Property>
                {hasTokenUsage(run) ? (
                    <>
                        <Property label={m.run_usage_input_tokens()}>{tokens(run.usage?.inputTokens)}</Property>
                        <Property label={m.run_usage_output_tokens()}>{tokens(run.usage?.outputTokens)}</Property>
                    </>
                ) : null}
            </dl>
        </Section>
    );
}

/** One output as a hairline row: its type icon, then the chip. */
function OutputRow({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
    return (
        <li className="grid min-h-10 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 py-2">
            <span className="flex h-6 items-center text-text-muted [&>svg]:size-4">{icon}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">{children}</span>
        </li>
    );
}

/** What the run left behind: replies and files as chips, then each project change with its files and diff. */
function OutputsSection({ run }: { readonly run: ReadRunDetail }) {
    const { messages, files, fileNames, projectChanges } = run.outputs;
    const count = messages.length + files.length + projectChanges.length;
    return (
        <Section title={m.run_outputs_title()} count={count}>
            {messages.length === 0 && files.length === 0 ? null : (
                <ul className="flex flex-col divide-y divide-hairline">
                    {messages.map((message) => (
                        <OutputRow key={message.messageId} icon={<MessageSquare aria-hidden />}>
                            <span className="text-text-muted">{m.run_outputs_message()}</span>
                            <ChatChip chatId={message.chatId} fallback={m.run_outputs_message_link()} />
                        </OutputRow>
                    ))}
                    {files.map((fileId, index) => (
                        <OutputRow key={fileId} icon={<FileText aria-hidden />}>
                            <span className="text-text-muted">{m.run_outputs_file()}</span>
                            <EntityChip kind="file" id={fileId} name={fileNames[index] ?? fileId} />
                        </OutputRow>
                    ))}
                </ul>
            )}
            {projectChanges.map((change, index) => (
                <ProjectChangeView key={`${change.commitHash}-${String(index)}`} change={change} />
            ))}
        </Section>
    );
}

function ProjectChangeView({ change }: { readonly change: ReadRunDetail['outputs']['projectChanges'][number] }) {
    const locale = useLocale();
    return (
        <section className="flex flex-col gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="flex items-center gap-2 text-sm font-medium break-words">
                    <GitCommitHorizontal aria-hidden className="size-4 shrink-0 text-text-muted" />
                    {m.run_project_title({ project: change.projectName })}
                </h3>
                <span className="flex items-center gap-1.5 text-xs text-text-muted">
                    {m.run_project_commit()}
                    <CodeText value={change.commitHash} copyable copyLabel={m.run_project_copy_commit()} />
                </span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <caption className="sr-only">
                        {m.run_project_files_caption({ project: change.projectName })}
                    </caption>
                    <thead>
                        <tr className="text-left text-xs text-text-muted">
                            <th scope="col" className="py-1.5 pr-3 font-medium">
                                {m.run_project_file_path()}
                            </th>
                            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                                {m.run_project_file_insertions()}
                            </th>
                            <th scope="col" className="py-1.5 text-right font-medium">
                                {m.run_project_file_deletions()}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {change.changedFiles.map((file) => (
                            <tr key={file.path} className="border-t border-hairline">
                                <td className="py-2 pr-3 font-mono text-xs break-all">{file.path}</td>
                                <td className="py-2 pr-3 text-right text-success tabular-nums">
                                    {m.run_project_insertions({ count: locale.formatNumber(file.insertions) })}
                                </td>
                                <td className="py-2 text-right text-danger tabular-nums">
                                    {m.run_project_deletions({ count: locale.formatNumber(file.deletions) })}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <DiffView
                diff={change.diff}
                truncated={change.diffTruncated}
                label={m.run_project_diff_label({ project: change.projectName })}
            />
        </section>
    );
}

function RunNotFound() {
    return (
        <Page
            title={m.run_not_found_title()}
            breadcrumbs={[
                <Crumb key="runs" to="/runs">
                    {m.runs_title()}
                </Crumb>,
            ]}
        >
            <EmptyState
                title={m.run_not_found_title()}
                description={m.run_not_found_body()}
                action={<ButtonLink to="/runs">{m.run_back_to_runs()}</ButtonLink>}
            />
        </Page>
    );
}

/** Shaped like the header, the facts line and the sections, so nothing jumps when the run arrives. */
export function RunDetailSkeleton() {
    return (
        <section aria-busy="true" aria-label={m.run_title_loading()} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2 py-3">
                <Skeleton shape="text" className="h-4 w-16" />
                <Skeleton shape="text" className="h-7 w-2/3" />
            </div>
            <div className="flex flex-wrap gap-3">
                {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} shape="text" className="h-6 w-24" />
                ))}
            </div>
            {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} shape="block" className="h-32 w-full" />
            ))}
        </section>
    );
}
