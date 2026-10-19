import type { Database } from '../adapters/db/client';
import type { Authorizer } from '../domain/authz/authorizer';
import type { DashboardAction } from '../domain/authz/policy';
import type { Clock } from '../domain/ports/clock';
import type { Logger } from '../domain/ports/logger';
import type { Random } from '../domain/ports/random';
import type { DashboardConfig } from './config';

/** Everything handlers may use. Later tasks add their ports here, built from the adapters `config.adapters` selects. */
export interface DashboardDeps {
    readonly config: DashboardConfig;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
    readonly db: Database;
    readonly authorizer: Authorizer<DashboardAction>;
}
