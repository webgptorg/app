import { z } from 'zod';

import { environmentSchema } from '../environment';
import { defineRoute } from './contract';

/** The SPA's own API. Every `/api` endpoint is declared here and nowhere else. */
export const apiRoutes = {
    getEnvironment: defineRoute({
        method: 'GET',
        path: '/api/environment',
        params: null,
        query: null,
        body: null,
        response: z.strictObject({ environment: environmentSchema }),
        errorCodes: [],
    }),
} as const;
