import { METERS, type MeterId } from '../../shared/metering';
import { agentsMeter, membersMeter } from './heartbeat-meters';
import type { Meter, MeterReading } from './meter';
import { peopleMeter } from './people-meter';
import { projectsMeter } from './projects-meter';
import type { OrgUsageFacts } from './usage-facts';

/** Every meter by its ID; the record type makes a new ID in `METERS` fail to compile until its meter is here. */
export const METER_REGISTRY: Readonly<Record<MeterId, Meter>> = Object.freeze({
    projects: projectsMeter,
    agents: agentsMeter,
    members: membersMeter,
    people: peopleMeter,
});

export type MeterReadings = Readonly<Record<MeterId, MeterReading>>;

export function measureAll(facts: OrgUsageFacts): MeterReadings {
    return Object.fromEntries(METERS.map((id) => [id, METER_REGISTRY[id].measure(facts)])) as Record<
        MeterId,
        MeterReading
    >;
}
