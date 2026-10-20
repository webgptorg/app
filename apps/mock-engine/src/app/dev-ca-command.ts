import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

import {
    DEV_CA_CERT_FILE,
    DEV_CA_DIRECTORY,
    DEV_CA_KEY_FILE,
    DevCaError,
    issueLeaf,
    loadOrCreateDevCa,
} from '../adapters/dev-ca';
import { replacePrivateFile } from '../adapters/private-files';
import type { Clock } from '../domain/clock';
import type { Logger } from '../domain/logger';
import type { DevCaConfig } from './config';

export const DEV_CA_USAGE = 'usage: dev-ca [issue <cert-file> <key-file> <hostname>...]';
const MAX_LEAF_NAMES = 16;

export class DevCaUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DevCaUsageError';
    }
}

export type DevCaCommand =
    | { readonly kind: 'ensure' }
    | {
          readonly kind: 'issue';
          readonly certFile: string;
          readonly keyFile: string;
          readonly hostnames: readonly Hostname[];
      };

export function parseDevCaCommand(args: readonly string[]): DevCaCommand {
    const [verb, certFile, keyFile, ...names] = args;
    if (verb === undefined) return { kind: 'ensure' };
    if (verb !== 'issue' || certFile === undefined || keyFile === undefined || names.length === 0) {
        throw new DevCaUsageError(DEV_CA_USAGE);
    }
    if (names.length > MAX_LEAF_NAMES) throw new DevCaUsageError(`at most ${String(MAX_LEAF_NAMES)} hostnames`);
    const hostnames = names.map((name, index) => {
        const parsed = HostnameSchema.safeParse(name);
        if (!parsed.success) throw new DevCaUsageError(`hostname ${String(index + 1)} is not a hostname`);
        return parsed.data;
    });
    return { kind: 'issue', certFile, keyFile, hostnames };
}

export type DevCaReport =
    | {
          readonly certificateFile: string;
          readonly keyFile: string;
          readonly permittedDomains: readonly string[];
      }
    | {
          readonly certificateFile: string;
          readonly keyFile: string;
          readonly hostnames: readonly Hostname[];
          readonly notAfter: string;
      };

export interface DevCaCommandDeps {
    readonly clock: Clock;
    readonly logger: Logger;
}

function within(hostname: Hostname, domain: string): boolean {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Provisions the dev CA in `<PTBK_DATA_DIR>/dev-ca/` exactly as the engine would at startup, so tools can trust it
 * before the engine runs (X-01), and with `issue` signs leaves for other dev services such as the e2e relays. Engine
 * hostnames are refused: their certificates come from the engine alone, so no other service ever holds one.
 */
export async function runDevCaCommand(
    command: DevCaCommand,
    config: DevCaConfig,
    deps: DevCaCommandDeps,
): Promise<DevCaReport> {
    const ca = await loadOrCreateDevCa({
        files: null,
        dataDir: config.dataDir,
        permittedDomains: [config.engineDomain, ...config.devCaDomains],
        clock: deps.clock,
        logger: deps.logger,
    });
    const directory = join(config.dataDir, DEV_CA_DIRECTORY);
    if (command.kind === 'ensure') {
        return {
            certificateFile: join(directory, DEV_CA_CERT_FILE),
            keyFile: join(directory, DEV_CA_KEY_FILE),
            permittedDomains: ca.permittedDomains,
        };
    }
    command.hostnames.forEach((hostname, index) => {
        if (within(hostname, config.engineDomain)) {
            throw new DevCaError(`hostname ${String(index + 1)} is an engine hostname; only the engine issues those`);
        }
        if (!config.devCaDomains.some((domain) => within(hostname, domain))) {
            throw new DevCaError(`hostname ${String(index + 1)} is outside MOCK_DEV_CA_DOMAINS`);
        }
    });
    const leaf = issueLeaf(ca, command.hostnames, deps.clock);
    await replacePrivateFile(command.keyFile, leaf.privateKeyPem.reveal());
    await writeFile(command.certFile, leaf.certificatePem, { mode: 0o644 });
    return {
        certificateFile: command.certFile,
        keyFile: command.keyFile,
        hostnames: command.hostnames,
        notAfter: new Date(leaf.notAfterMs).toISOString(),
    };
}
