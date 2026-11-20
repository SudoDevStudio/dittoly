/** Errors safe to return to API clients: a stable code and a fixed message, never user data. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message?: string,
    /** What an AI answered, when the error is that its answer could not be read (an excerpt). */
    readonly raw?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

/** The broker refused a call outside any run (a manifest violation): counted toward automatic stops. */
export class ViolationError extends AppError {
  constructor(code: string) {
    super(code, 502);
  }
}

export const badRequest = (code: string, message?: string) => new AppError(code, 400, message);
