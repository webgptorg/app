/** A CT source that answered badly; the name is all the logs keep. */
export class CtSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CtSourceError';
    }
}
