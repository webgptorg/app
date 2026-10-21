import { RunId } from '@ptbk/engine-api';
import type { ReadRunDetail, ToolCall } from '@ptbk/engine-api';
import { Badge, Banner, Card, CodeText, EmptyState, ErrorState, Skeleton, useLocale } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { CircleCheck, Circle } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink, Link } from '../../app/link';
import { isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { sourceLabel } from '../chat/chat-source';
import { Page } from '../shell/page';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { DiffView } from './diff-view';
import { RunActions } from './run-actions';
import { formatDuration, ReportedDuration, RunCost, runTitle } from './run-format';
import { RunStatusBadge } from './run-status';
import { runQueryOptions } from './runs-queries';

const route = getRouteApi('/runs/$runId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One run: what started it, its steps, tool calls, usage, error and outputs, with cancel and retry where allowed. */
export function RunDetailPage() {
    const runId = RunId.safeParse(route.useParams().runId).data;
    return runId === undefined ? <RunNotFound /> : <LoadedRunDetail runId={runId} />;
}

function LoadedRunDetail({ runId }: { readonly runId: RunId }) {
    const run = useQuery({ ...runQueryOptions(useEngineApi(), runId), throwOnError: isPageLevelFailure });
    if (run.isPending) return <RunDetailSkeleton />;
    if (run.isError) {
        if (isNotFound(run.error)) return <RunNotFound />;
        return (
            <Page title={m.run_title_loading()}>
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
    const actions = <RunActions run={run} />;
    return (
        <Page title={runTitle(run)} {...(narrow ? {} : { actions })}>
            <RunHeader run={run} />
            {run.error === null ? null : (
                <Banner tone="danger" title={m.run_error_title({ code: run.error.code })}>
                    {/* The summary may quote what the agent read: text only. */}
                    <span className="break-words whitespace-pre-wrap">{run.error.summary}</span>
                </Banner>
            )}
            <StepsSection run={run} />
            <ToolCallsSection toolCalls={run.toolCalls} />
            <UsageSection run={run} />
            <OutputsSection run={run} />
            {narrow ? (
                <div className="sticky bottom-0 z-10 -mx-4 border-t border-divider bg-raised px-4 py-3 empty:hidden">
                    {actions}
                </div>
            ) : null}
        </Page>
    );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function Unknown() {
    return <span className="text-text-muted">{m.run_value_unknown()}</span>;
}

function DateTime({ at }: { readonly at: string | null }) {
    const locale = useLocale();
    if (at === null) return <span className="text-text-muted">{m.run_value_not_yet()}</span>;
    return <time dateTime={at}>{locale.formatDateTime(new Date(at))}</time>;
}

function Source({ run }: { readonly run: ReadRunDetail }) {
    const label = sourceLabel(run.source);
    if (run.chatId !== null) {
        return (
            <Link to="/agents/$agentId/chat/$chatId" params={{ agentId: run.agentId, chatId: run.chatId }}>
                {m.run_source_chat({ source: label })}
            </Link>
        );
    }
    if (run.triggerId !== null) {
        return (
            <span>
                {m.run_source_trigger({ source: label })} <CodeText value={run.triggerId} />
            </span>
        );
    }
    return <span>{label}</span>;
}

function RunHeader({ run }: { readonly run: ReadRunDetail }) {
    return (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <Fact label={m.run_fact_status()}>
                <RunStatusBadge status={run.status} cancelling={run.cancelRequestedAt !== null} />
            </Fact>
            <Fact label={m.run_fact_source()}>
                <Source run={run} />
            </Fact>
            <Fact label={m.run_fact_agent()}>
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }}>
                    {run.agentName ?? run.agentId}
                </Link>
            </Fact>
            <Fact label={m.run_fact_queued()}>
                <DateTime at={run.queuedAt} />
            </Fact>
            <Fact label={m.run_fact_started()}>
                <DateTime at={run.startedAt} />
            </Fact>
            <Fact label={m.run_fact_completed()}>
                <DateTime at={run.completedAt} />
            </Fact>
            <Fact label={m.run_fact_attempt()}>{run.attemptCount}</Fact>
            <Fact label={m.run_fact_runner()}>{run.runner ?? <Unknown />}</Fact>
            <Fact label={m.run_fact_model()}>{run.model ?? <Unknown />}</Fact>
            {run.retryOf === null ? null : (
                <Fact label={m.run_fact_retry_of()}>
                    <Link to="/runs/$runId" params={{ runId: run.retryOf }}>
                        {m.run_fact_retry_of_link()}
                    </Link>
                </Fact>
            )}
        </dl>
    );
}

function StepsSection({ run }: { readonly run: ReadRunDetail }) {
    const progress = run.progress;
    return (
        <Card title={m.run_steps_title()}>
            {progress === null ? (
                <p className="text-sm text-text-muted">{m.run_steps_none()}</p>
            ) : (
                <div className="flex flex-col gap-3" aria-live={run.status === 'running' ? 'polite' : 'off'}>
                    <p className="font-medium break-words">{progress.title}</p>
                    {progress.now === null ? null : (
                        <p className="text-sm break-words">
                            <span className="text-text-muted">{m.run_steps_now()} </span>
                            {progress.now}
                        </p>
                    )}
                    {progress.next === null ? null : (
                        <p className="text-sm break-words">
                            <span className="text-text-muted">{m.run_steps_next()} </span>
                            {progress.next}
                        </p>
                    )}
                    <ol className="flex flex-col gap-1.5">
                        {progress.items.map((item) => (
                            <li key={item.id} className="flex items-start gap-2 text-sm">
                                {item.status === 'completed' ? (
                                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                                ) : (
                                    <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
                                )}
                                <span className="break-words">
                                    <span className="sr-only">
                                        {item.status === 'completed' ? m.run_step_done() : m.run_step_pending()}{' '}
                                    </span>
                                    {item.text}
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
        </Card>
    );
}

const TOOL_STATE_TONES: Readonly<Record<ToolCall['state'], BadgeTone>> = {
    pending: 'neutral',
    partial: 'info',
    complete: 'success',
    error: 'danger',
};

function toolStateLabel(state: ToolCall['state']): string {
    switch (state) {
        case 'pending':
            return m.run_tool_pending();
        case 'partial':
            return m.run_tool_partial();
        case 'complete':
            return m.run_tool_complete();
        case 'error':
            return m.run_tool_error();
    }
}

function ToolCallsSection({ toolCalls }: { readonly toolCalls: ReadRunDetail['toolCalls'] }) {
    const locale = useLocale();
    return (
        <Card title={m.run_tools_title()}>
            {toolCalls.length === 0 ? (
                <p className="text-sm text-text-muted">{m.run_tools_none()}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-divider">
                    {toolCalls.map((call) => (
                        <li key={call.id}>
                            <details className="group py-2">
                                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-small focus-visible:outline-2 focus-visible:outline-focus">
                                    <span className="font-mono text-sm break-all">{call.name}</span>
                                    <Badge tone={TOOL_STATE_TONES[call.state]}>{toolStateLabel(call.state)}</Badge>
                                    <span className="text-sm text-text-muted tabular-nums">
                                        {call.durationMs === null
                                            ? m.run_value_unknown()
                                            : formatDuration(call.durationMs, (value) => locale.formatNumber(value))}
                                    </span>
                                </summary>
                                <div className="mt-2 flex flex-col gap-2">
                                    {call.logsTruncated ? (
                                        <Banner tone="warning">{m.run_logs_truncated()}</Banner>
                                    ) : null}
                                    {call.logs === '' ? (
                                        <p className="text-sm text-text-muted">{m.run_logs_empty()}</p>
                                    ) : (
                                        // Tool output is attacker-controlled once an agent reads outside content: text only.
                                        <pre
                                            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                                            tabIndex={0}
                                            className="run-text max-h-96 overflow-auto rounded-surface p-3 font-mono text-xs whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-focus"
                                        >
                                            {call.logs}
                                        </pre>
                                    )}
                                </div>
                            </details>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

function UsageSection({ run }: { readonly run: ReadRunDetail }) {
    const locale = useLocale();
    const tokens = (value: number | null | undefined) =>
        value === null || value === undefined ? (
            <Unknown />
        ) : (
            <span className="tabular-nums">{locale.formatNumber(value)}</span>
        );
    return (
        <Card title={m.run_usage_title()}>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label={m.run_usage_input_tokens()}>{tokens(run.usage?.inputTokens)}</Fact>
                <Fact label={m.run_usage_output_tokens()}>{tokens(run.usage?.outputTokens)}</Fact>
                <Fact label={m.run_usage_duration()}>
                    <ReportedDuration run={run} />
                </Fact>
                <Fact label={m.run_usage_cost()}>
                    <RunCost cost={run.usage?.cost} />
                </Fact>
            </dl>
        </Card>
    );
}

function OutputsSection({ run }: { readonly run: ReadRunDetail }) {
    const { messages, files, fileNames, projectChanges } = run.outputs;
    const empty = messages.length === 0 && files.length === 0 && projectChanges.length === 0;
    return (
        <Card title={m.run_outputs_title()}>
            {empty ? (
                <p className="text-sm text-text-muted">{m.run_outputs_none()}</p>
            ) : (
                <div className="flex flex-col gap-6">
                    {messages.length === 0 ? null : (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{m.run_outputs_messages()}</h3>
                            <ul className="flex flex-col gap-1">
                                {messages.map((message) => (
                                    <li key={message.messageId}>
                                        <Link
                                            to="/agents/$agentId/chat/$chatId"
                                            params={{ agentId: run.agentId, chatId: message.chatId }}
                                        >
                                            {m.run_outputs_message_link()}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {files.length === 0 ? null : (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{m.run_outputs_files()}</h3>
                            <ul className="flex flex-col gap-1 text-sm">
                                {files.map((fileId, index) => (
                                    <li key={fileId} className="break-all">
                                        {fileNames[index] ?? fileId}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}
                    {projectChanges.map((change, index) => (
                        <ProjectChangeView key={`${change.commitHash}-${String(index)}`} change={change} />
                    ))}
                </div>
            )}
        </Card>
    );
}

function ProjectChangeView({ change }: { readonly change: ReadRunDetail['outputs']['projectChanges'][number] }) {
    const locale = useLocale();
    return (
        <section className="flex flex-col gap-3">
            <h3 className="font-medium break-words">{m.run_project_title({ project: change.projectName })}</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text-muted">{m.run_project_commit()}</span>
                <CodeText value={change.commitHash} copyable copyLabel={m.run_project_copy_commit()} />
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <caption className="sr-only">
                        {m.run_project_files_caption({ project: change.projectName })}
                    </caption>
                    <thead>
                        <tr className="text-left text-text-muted">
                            <th scope="col" className="py-1 pr-3 font-medium">
                                {m.run_project_file_path()}
                            </th>
                            <th scope="col" className="py-1 pr-3 text-right font-medium">
                                {m.run_project_file_insertions()}
                            </th>
                            <th scope="col" className="py-1 text-right font-medium">
                                {m.run_project_file_deletions()}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {change.changedFiles.map((file) => (
                            <tr key={file.path} className="border-t border-divider">
                                <td className="py-1 pr-3 font-mono text-xs break-all">{file.path}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                    {m.run_project_insertions({ count: locale.formatNumber(file.insertions) })}
                                </td>
                                <td className="py-1 text-right tabular-nums">
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
        <Page title={m.run_not_found_title()}>
            <EmptyState
                title={m.run_not_found_title()}
                description={m.run_not_found_body()}
                action={<ButtonLink to="/runs">{m.run_back_to_runs()}</ButtonLink>}
            />
        </Page>
    );
}

/** Shaped like the header and the sections, so nothing jumps when the run arrives. */
export function RunDetailSkeleton() {
    return (
        <section aria-busy="true" aria-label={m.run_title_loading()} className="flex flex-col gap-6">
            <Skeleton shape="text" className="h-8 w-2/3" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} shape="text" className="h-10 w-full" />
                ))}
            </div>
            {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} shape="block" className="h-40 w-full" />
            ))}
        </section>
    );
}
