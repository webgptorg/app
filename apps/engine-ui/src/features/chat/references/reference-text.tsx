import { Fragment, useMemo } from 'react';

import { AgentChip } from './agent-chip';
import { AsksYou } from './asks-you';
import { parseReferences } from './parse-references';
import { TaskChip } from './task-chip';
import { useThreadReferences } from './thread-references';

/**
 * Plain text with the thread's references as chips: `@Agent`, `+@Agent`, `{Task}` and `+@User`. Feed it text only
 * (a markdown text node, a plain message, a step), never markup. Outside a thread it is the text unchanged.
 */
export function ReferenceText({ text }: { readonly text: string }) {
    const references = useThreadReferences();
    const segments = useMemo(
        () => (references === null ? null : parseReferences(text, references.index)),
        [text, references],
    );
    if (segments === null) return text;
    return segments.map((segment, position) => {
        switch (segment.kind) {
            case 'text':
                return <Fragment key={position}>{segment.text}</Fragment>;
            case 'agent':
                return <AgentChip key={position} agentKey={segment.key} name={segment.name} />;
            case 'task':
                return <TaskChip key={position} name={segment.name} />;
            case 'asks-user':
                return <AsksYou key={position} />;
        }
    });
}
