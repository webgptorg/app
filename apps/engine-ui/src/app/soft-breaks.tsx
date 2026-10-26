import { Fragment } from 'react';

/** Splits `text` after every character in `after`, keeping each separator at the end of its piece. */
export function splitAfter(text: string, after: string): string[] {
    const pieces: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (after.includes(text.charAt(index))) {
            pieces.push(text.slice(start, index + 1));
            start = index + 1;
        }
    }
    if (start < text.length || pieces.length === 0) pieces.push(text.slice(start));
    return pieces;
}

/**
 * Text that may wrap after the given characters and nowhere else (`<wbr>`), so an IP address, a MIME type or JSON
 * breaks between its parts instead of mid-token. The text, its selection and its copy stay exactly the same.
 */
export function SoftBreaks({ text, after }: { readonly text: string; readonly after: string }) {
    const pieces = splitAfter(text, after);
    return pieces.map((piece, index) => (
        // The pieces of one string never reorder; their position is their identity.
        <Fragment key={index}>
            {piece}
            {index < pieces.length - 1 ? <wbr /> : null}
        </Fragment>
    ));
}
