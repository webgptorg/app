import type { ReadIntegration } from '@ptbk/engine-api';
import { EmptyState, Section } from '@ptbk/ui';
import { Wrench } from 'lucide-react';

import { m } from '../../paraglide/messages';

/**
 * The tools the integration offers agents. Names and descriptions come from the server behind the integration: text
 * only. One row per tool, so per-tool approvals (the next likely contract addition) can add controls to each row.
 */
export function IntegrationTools({ tools }: { readonly tools: ReadIntegration['tools'] }) {
    return (
        <Section title={m.integration_tools_title()} {...(tools.length === 0 ? {} : { count: tools.length })}>
            {tools.length === 0 ? (
                <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<Wrench aria-hidden />}
                    title={m.integration_tools_none()}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-hairline">
                    {tools.map((tool) => (
                        <li
                            key={tool.name}
                            className="flex min-h-10 flex-col gap-x-4 gap-y-1 py-2 sm:flex-row sm:items-baseline"
                        >
                            <span className="w-fit max-w-full shrink-0 rounded-small bg-neutral-soft px-1.5 py-0.5 font-mono text-xs break-all text-text sm:max-w-64">
                                {tool.name}
                            </span>
                            {tool.description === null ? null : (
                                <p className="min-w-0 text-sm break-words whitespace-pre-wrap text-text-muted">
                                    {tool.description}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Section>
    );
}
