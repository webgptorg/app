import type { ReadIntegration } from '@ptbk/engine-api';
import { Card, CodeText } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

/**
 * The tools the integration offers agents. Names and descriptions come from the server behind the integration: text
 * only. One row per tool, so per-tool approvals (the next likely contract addition) can add controls to each row.
 */
export function IntegrationTools({ tools }: { readonly tools: ReadIntegration['tools'] }) {
    return (
        <Card title={m.integration_tools_title()} titleLevel={2}>
            {tools.length === 0 ? (
                <p className="text-sm text-text-muted">{m.integration_tools_none()}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-divider">
                    {tools.map((tool) => (
                        <li key={tool.name} className="flex flex-col gap-1 py-2">
                            <CodeText value={tool.name} />
                            {tool.description === null ? null : (
                                <p className="text-sm break-words whitespace-pre-wrap text-text-muted">
                                    {tool.description}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
