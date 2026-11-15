import type { GalleryEntry } from '../../gallery-entry';
import { Button } from './button';
import type { ButtonVariant } from './button';

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'danger-ghost', 'danger-solid'];

export const buttonGallery: GalleryEntry = {
    id: 'button',
    title: 'Button',
    render: () => (
        <div className="flex flex-col gap-3">
            {VARIANTS.map((variant) => (
                <div key={variant} className="flex flex-wrap items-center gap-3">
                    <Button variant={variant}>{variant}</Button>
                    <Button variant={variant} size="sm">
                        {`${variant} small`}
                    </Button>
                    <Button variant={variant} loading>
                        {`${variant} loading`}
                    </Button>
                    <Button variant={variant} disabled>
                        {`${variant} disabled`}
                    </Button>
                    <Button variant={variant} disabled disabledReason="Not allowed for your role">
                        {`${variant} with reason`}
                    </Button>
                </div>
            ))}
        </div>
    ),
};
