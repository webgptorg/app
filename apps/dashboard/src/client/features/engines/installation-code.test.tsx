import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InstallationCode } from './installation-code';

describe('installation code highlighting', () => {
    it('preserves shell punctuation, markup-like text, quoted values and line endings', () => {
        const value =
            "curl -fsSL https://example.test/bash | PTBK_LINK=demo bash\r\n$env:PTBK_LINK='ptbk'; irm '<b>curl</b>' | iex\n";
        const { container } = render(<InstallationCode value={value} prompt={false} />);
        expect(container.textContent).toBe(value);
        expect(container.querySelector('b')).toBeNull();
        expect(Array.from(container.querySelectorAll('span'), (span) => span.textContent)).toEqual([
            'curl',
            '-fsSL',
            'PTBK_LINK',
            'bash',
            '$env:PTBK_LINK',
            'irm',
            'iex',
        ]);
    });

    it('leaves prompt prose plain and highlights the embedded shell commands', () => {
        const value =
            "Use curl and check ptbk --version.\n\ncurl -fsSL https://example.test/install.sh | bash\nWindows PowerShell:\n$env:PTBK_LINK='demo'; irm https://example.test/install.ps1 | iex";
        const { container } = render(<InstallationCode value={value} prompt />);
        expect(container.textContent).toBe(value);
        expect(Array.from(container.querySelectorAll('span'), (span) => span.textContent)).toEqual([
            'curl',
            '-fsSL',
            'bash',
            '$env:PTBK_LINK',
            'irm',
            'iex',
        ]);
    });
});
