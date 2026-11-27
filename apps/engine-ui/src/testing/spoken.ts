/** An element's text as a screen reader says it: what is `aria-hidden`, such as a step marker's number or tick, is left out. */
export function spoken(element: HTMLElement): string | null {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden]').forEach((hidden) => {
        hidden.remove();
    });
    return copy.textContent;
}
