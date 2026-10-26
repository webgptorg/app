import type { Signer } from '@ptbk/protocol';
import { verifyEd25519 } from '@ptbk/protocol';

import { Findings } from '../../../check';
import { describeCheck } from '../bench';
import { ED25519_CASES, MALFORMED_KEY_CASES, ed25519CaseSigner } from '../ed25519-cases';
import { RELEASE_LOG_INDEX, trustPolicyOf } from '../releases';
import type { UiLoaderCheck } from './common';
import { expectRefusal, expectStillActive, refusals } from './common';

export const installPinnedValid: UiLoaderCheck = {
    id: 'ui-loader.install.pinned-valid',
    title: 'A valid regular release installs under pinned and the panel shows its version, archive SHA-256 and log index',
    async run(bench, ctx) {
        const findings = new Findings();
        await bench.revocations();
        const published = await bench.publish(bench.nextVersion());
        const seen = await bench.pinned(ctx, published.version);
        if (seen.check.outcome !== 'installed' || seen.check.version !== published.version) {
            findings.add(`expected installed ${published.version}, got ${describeCheck(seen.check)}`);
        }
        if (seen.ui.version === published.version) {
            bench.active = published;
            bench.installed.push(published);
        }
        if (seen.ui.bundleSha256 !== published.bundle.sha256) {
            findings.add(`the panel shows bundle SHA-256 ${seen.ui.bundleSha256}, not the archive's`);
        }
        if (seen.ui.releaseLogIndex !== RELEASE_LOG_INDEX) {
            findings.add(
                `the panel shows log index ${String(seen.ui.releaseLogIndex)}, not the provenance's ${String(RELEASE_LOG_INDEX)}`,
            );
        }
        const served = await bench.servedVersion(ctx);
        if (served !== published.version) findings.add(`the engine serves ${served ?? 'no bundle'}`);
        return findings.outcome();
    },
};

/** Remembers what it signed, so the expected verdict is computed over the very signature the engine sees. */
function recording(signer: Signer): { signer: Signer; signed: { message: Uint8Array; signature: Uint8Array }[] } {
    const signed: { message: Uint8Array; signature: Uint8Array }[] = [];
    return {
        signed,
        signer: {
            publicKey: () => signer.publicKey(),
            async sign(message, signal) {
                const signature = await signer.sign(message, signal);
                signed.push({ message: message.slice(), signature: signature.slice() });
                return signature;
            },
        },
    };
}

export const strictEd25519: UiLoaderCheck = {
    id: 'ui-loader.signature.strict-ed25519',
    title: "Release-key signatures built for each case class of C-01's ed25519-vectors.json get exactly the strict verdict",
    async run(bench, ctx) {
        const findings = new Findings();
        for (const kind of ED25519_CASES) {
            const baseline = await bench.baseline(ctx);
            await bench.revocations();
            const { signer, signed } = recording(ed25519CaseSigner(kind));
            const policy = trustPolicyOf({
                maintainers: bench.keys.maintainers,
                // The run's release key stays trusted for the revocation list; the release itself carries only the case's.
                releasePublicKeys: [bench.keys.release.publicKey(), signer.publicKey()],
            });
            const version = bench.nextVersion();
            const published = await bench.publish(version, { release: { signers: [signer] } });
            const [use] = signed;
            if (use === undefined) throw new Error('the case signer was not used');
            const accept = verifyEd25519(
                signer.publicKey(),
                new Uint8Array(use.message),
                new Uint8Array(use.signature),
            );
            let seen;
            try {
                seen = await bench.pinned(ctx, version, policy);
            } catch (error) {
                // An engine may refuse a malformed key in its trust policy outright, before verifying anything.
                if (MALFORMED_KEY_CASES.has(kind)) continue;
                throw error;
            }
            const installed = seen.check.outcome === 'installed' && seen.ui.version === version;
            // Not recorded as installed: only this case's policy trusts it, so no later check may pin it again.
            if (installed) bench.active = published;
            if (accept && !installed)
                findings.add(`${kind}: strict Ed25519 accepts it, the engine ${describeCheck(seen.check)}`);
            if (!accept && installed) findings.add(`${kind}: strict Ed25519 refuses it, the engine installed it`);
            if (!accept && !installed) {
                if (seen.check.reason !== 'signature-threshold-not-met') {
                    findings.add(`${kind}: expected signature-threshold-not-met, got ${describeCheck(seen.check)}`);
                }
                await expectStillActive(bench, ctx, findings, kind, baseline, seen);
            }
        }
        return findings.outcome();
    },
};

