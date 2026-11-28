import { formatLinkUrl } from '@ptbk/protocol';

import type { IssueLinkCodeOutcome } from '../../domain/registration/issue-link-code';
import { installationOptions } from '../../domain/registration/installation-options';
import type { LinkCodeView } from '../../shared/api/routes';
import type { DashboardConfig } from '../config';
import { LINK_CODE_PLACEHOLDER, LINK_URL_PLACEHOLDER } from '../config';
import type { DashboardDeps } from '../deps';

type Issued = Extract<IssueLinkCodeOutcome, { readonly kind: 'issued' }>;

/** Both personal and team issuance share the same release selection, before rendering any install option. */
export async function resolveLinkCodeView(
    deps: Pick<DashboardDeps, 'config' | 'installReleases'>,
    issued: Issued,
    signal: AbortSignal,
): Promise<LinkCodeView> {
    const configured = deps.config.engineInstallation;
    if (configured === undefined) return issuedLinkCodeView(deps.config, issued);
    const release = await deps.installReleases.current(configured, signal);
    return issuedLinkCodeView({ ...deps.config, engineInstallation: release }, issued);
}

/** The view of a code just issued: the code, its link URL and each install tab with one of them filled in. */
export function issuedLinkCodeView(
    config: Pick<
        DashboardConfig,
        'dashboardOrigin' | 'installCommands' | 'installGuideUrl' | 'engineInstallation' | 'digitalOcean'
    >,
    issued: Issued,
): LinkCodeView {
    // Engines take only https:// link URLs; config refuses {linkUrl} on a plain-http (dev) origin.
    const linkUrl = config.dashboardOrigin.startsWith('https://')
        ? formatLinkUrl(config.dashboardOrigin, issued.linkCode)
        : null;
    const options =
        config.engineInstallation === undefined || linkUrl === null
            ? undefined
            : installationOptions(config.engineInstallation, linkUrl);
    const newProject = options?.find((option) => option.kind === 'command');
    const legacyCommands = config.installCommands.filter((path) => newProject === undefined || path.id !== 'installer');
    return {
        linkCodeId: issued.linkCodeId,
        linkCode: issued.linkCode,
        ...(linkUrl !== null && config.engineInstallation?.digitalOceanOwner
            ? {
                  vpsProviders: [{ provider: 'digitalocean' as const, referralUrl: config.digitalOcean?.referralUrl }],
              }
            : {}),
        linkUrl,
        installCommands: [
            ...(newProject?.kind === 'command'
                ? [
                      {
                          id: 'installer' as const,
                          labelKey: 'new-project' as const,
                          command: newProject.commands.posix,
                          docsAnchor: 'engine-first-setup',
                      },
                  ]
                : []),
            ...legacyCommands.map((path) => ({
                id: path.id,
                labelKey: path.labelKey,
                // Replacer functions, so a `$` in a template is never read as a replacement pattern.
                command: path.template
                    .replace(LINK_CODE_PLACEHOLDER, () => issued.linkCode)
                    .replace(LINK_URL_PLACEHOLDER, () => {
                        if (linkUrl === null)
                            throw new Error(`${LINK_URL_PLACEHOLDER} needs an https DASHBOARD_ORIGIN`);
                        return linkUrl;
                    }),
                docsAnchor: path.docsAnchor,
            })),
        ],
        ...(options === undefined ? {} : { installationOptions: options }),
        installGuideUrl: config.installGuideUrl,
        expiresAt: issued.expiresAt,
    };
}
