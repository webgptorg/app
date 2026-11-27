import { ENGINE_API_ROUTES } from '@ptbk/engine-api';

import type { ConformanceSuite } from '../../check';
import { ACTIVITY_CHECKS } from './activity';
import { AI_TOOL_CHECKS } from './ai-tools';
import { EngineApi } from './api';
import { AGENT_CHECKS } from './agents';
import { AUDIT_CHECKS } from './audit';
import { AUTH_CHECKS } from './auth';
import { CHAT_CHECKS } from './chat';
import { CHAT_ACTIVITY_CHECKS } from './chat-activity';
import { ENGINE_CHECKS } from './engine';
import { FILE_CHECKS } from './files';
import { GATEWAY_CHECKS } from './gateway';
import { INPUT_CHECKS } from './input';
import { INTEGRATION_CHECKS } from './integrations';
import { LIVE_CHECKS } from './live';
import { MEMBER_CHECKS } from './members';
import { ONBOARDING_CHECKS } from './onboarding';
import { PAGINATION_CHECKS } from './pagination';
import { PERMISSION_CHECKS } from './permissions';
import { RUN_CHECKS } from './runs';
import { SCHEMA_CHECKS } from './schemas';
import { SUITE } from './support';
import { TASK_CHECKS } from './tasks';
import { TEST_CHAT_CHECKS } from './test-chat';
import { TRIGGER_CHECKS } from './triggers';
import { UPDATES_CHECKS } from './updates';
import { VOICE_CHECKS } from './voice';
import { WALLET_CHECKS } from './wallet';

/** v1: the engine API that engine-ui depends on (C-04, C-07), checked through the gateway as a browser would. */
export const ENGINE_API_SUITE: ConformanceSuite = {
    id: SUITE,
    checks: [
        ...ENGINE_CHECKS,
        ...AUTH_CHECKS,
        ...SCHEMA_CHECKS,
        ...INPUT_CHECKS,
        ...PAGINATION_CHECKS,
        ...AGENT_CHECKS,
        ...CHAT_CHECKS,
        ...CHAT_ACTIVITY_CHECKS,
        ...WALLET_CHECKS,
        ...RUN_CHECKS,
        ...TASK_CHECKS,
        ...FILE_CHECKS,
        ...TRIGGER_CHECKS,
        ...INTEGRATION_CHECKS,
        ...TEST_CHAT_CHECKS,
        ...LIVE_CHECKS,
        ...ONBOARDING_CHECKS,
        ...VOICE_CHECKS,
        ...AI_TOOL_CHECKS,
        ...UPDATES_CHECKS,
        ...ACTIVITY_CHECKS,
        ...AUDIT_CHECKS,
        ...PERMISSION_CHECKS,
        ...MEMBER_CHECKS,
        ...GATEWAY_CHECKS,
    ],
    async engineVersion(ctx) {
        const credential = await ctx.target.session({ kind: 'owner' });
        if (credential === null) return null;
        const result = await new EngineApi(ctx, credential).call(ENGINE_API_ROUTES.getSecurityOverview);
        return result.kind === 'ok' ? result.data.engine.version : null;
    },
};
