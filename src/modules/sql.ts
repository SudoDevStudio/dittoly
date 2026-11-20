import type { Dialect } from '../runtime/sql.js';

export { bindSql, checkParams, MAX_SQL_STRING, type Dialect, type SqlParam, type SqlParamType } from '../runtime/sql.js';

/**
 * Fixed SQL queries for database endpoints (PostgreSQL, MySQL/MariaDB, SQL Server).
 *
 * A module never writes SQL at run time: every query is declared in the manifest, reviewed
 * by an admin, and checked here. The code picks a query by id and passes parameter values,
 * which are always sent to the database as bound parameters, never pasted into the text
 * (SQL injection, OWASP A05). The checks below are strict on purpose; a query they refuse
 * can usually be written more plainly.
 *
 * - one statement, no comments, no dollar-quoting, no backslashes in strings;
 * - "read" queries are SELECT (or WITH ... SELECT) and never change data;
 * - "write" queries are INSERT, UPDATE or DELETE, and UPDATE and DELETE need a WHERE;
 * - no schema changes, permissions, transactions, session settings, procedures, file or
 *   network access, or functions that read files, sleep or run other SQL;
 * - parameters are named ":name" and each one is declared with a type.
 */


type Token =
  | { t: 'word'; v: string; upper: string }
  | { t: 'quoted' } // a quoted identifier: never a keyword
  | { t: 'string' }
  | { t: 'number' }
  | { t: 'param'; name: string }
  | { t: 'punct'; v: string };

