/** Only errors authored by this app may be shown verbatim; network errors may echo private data. */
export class AppError extends Error {
  constructor(message: string) { super(message); this.name = 'AppError'; }
}
