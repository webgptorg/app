import { agentsFeature } from '../features/agents/agents-feature';
import { auditFeature } from '../features/audit/audit-feature';
import { membersFeature } from '../features/members/members-feature';
import { secretsFeature } from '../features/secrets/secrets-feature';
import { securityFeature } from '../features/security/security-feature';
import { settingsFeature } from '../features/settings/settings-feature';
import type { FeatureDefinition } from './registry/feature';

/**
 * Every feature engine-ui knows. A feature task (U-03 to U-12) adds its definition here; the shell, guards and
 * palette derive everything else from this list, filtered by engine capability and the member's permissions.
 */
export const FEATURES: readonly FeatureDefinition[] = [
    agentsFeature,
    membersFeature,
    securityFeature,
    secretsFeature,
    auditFeature,
    settingsFeature,
];
