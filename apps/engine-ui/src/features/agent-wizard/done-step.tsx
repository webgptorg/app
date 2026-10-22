import type { AgentId } from '@ptbk/engine-api';
import type { Ref } from 'react';

import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { StepFrame } from './step-frame';

export interface DoneStepProps {
    readonly agentId: AgentId;
    readonly agentName: string;
    readonly headingRef: Ref<HTMLHeadingElement>;
}

/** Step 5: where to go next with the new agent. */
export function DoneStep({ agentId, agentName, headingRef }: DoneStepProps) {
    const params = { agentId };
    return (
        <StepFrame
            title={m.wizard_done_title()}
            description={m.wizard_done_body({ name: agentName })}
            headingRef={headingRef}
            actions={
                <div className="flex flex-wrap gap-2">
                    <ButtonLink to="/agents/$agentId" params={params} variant="primary">
                        {m.wizard_done_open()}
                    </ButtonLink>
                    <ButtonLink to="/agents/$agentId/chat" params={params}>
                        {m.wizard_done_chat()}
                    </ButtonLink>
                    <ButtonLink to="/agents/$agentId/book" params={params}>
                        {m.wizard_done_book()}
                    </ButtonLink>
                </div>
            }
        />
    );
}
