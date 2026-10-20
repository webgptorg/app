import { z } from 'zod';

// zod probes `new Function` when it first compiles an object schema; under the engine's CSP that probe is a reported
// violation even though zod catches it. main.tsx imports this first, before any module defines a schema.
z.config({ jitless: true });
