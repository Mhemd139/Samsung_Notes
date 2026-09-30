export class NoteError extends Error {}

export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
