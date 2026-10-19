import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from '../src/openapi';

writeFileSync(join(import.meta.dirname, '..', 'openapi.json'), `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
