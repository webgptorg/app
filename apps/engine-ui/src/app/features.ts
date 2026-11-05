import { agentWizardFeature } from '../features/agent-wizard/agent-wizard-feature';
import { agentsFeature } from '../features/agents/agents-feature';
import { auditFeature } from '../features/audit/audit-feature';
import { bookFeature } from '../features/book/book-feature';
import { chatFeature } from '../features/chat/chat-feature';
import { filesFeature } from '../features/files/files-feature';
import { homeFeature } from '../features/home/home-feature';
import { integrationsFeature } from '../features/integrations/integrations-feature';
import { membersFeature } from '../features/members/members-feature';
import { runsFeature } from '../features/runs/runs-feature';
import { secretsFeature } from '../features/secrets/secrets-feature';
import { securityFeature } from '../features/security/security-feature';
import { settingsFeature } from '../features/settings/settings-feature';
import { tasksFeature } from '../features/tasks/tasks-feature';
import { triggersFeature } from '../features/triggers/triggers-feature';
import type { FeatureDefinition } from './registry/feature';

/**
 * Every feature engine-ui knows. A feature task (U-03 to U-12) adds its definition here; the shell, guards and
 * palette derive everything else from this list, filtered by engine capability and the member's permissions.
 */
export const FEATURES: readonly FeatureDefinition[] = [
    homeFeature,
    agentsFeature,
    agentWizardFeature,
    chatFeature,
    tasksFeature,
    runsFeature,
    triggersFeature,
    filesFeature,
    integrationsFeature,
    bookFeature,
    membersFeature,
    securityFeature,
    secretsFeature,
    auditFeature,
    settingsFeature,
];
