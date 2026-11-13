import { cx } from '../../../app/cx';
import { ReferenceText } from '../references/reference-text';

/**
 * Text exactly as written: user messages and replies while they stream. Whitespace is kept, and a line without break
 * opportunities (an agent can send one on purpose) wraps anywhere rather than widening the page. In a thread, its
 * references become chips.
 */
export function PlainText({ text, className }: { readonly text: string; readonly className?: string }) {
    return (
        <p className={cx('min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]', className)}>
            <ReferenceText text={text} />
        </p>
    );
}
