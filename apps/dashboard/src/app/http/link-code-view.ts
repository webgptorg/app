import { formatLinkUrl } from '@ptbk/protocol';

import type { IssueLinkCodeOutcome } from '../../domain/registration/issue-link-code';
import { installationOptions } from '../../domain/registration/installation-options';
import type { LinkCodeView } from '../../shared/api/routes';
import type { DashboardConfig } from '../config';
import { LINK_CODE_PLACEHOLDER, LINK_URL_PLACEHOLDER } from '../config';

type Issued = Extract<IssueLinkCodeOutcome, { readonly kind: 'issued' }>;

/** The view of a code just issued: the code, its link URL and each install tab with one of them filled in. */
export function issuedLinkCodeView(
    config: Pick<DashboardConfig, 'dashboardOrigin' | 'installCommands' | 'installGuideUrl' | 'engineInstallation'>,
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
