import { z } from 'zod';

// zod probes `new Function` when it builds a schema; under the strict CSP that caught probe is still a reported
// Trusted Types violation. Imported first in main.tsx, before any module defines a schema.
z.config({ jitless: true });
