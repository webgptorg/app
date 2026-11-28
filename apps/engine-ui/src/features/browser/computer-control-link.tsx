import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';

export function ComputerControlLink() {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.computerControl, permission: 'browser.control' });
    if (!allowed) return null;
    return (
        <a className="text-sm underline" href="/computer" target="_blank" rel="noopener noreferrer">
            {m.browser_control_computer()}
        </a>
    );
}