const THRESHOLD = ['signature-threshold-not-met'] as const;

export const signatureThreshold: UiLoaderCheck = {
    id: 'ui-loader.signature.threshold',
    title: 'A regular release needs the release key and provenance; a security release also needs 2 distinct maintainer keys',
    async run(bench, ctx) {
        const { release, maintainers, outsider } = bench.keys;
        const [first, second] = maintainers;
        const findings = new Findings();
        const security = { entry: { kind: 'security' as const } };
        for (const refusal of [
            { label: 'release key without provenance', release: { provenance: null } },
            {
                label: 'release key with provenance from an untrusted CA',
                release: { provenance: { options: { untrustedCa: true } } },
            },
            { label: 'provenance with an untrusted key only', release: { signers: [outsider] } },
            { label: 'provenance with two maintainers only', release: { signers: [first, second] } },
            { label: 'security release with one maintainer', release: { ...security, signers: [release, first] } },
            {
                label: 'security release with one maintainer twice',
                release: { ...security, signers: [release, first, first] },
            },
            {
                label: 'security release with two maintainers but no release key',
                release: { ...security, signers: [first, second] },
            },
        ]) {
            await expectRefusal(bench, ctx, findings, {
                label: refusal.label,
                reasons: THRESHOLD,
                publish: { release: refusal.release },
            });
        }
        await bench.revocations();
        const accepted = await bench.publish(bench.nextVersion(), {
            release: { ...security, signers: [release, first, second] },
        });
        const seen = await bench.pinned(ctx, accepted.version);
        if (seen.check.outcome === 'installed' && seen.ui.version === accepted.version) {
            bench.active = accepted;
            bench.installed.push(accepted);
        } else {
            findings.add(
                `security release with the release key, provenance and two maintainers: ${describeCheck(seen.check)}`,
            );
        }
        return findings.outcome();
    },
};

/** Flips one byte inside the commit hash, so the payload stays valid JSON for a strict schema. */
function flipCommitByte(payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const changed = payload.slice();
    const at = new TextDecoder().decode(payload).indexOf('"commit":"c0de') + '"commit":"c0de'.length;
    changed[at] = changed[at] === 0x30 ? 0x31 : 0x30;
    return changed;
}

export const dssePaeOnly: UiLoaderCheck = {
    id: 'ui-loader.dsse.pae-only',
    title: 'A signature over the raw payload, a changed payload byte or a wrong payloadType is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'release key over the raw payload',
                reasons: THRESHOLD,
                publish: { release: { signedBytes: (_pae, payload) => payload } },
            },
            {
                label: 'payload changed after signing',
                reasons: ['signature-threshold-not-met', 'invalid-entry'],
                publish: { release: { tamperPayload: flipCommitByte } },
            },
            {
                label: 'another payload type, consistently signed',
                reasons: ['invalid-entry'],
                publish: { release: { payloadType: 'application/vnd.ptbk.release+json; v=2' } },
            },
        ]),
};

export const strictPayload: UiLoaderCheck = {
    id: 'ui-loader.entry.strict-payload',
    title: 'A validly signed release payload with a duplicate key or an unknown field is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'duplicate key',
                reasons: ['invalid-entry'],
                publish: { release: { payloadText: (entry) => `${JSON.stringify(entry).slice(0, -1)},"v":1}` } },
            },
            {
                label: 'escaped duplicate key',
                reasons: ['invalid-entry'],
                publish: { release: { payloadText: (entry) => `${JSON.stringify(entry).slice(0, -1)},"\\u0076":1}` } },
            },
            {
                label: 'unknown field',
                reasons: ['invalid-entry'],
                publish: { release: { payloadText: (entry) => JSON.stringify({ ...entry, channel: 'beta' }) } },
            },
        ]),
};
