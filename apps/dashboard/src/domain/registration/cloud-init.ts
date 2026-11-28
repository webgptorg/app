import { formatLinkUrl, type LinkCode } from '@ptbk/protocol';
import type { EngineInstallRelease } from '../../shared/engine-installation';
import template from './install-scripts/cloud-init.sh?raw';

/** Only fixed, validated server values can enter the root-run first boot. */
export function cloudInit(release: EngineInstallRelease, origin: string, code: LinkCode, ownerDigest: string): string {
    const link = formatLinkUrl(origin, code);
    if (
        !release.digitalOceanOwner ||
        !/^https:\/\/[a-zA-Z0-9.:-]+\/link#[a-z2-7]{26}$/.test(link) ||
        !/^[a-f0-9]{64}$/.test(ownerDigest)
    )
        throw new Error('Invalid VPS bootstrap');
    return template
        .replace('__LINK__', link)
        .replace('__OWNER__', ownerDigest)
        .replace('__VERSION__', release.version)
        .replace('__REVISION__', release.bootstrapRevision)
        .replace('__SHA256__', release.bootstrapSha256);
}
