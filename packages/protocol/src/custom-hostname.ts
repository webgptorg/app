import { defaultHostname } from './engine-id';
import type { EngineId, Hostname } from './ids';

/**
 * The exact name a custom hostname must CNAME to: the engine's default hostname, never a relay, so a compromised
 * dashboard cannot redirect a customer's domain without changing the customer's DNS (ADR 0014). The DNS lookup itself
 * belongs to the relay.
 */
export function expectedCnameTarget(engineId: EngineId, engineDomain: Hostname): Hostname {
    return defaultHostname(engineId, engineDomain);
}