const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Split SQL into tokens, refusing anything whose meaning could depend on server settings. */
export function tokenize(sql: string, dialect: Dialect): { tokens: Token[]; problems: string[] } {
  const tokens: Token[] = [];
  const problems: string[] = [];
  const n = sql.length;
  let i = 0;
  const fail = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((c === '-' && next === '-') || (c === '/' && next === '*') || (c === '#' && dialect === 'mysql')) {
      fail('comments are not allowed');
      break;
    }
    // String literals. Postgres E'...' and MySQL backslash escapes change where a string ends.
    const prefixed = (c === 'N' || c === 'n') && next === "'" && dialect === 'mssql';
    if ((c === 'E' || c === 'e') && next === "'" && dialect === 'postgres') {
      fail("escape strings (E'...') are not allowed");
      break;
    }
    if (c === "'" || prefixed || (c === '"' && dialect === 'mysql')) {
      const quote = prefixed ? "'" : c;
      let j = i + (prefixed ? 2 : 1);
      let closed = false;
      while (j < n) {
        // MySQL (and Postgres with standard_conforming_strings off) treat a backslash as an escape.
        if (sql[j] === '\\') {
          fail('backslashes in strings are not allowed');
          break;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        fail('unterminated string');
        break;
      }
      // MySQL "..." is a string by default but an identifier in ANSI_QUOTES mode: ambiguous.
      if (c === '"') fail('double-quoted strings are not allowed in MySQL; use single quotes');
      tokens.push({ t: 'string' });
      i = j + 1;
      continue;
    }
    // Quoted identifiers.
    const close = c === '"' ? '"' : c === '`' && dialect === 'mysql' ? '`' : c === '[' && dialect === 'mssql' ? ']' : null;
    if (close) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed || j === i + 1) {
        fail('unterminated quoted name');
        break;
      }
      tokens.push({ t: 'quoted' });
      i = j + 1;
      continue;
    }
    if (c === '$' && dialect === 'postgres') {
      // $1 style placeholders and $tag$ dollar-quoted strings are both refused.
      fail(/^\$(\d|[A-Za-z_]*\$)/.test(sql.slice(i)) ? 'use :name parameters, not $n or dollar-quoted strings' : 'unexpected "$"');
      break;
    }
    if (c === '?' && dialect !== 'postgres') {
      fail('use :name parameters, not ?');
      break;
    }
    if (c === '@' && dialect !== 'postgres') {
      // SQL Server variables and MySQL user variables; parameters are :name.
      fail('variables (@name) are not allowed; use :name parameters');
      break;
    }
    if (c === ':') {
      if (next === ':') {
        tokens.push({ t: 'punct', v: '::' });
        i += 2;
        continue;
      }
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        if (!PARAM_NAME.test(m[1]!)) fail(`parameter :${m[1]} must be lower_snake_case`);
        tokens.push({ t: 'param', name: m[1]! });
        i += m[0].length;
        continue;
      }
      tokens.push({ t: 'punct', v: ':' });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      const m = /^(0x[0-9a-f]+|[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?)/i.exec(sql.slice(i))!;
      if (/^0x/i.test(m[0])) fail('hex literals are not allowed');
      tokens.push({ t: 'number' });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127) {
      const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(sql.slice(i))!;
      tokens.push({ t: 'word', v: m[0], upper: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (c === ';') {
      if (sql.slice(i + 1).trim() !== '') {
        fail('only one statement is allowed');
        break;
      }
      i++;
      continue;
    }
    // Postgres also has the jsonb and array operators @>, ?, #>, a[1].
    if ('(),.=<>!+-*/%|&^~'.includes(c) || (dialect === 'postgres' && '@?#[]'.includes(c))) {
      tokens.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    fail(`unexpected character "${c}"`);
    break;
  }
  return { tokens, problems };
}

/** Never allowed anywhere in a query (outside strings and quoted names). */
const FORBIDDEN_WORDS = new Set([
  // schema and permissions
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY',
  // procedures and dynamic SQL
  'EXEC', 'EXECUTE', 'CALL', 'PREPARE', 'DEALLOCATE', 'DECLARE', 'HANDLER',
  // files, servers and bulk data
  'COPY', 'LOAD', 'OUTFILE', 'DUMPFILE', 'INFILE', 'BULK', 'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY', 'SHUTDOWN', 'KILL', 'RECONFIGURE', 'DBCC', 'WAITFOR',
  // maintenance, plans that run the query, and statements that do several things
  'VACUUM', 'EXPLAIN', 'MERGE',
]);
/**
 * SQL Server runs statements written one after another without a ";", so the words that start
 * statements of their own are refused there too. (Postgres and MySQL need the ";", which is refused.)
 */
const FORBIDDEN_MSSQL = new Set([
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'USE', 'GO', 'BACKUP', 'RESTORE', 'CHECKPOINT', 'REVERT', 'PRINT', 'RAISERROR', 'THROW',
  'IF', 'WHILE', 'RETURN', 'GOTO', 'BREAK', 'CONTINUE', 'TRY', 'CATCH', 'SETUSER', 'READTEXT', 'WRITETEXT', 'UPDATETEXT',
]);

/** Functions that read files, sleep, take locks, change settings or run other SQL. */
const FORBIDDEN_FUNCTIONS = new Set([
  'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_LS_DIR', 'PG_STAT_FILE', 'PG_SLEEP', 'PG_SLEEP_FOR', 'PG_SLEEP_UNTIL',
  'LO_IMPORT', 'LO_EXPORT', 'LO_GET', 'LO_PUT', 'LO_FROM_BYTEA', 'LO_UNLINK', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE', 'PG_FILE_WRITE', 'PG_FILE_RENAME', 'PG_FILE_UNLINK', 'PG_NOTIFY', 'SET_CONFIG', 'QUERY_TO_XML', 'QUERY_TO_XML_AND_XMLSCHEMA', 'QUERY_TO_XMLSCHEMA', 'CURSOR_TO_XML', 'PG_LOGICAL_EMIT_MESSAGE',
  'FN_XE_FILE_TARGET_READ_FILE', 'FN_GET_AUDIT_FILE', 'FN_TRACE_GETTABLE',
  'SLEEP', 'BENCHMARK', 'LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'SYS_EXEC', 'SYS_EVAL',
]);
const FORBIDDEN_PREFIXES = ['DBLINK', 'PG_ADVISORY', 'PG_TRY_ADVISORY', 'XP_', 'SP_'];

/** Statement shapes by effect. */
const READ_START = new Set(['SELECT', 'WITH']);
const WRITE_START = new Set(['INSERT', 'UPDATE', 'DELETE']);
const DATA_CHANGING = new Set(['INSERT', 'UPDATE', 'DELETE', 'INTO']);

export interface SqlCheck {
  problems: string[];
  /** Parameter names in the order they appear (repeats included). */
  params: string[];
}

/** Check one declared query. */
export function checkSql(sql: string, dialect: Dialect, effect: 'read' | 'write'): SqlCheck {
  const { tokens, problems } = tokenize(sql, dialect);
  const params = tokens.flatMap((t) => (t.t === 'param' ? [t.name] : []));
  if (problems.length) return { problems, params };
  const words = tokens.filter((t): t is Extract<Token, { t: 'word' }> => t.t === 'word');
  const first = tokens[0];
  if (!first || first.t !== 'word') return { problems: ['must start with SELECT, WITH, INSERT, UPDATE or DELETE'], params };

  const wordAt = (i: number) => {
    const t = tokens[i];
    return t?.t === 'word' ? t.upper : null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.t !== 'word') continue;
    if (FORBIDDEN_WORDS.has(t.upper) || (dialect === 'mssql' && FORBIDDEN_MSSQL.has(t.upper))) problems.push(`${t.upper} is not allowed`);
    const isCall = tokens[i + 1]?.t === 'punct' && (tokens[i + 1] as { v: string }).v === '(';
    if (FORBIDDEN_FUNCTIONS.has(t.upper) && isCall) problems.push(`${t.v}() is not allowed`);
    if (FORBIDDEN_PREFIXES.some((p) => t.upper.startsWith(p))) problems.push(`${t.v} is not allowed`);
    // SET only right after UPDATE <table> (also ON CONFLICT DO UPDATE SET); never as a statement of its own.
    if (t.upper === 'SET') {
      let j = i - 1;
      let steps = 0;
      while (j >= 0 && steps < 8 && wordAt(j) !== 'UPDATE') {
        const p = tokens[j]!;
        const nameLike = p.t === 'quoted' || (p.t === 'word' && !['WHERE', 'FROM', 'SELECT', 'AND', 'OR'].includes(p.upper)) || (p.t === 'punct' && p.v === '.');
        if (!nameLike) break;
        j--;
        steps++;
      }
      if (wordAt(j) !== 'UPDATE') problems.push('SET is only allowed in UPDATE ... SET');
    }
    if (t.upper === 'INTO' && !(wordAt(i - 1) === 'INSERT' || (wordAt(i - 1) === 'IGNORE' && wordAt(i - 2) === 'INSERT'))) problems.push('INTO is only allowed in INSERT INTO');
  }

  if (effect === 'read') {
    if (!READ_START.has(first.upper)) problems.push('a read query must start with SELECT or WITH');
    for (const w of words) if (DATA_CHANGING.has(w.upper)) problems.push(`a read query cannot use ${w.upper}`);
    // SELECT ... FOR UPDATE / FOR SHARE takes row locks.
    for (let i = 0; i < tokens.length; i++) if (wordAt(i) === 'FOR' && ['UPDATE', 'SHARE', 'NO'].includes(wordAt(i + 1) ?? '')) problems.push('a read query cannot lock rows');
  } else {
    if (!WRITE_START.has(first.upper)) problems.push('a write query must start with INSERT, UPDATE or DELETE');
    if ((first.upper === 'UPDATE' || first.upper === 'DELETE') && !words.some((w) => w.upper === 'WHERE')) problems.push(`${first.upper} needs a WHERE clause`);
    // One change per query. (ON CONFLICT DO UPDATE and ON DUPLICATE KEY UPDATE belong to the INSERT.)
    const changes = tokens.filter((t, i) => t.t === 'word' && (t.upper === 'INSERT' || t.upper === 'DELETE' || (t.upper === 'UPDATE' && !['DO', 'KEY'].includes(wordAt(i - 1) ?? ''))));
    if (changes.length > 1) problems.push('a write query makes one change (one INSERT, UPDATE or DELETE)');
  }
  return { problems: [...new Set(problems)], params };
}
