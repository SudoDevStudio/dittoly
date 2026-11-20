import { AppError, badRequest } from '../runtime/errors.js';

export { AppError, badRequest };

export const notFound = (what: string) => new AppError(`${what}_not_found`, 404);
export const forbidden = (code = 'forbidden') => new AppError(code, 403);
export const conflict = (code: string) => new AppError(code, 409);
