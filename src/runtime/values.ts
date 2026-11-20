import { badRequest } from './errors.js';
import type { Column, ColumnType } from './types.js';

/** Table columns and the values they hold. */

export const COLUMN_TYPES = ['text', 'number', 'boolean', 'date'] as const satisfies readonly ColumnType[];
export type { Column, ColumnType };
export type Row = Record<string, unknown>;

export const LIMITS = { tables: 50, columns: 30, rows: 10_000, keyLength: 300, text: 10_000, rowBytes: 64_000, list: 500 } as const;

export function coerce(type: ColumnType, value: unknown, column: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) throw badRequest('invalid_value', `${column}: not a number`);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (['true', 'yes', '1'].includes(String(value).toLowerCase())) return true;
      if (['false', 'no', '0'].includes(String(value).toLowerCase())) return false;
      throw badRequest('invalid_value', `${column}: not yes or no`);
    case 'date': {
      const s = String(value).trim();
      const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
      if (Number.isNaN(d.getTime())) throw badRequest('invalid_value', `${column}: not a date`);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : d.toISOString();
    }
    default: {
      const t = typeof value === 'string' ? value : JSON.stringify(value);
      if (t.length > LIMITS.text) throw badRequest('invalid_value', `${column}: longer than ${LIMITS.text} characters`);
      return t;
    }
  }
}
