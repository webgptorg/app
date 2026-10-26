import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { interpolate } from './compose-env.ts';
import {
    DEV_OVERLAYS,
    DEV_STACK_NET,
    DEV_SUBNET,
    STACK_NET_VARIABLE,
    moveStackAddresses,
    staleNetwork,
} from './dev-stack-config.ts';
import { ENGINE_LAN_SUBNET, STACK_NET, SUBNET } from './stack.ts';

const E2E_DIR = join(import.meta.dirname, '..');
const COREDNS_DIR = join(E2E_DIR, 'coredns');
const read = (file: string): string => readFileSync(join(E2E_DIR, file), 'utf8');
const DEV_COMPOSE_FILES = ['compose.yaml', ...DEV_OVERLAYS.map((name) => `compose.${name}.yaml`)];
const E2E_COMPOSE_FILES = readdirSync(E2E_DIR).filter(
    (name) => /^compose(\..+)?\.yaml$/.test(name) && name !== 'compose.dev.yaml',
);
const E2E_NETWORKS = [SUBNET, ENGINE_LAN_SUBNET];

interface Range {
    readonly first: number;
    readonly last: number;
}

function toNumber(address: string): number {
    return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function range(cidrOrAddress: string): Range {
    const [address = '', bits = '32'] = cidrOrAddress.split('/');
    const size = 2 ** (32 - Number(bits));
    const first = Math.floor(toNumber(address) / size) * size;
    return { first, last: first + size - 1 };
}

const overlaps = (a: string, b: string): boolean => {
    const [x, y] = [range(a), range(b)];
    return x.first <= y.last && y.first <= x.last;
};

/** Every IPv4 address or CIDR in `text`, except loopback and the wildcard address. */
function addressesIn(text: string): readonly string[] {
    return [...text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?)(?![\d.])/g)]
        .map((match) => match[1] ?? '')
        .filter((address) => !address.startsWith('127.') && !address.startsWith('0.0.0.0'));
}

function coreDnsFiles(): ReadonlyMap<string, string> {
    return new Map(
        readdirSync(COREDNS_DIR, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
                const file = join(entry.parentPath, entry.name);
                return [relative(COREDNS_DIR, file), readFileSync(file, 'utf8')] as const;
            }),
    );
}

const devEnv = { [STACK_NET_VARIABLE]: DEV_STACK_NET };
const devCompose = DEV_COMPOSE_FILES.map((file) => [file, interpolate(read(file), devEnv)] as const);
const devDns = [...coreDnsFiles()].map(([file, text]) => [file, moveStackAddresses(text, DEV_STACK_NET)] as const);

describe('the dev stack’s address space', () => {
    it('lies outside every e2e network, in its compose config and its rendered DNS', () => {
        for (const network of E2E_NETWORKS) expect(overlaps(DEV_SUBNET, network), network).toBe(false);
        const used = [...devCompose, ...devDns].flatMap(([file, text]) =>
            addressesIn(text).map((address) => [file, address] as const),
        );
        expect(used.map(([, address]) => address)).toContain(DEV_SUBNET);
        for (const [file, address] of used) {
            expect(overlaps(address, DEV_SUBNET), `${file}: ${address}`).toBe(true);
            for (const network of E2E_NETWORKS) expect(overlaps(address, network), `${file}: ${address}`).toBe(false);
        }
    });

    it('clears every subnet any e2e scenario declares', () => {
        const declared = E2E_COMPOSE_FILES.flatMap((file) =>
            [...interpolate(read(file)).matchAll(/subnet: (\S+)/g)].map((match) => match[1] ?? ''),
        );
        expect(declared).toEqual(expect.arrayContaining(E2E_NETWORKS));
        for (const subnet of declared) expect(overlaps(subnet, DEV_SUBNET), subnet).toBe(false);
    });

    it('keeps e2e on stack.ts’s network when the variable is unset', () => {
        const e2eCompose = interpolate(read('compose.yaml'));
        expect(e2eCompose).toContain(`subnet: ${SUBNET}`);
        expect(e2eCompose).not.toContain(DEV_STACK_NET);
    });

    it('takes the stack network only through the variable in the files it layers', () => {
        for (const file of DEV_COMPOSE_FILES) {
            const literal = read(file).replaceAll(`\${${STACK_NET_VARIABLE}:-${STACK_NET}}`, '');
            expect(literal, file).not.toContain(`${STACK_NET}.`);
        }
    });

    it('mounts the rendered DNS config over the stack resolver’s', () => {
        expect(read('compose.dev.yaml')).toContain(
            `  dns:\n    volumes: !override\n      - ../.dev/coredns:/etc/coredns:ro`,
        );
    });
});

describe('moveStackAddresses', () => {
    it('moves e2e stack addresses and subnets, host part kept', () => {
        expect(moveStackAddresses(`${STACK_NET}.11 relay-a.ptbk.test\n* 5 IN A ${STACK_NET}.12`, '10.89.241')).toBe(
            '10.89.241.11 relay-a.ptbk.test\n* 5 IN A 10.89.241.12',
        );
        expect(moveStackAddresses(`answer "{{ .Name }} 5 IN A ${STACK_NET}.11"`, '10.89.241')).toBe(
            'answer "{{ .Name }} 5 IN A 10.89.241.11"',
        );
        expect(moveStackAddresses(`${STACK_NET}.0/24`, '10.89.241')).toBe('10.89.241.0/24');
    });

    it('leaves other addresses alone', () => {
        for (const text of ['110.89.231.5', '10.89.2310.5', '10.89.232.10', '127.0.0.1 app.ptbk.test', '10.89.231']) {
            expect(moveStackAddresses(text, '10.89.241')).toBe(text);
        }
    });

    it('leaves no e2e stack address in the rendered DNS config, and changes nothing else', () => {
        for (const [file, text] of coreDnsFiles()) {
            const moved = moveStackAddresses(text, DEV_STACK_NET);
            expect(moved, file).not.toContain(`${STACK_NET}.`);
            expect(moved.replaceAll(DEV_STACK_NET, STACK_NET), file).toBe(text);
        }
    });
});

describe('staleNetwork', () => {
    it('passes a network already on the dev subnet, or none', () => {
        expect(staleNetwork(`${DEV_SUBNET} \n`, DEV_SUBNET)).toBeNull();
        expect(staleNetwork('', DEV_SUBNET)).toBeNull();
    });

    it('asks for `down` when the network is still on the e2e subnet', () => {
        expect(staleNetwork(`${SUBNET} `, DEV_SUBNET)).toContain('bun run dev:stack down');
    });
});
