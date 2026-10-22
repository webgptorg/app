import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { Button } from '@ptbk/ui';
import type { Ref } from 'react';

import { useEngineCapabilities } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { KnowledgeUpload } from '../files/knowledge-upload';
import { usePermissions } from '../session/use-permissions';
import { StepFrame } from './step-frame';

export interface KnowledgeStepProps {
    readonly agentId: AgentId;
    readonly headingRef: Ref<HTMLHeadingElement>;
    readonly onNext: () => void;
    readonly onCancel: () => void;
}

/**
 * Step 3: files the agent should know, through the same upload control as the agent's Files tab (U-10). Optional, and
 * only where the engine has `files@1` and the member may upload.
 */
export function KnowledgeStep({ agentId, headingRef, onNext, onCancel }: KnowledgeStepProps) {
    const capabilities = useEngineCapabilities();
    const { can } = usePermissions();
    const available = supports({ capabilities }, KNOWN_CAPABILITIES.files) && can('files.write');

    return (
        <StepFrame
            title={m.wizard_knowledge_title()}
            description={available ? m.wizard_knowledge_body() : m.wizard_knowledge_unavailable()}
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
            {available ? <KnowledgeUpload agentId={agentId} /> : null}
        </StepFrame>
    );
}
