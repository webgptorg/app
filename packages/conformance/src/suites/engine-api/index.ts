import { ENGINE_API_ROUTES } from '@ptbk/engine-api';

import type { ConformanceSuite } from '../../check';
import { EngineApi } from './api';
import { AGENT_CHECKS } from './agents';
import { AUDIT_CHECKS } from './audit';
import { AUTH_CHECKS } from './auth';
import { CHAT_CHECKS } from './chat';
import { ENGINE_CHECKS } from './engine';
import { GATEWAY_CHECKS } from './gateway';
import { INPUT_CHECKS } from './input';
import { MEMBER_CHECKS } from './members';
import { PAGINATION_CHECKS } from './pagination';
import { PERMISSION_CHECKS } from './permissions';
import { SCHEMA_CHECKS } from './schemas';
import { SECRET_CHECKS } from './secrets';
import { SUITE } from './support';

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
        ...SECRET_CHECKS,
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
