import { withTx, type Db, type Queryable, type Tx } from '../db/db.js';
import { revokeAgentsOf } from '../mcp/agents.js';
import { audit, type AuditEvent } from './audit.js';
import { randomToken, sha256Hex } from './crypto.js';
import { AppError, conflict, forbidden, notFound } from './errors.js';
import { log } from './log.js';
import { handleFrom, type Member, type Role } from './members.js';
import { notify } from './notify.js';

/**
 * SCIM 2.0 provisioning (RFC 7643 schema, RFC 7644 protocol): the identity provider creates,
 * updates and offboards people, and pushes groups that become teams. It acts with a bearer
 * token an admin creates in the portal; every change it makes is audited with that token as the
 * actor. It only ever sees members it created, or ones an admin linked to it. See docs/scim.md.
 */

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** Pages hold at most this many resources. */
export const MAX_PAGE = 200;

/** An error the identity provider gets in SCIM form. `denied` is audited after the change is rolled back. */
export class ScimError extends AppError {
  constructor(
    httpStatus: number,
    readonly scimType: string | null,
    code: string,
    readonly detail: string,
    readonly denied?: Omit<AuditEvent, 'outcome' | 'actorId'>,
  ) {
    super(code, httpStatus, detail);
  }
}

const invalid = (detail: string, scimType = 'invalidValue') => new ScimError(400, scimType, 'invalid_value', detail);
const taken = (detail: string) => new ScimError(409, 'uniqueness', 'already_exists', detail);

/** Who changes things: the SCIM token. Audits name it as the actor. */
export interface ScimActor {
  tokenId: string;
}

const ROLE_RANK: Record<Role, number> = { member: 0, approver: 1, admin: 2 };
const higher = (a: Role, b: Role): Role => (ROLE_RANK[a] >= ROLE_RANK[b] ? a : b);

// ---------------------------------------------------------------- the token

/** A new SCIM token (shown once). Any earlier one stops working at once. */
export async function createScimToken(db: Db, actor: Member): Promise<{ id: string; token: string }> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const token = 'dty_scim_' + randomToken();
  return withTx(db, async (tx) => {
    const old = await tx.query<{ id: string }>(`UPDATE scim_tokens SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`);
    const { rows } = await tx.query<{ id: string }>(`INSERT INTO scim_tokens (token_hash, created_by) VALUES ($1, $2) RETURNING id`, [sha256Hex(token), actor.id]);
    const id = rows[0]!.id;
    for (const o of old.rows) await audit(tx, { actorId: actor.id, action: 'scim.token_revoked', subjectType: 'org', subjectId: o.id, outcome: 'ok' });
    await audit(tx, { actorId: actor.id, action: old.rowCount ? 'scim.token_rotated' : 'scim.token_created', subjectType: 'org', subjectId: id, outcome: 'ok' });
    return { id, token };
  });
}

export async function revokeScimToken(db: Queryable, actor: Member): Promise<void> {
  if (actor.role !== 'admin') throw forbidden('admin_only');
  const { rows } = await db.query<{ id: string }>(`UPDATE scim_tokens SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`);
  if (!rows[0]) throw notFound('scim_token');
  await audit(db, { actorId: actor.id, action: 'scim.token_revoked', subjectType: 'org', subjectId: rows[0].id, outcome: 'ok' });
}

/** The active token with this value. Only hashes are compared, so there is no timing to learn from. */
export async function scimTokenFor(db: Queryable, token: string): Promise<ScimActor | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE scim_tokens SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id`,
    [sha256Hex(token)],
  );
  return rows[0] ? { tokenId: rows[0].id } : null;
}

// ---------------------------------------------------------------- reading what the identity provider sent

/** Text the identity provider sends, made safe to show: no control or invisible characters, one line, bounded. */
export function cleanText(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const out = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return out || null;
}

/** SCIM attribute names are case-insensitive. */
function attr(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (obj as Record<string, unknown>)[key];
}

/** Entra ID sends `active` as the string "True"/"False" unless its compliance flag is set. */
export function scimBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw invalid('active must be true or false');
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export interface UserInput {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  name: { givenName?: string; familyName?: string; formatted?: string } | null;
  email: string | null;
  /** undefined: leave as it is. */
  active: boolean | undefined;
}

function readName(v: unknown): UserInput['name'] {
  if (!v || typeof v !== 'object') return null;
  const out: NonNullable<UserInput['name']> = {};
  for (const k of ['givenName', 'familyName', 'formatted'] as const) {
    const t = cleanText(attr(v, k));
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** The work (or primary, or first) address of a SCIM `emails` list. */
function readEmails(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const pick = v.find((e) => attr(e, 'primary') === true || attr(e, 'primary') === 'True') ?? v.find((e) => attr(e, 'type') === 'work') ?? v[0];
  return readEmail(attr(pick, 'value'));
}

function readEmail(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !EMAIL.test(v.trim())) throw invalid('emails.value is not an email address');
  return v.trim().toLowerCase();
}

function readUserName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 256 || /[\p{Cc}\p{Cf}]/u.test(s)) throw invalid('userName is required (at most 256 characters)');
  return s;
}

function readExternalId(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || v.length > 256 || /[\p{Cc}]/u.test(v)) throw invalid('externalId must be text of at most 256 characters');
  return v;
}

/** A full User as POST and PUT send it. */
export function readUser(body: unknown): UserInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('send a User object', 'invalidSyntax');
  const userName = readUserName(attr(body, 'userName'));
  const name = readName(attr(body, 'name'));
  const active = attr(body, 'active');
  return {
    userName,
    externalId: readExternalId(attr(body, 'externalId')),
    displayName: cleanText(attr(body, 'displayName')),
    name,
    email: readEmails(attr(body, 'emails')) ?? (EMAIL.test(userName) ? userName.toLowerCase() : null),
    active: active === undefined || active === null ? undefined : scimBool(active),
  };
}

export interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string | null;
  value: unknown;
}

/** The operations of a PatchOp request. `op` is case-insensitive: Entra ID sends "Replace". */
export function readPatch(body: unknown): PatchOp[] {
  const ops = attr(body, 'Operations');
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 1000) throw invalid('send a PatchOp with Operations', 'invalidSyntax');
  return ops.map((o) => {
    const op = typeof attr(o, 'op') === 'string' ? (attr(o, 'op') as string).toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw invalid('op must be add, replace or remove', 'invalidSyntax');
    const path = attr(o, 'path');
    if (path !== undefined && path !== null && (typeof path !== 'string' || path.length > 300)) throw invalid('path must be text', 'invalidPath');
    return { op, path: typeof path === 'string' && path.trim() ? path.trim() : null, value: attr(o, 'value') };
  });
}

const USER_URN = USER_SCHEMA.toLowerCase() + ':';

/** Apply PATCH operations to a User. Attributes Dittoly does not keep (title, phone numbers, ...) are accepted and ignored. */
export function applyUserPatch(cur: UserInput, ops: PatchOp[]): UserInput {
  const next: UserInput = { ...cur, name: cur.name ? { ...cur.name } : null };
  const set = (path: string, value: unknown, op: PatchOp['op']) => {
    let p = path.toLowerCase();
    if (p.startsWith(USER_URN)) p = p.slice(USER_URN.length);
    const remove = op === 'remove';
    if (p === 'active') {
      if (!remove) next.active = scimBool(value);
    } else if (p === 'username') {
      if (remove) throw new ScimError(400, 'mutability', 'invalid_value', 'userName cannot be removed');
      next.userName = readUserName(value);
    } else if (p === 'externalid') next.externalId = remove ? null : readExternalId(value);
    else if (p === 'displayname') next.displayName = remove ? null : cleanText(value);
    else if (p === 'name') next.name = remove ? null : { ...(op === 'add' ? next.name : {}), ...readName(value) };
    else if (p === 'name.givenname' || p === 'name.familyname' || p === 'name.formatted') {
      const key = ({ 'name.givenname': 'givenName', 'name.familyname': 'familyName', 'name.formatted': 'formatted' } as const)[p];
      const name = { ...next.name };
      const t = remove ? null : cleanText(value);
      if (t) name[key] = t;
      else delete name[key];
      next.name = Object.keys(name).length ? name : null;
    } else if (p === 'emails') next.email = remove ? null : Array.isArray(value) ? readEmails(value) : readEmails([value]);
    else if (p === 'emails.value' || /^emails\[[^\]]*\]\.value$/.test(p)) next.email = remove ? null : readEmail(value);
  };
  for (const o of ops) {
    if (o.path) set(o.path, o.value, o.op);
    else if (o.op === 'remove') throw new ScimError(400, 'noTarget', 'invalid_value', 'remove needs a path');
    else if (!o.value || typeof o.value !== 'object' || Array.isArray(o.value)) throw invalid('value must be an object when there is no path');
    // Without a path, each key of the value is a path ("name.givenName" included).
    else for (const [k, v] of Object.entries(o.value)) set(k, v, o.op);
  }
  return next;
}

// ---------------------------------------------------------------- filters

export interface Condition {
  attr: string;
  value: string | boolean | null;
}

/**
 * `filter` as identity providers send it: `attr eq "value"`, optionally joined with `and`.
 * Other operators are refused with invalidFilter, so nothing is silently matched too widely.
 */
export function parseFilter(filter: string | undefined): Condition[] {
  if (filter === undefined || filter.trim() === '') return [];
  if (filter.length > 1000) throw new ScimError(400, 'invalidFilter', 'invalid_filter', 'filter is too long');
  const out: Condition[] = [];
  let rest = filter.trim();
  const term = /^([A-Za-z][\w:.$-]*(?:\[[^\]]*\])?(?:\.[A-Za-z$][\w$]*)?)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false|null)\s*/i;
  for (;;) {
    const m = term.exec(rest);
    if (!m) throw new ScimError(400, 'invalidFilter', 'invalid_filter', 'only `attribute eq "value"` filters, joined with `and`, are supported');
    const raw = m[2]!;
    const value = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.toLowerCase() === 'null' ? null : raw.toLowerCase() === 'true';
    out.push({ attr: m[1]!.toLowerCase(), value });
    rest = rest.slice(m[0].length);
    if (!rest) return out;
    const and = /^and\s+/i.exec(rest);
    if (!and) throw new ScimError(400, 'invalidFilter', 'invalid_filter', 'only `and` joins filter terms');
    rest = rest.slice(and[0].length);
  }
}

function userWhere(conds: Condition[], params: unknown[]): string {
  return conds
    .map((c) => {
      let a = c.attr;
      if (a.startsWith(USER_URN)) a = a.slice(USER_URN.length);
      params.push(c.value);
      const p = `$${params.length}`;
      if (a === 'username') return `lower(m.scim_user_name) = lower(${p}::text)`;
      if (a === 'externalid') return `m.scim_external_id = ${p}::text`;
      if (a === 'id') return `m.id::text = ${p}::text`;
      if (a === 'displayname') return `m.display_name = ${p}::text`;
      if (a === 'emails' || a === 'emails.value' || /^emails\[[^\]]*\]\.value$/.test(a)) return `lower(m.email) = lower(${p}::text)`;
      if (a === 'active') return `(NOT m.disabled) = ${p}::boolean`;
      throw new ScimError(400, 'invalidFilter', 'invalid_filter', `filtering on ${c.attr} is not supported`);
    })
    .map((s) => ` AND ${s}`)
    .join('');
}

function groupWhere(conds: Condition[], params: unknown[]): string {
  return conds
    .map((c) => {
      params.push(c.value);
      const p = `$${params.length}`;
      if (c.attr === 'displayname') return `lower(g.display_name) = lower(${p}::text)`;
      if (c.attr === 'externalid') return `g.external_id = ${p}::text`;
      if (c.attr === 'id') return `g.id::text = ${p}::text`;
      if (c.attr === 'members' || c.attr === 'members.value') return `EXISTS (SELECT 1 FROM scim_group_members x WHERE x.group_id = g.id AND x.member_id::text = ${p}::text)`;
      throw new ScimError(400, 'invalidFilter', 'invalid_filter', `filtering on ${c.attr} is not supported`);
    })
    .map((s) => ` AND ${s}`)
    .join('');
}

/** startIndex is 1-based; count 0 asks only for the total. */
export function paging(startIndex: unknown, count: unknown): { offset: number; limit: number } {
  const s = Number(startIndex ?? 1);
  const c = Number(count ?? 100);
  return { offset: Number.isFinite(s) && s >= 1 ? Math.floor(s) - 1 : 0, limit: Number.isFinite(c) && c >= 0 ? Math.min(Math.floor(c), MAX_PAGE) : 100 };
}

// ---------------------------------------------------------------- resources

interface UserRow {
  id: string;
  handle: string;
  role: Role;
  email: string | null;
  display_name: string | null;
  disabled: boolean;
  scim_disabled: boolean;
  scim_user_name: string;
  scim_external_id: string | null;
  scim_name: UserInput['name'];
  created_at: Date;
  scim_updated_at: Date | null;
  manual_role: Role | null;
}

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  team_id: string;
  owns_team: boolean;
  grants_role: 'admin' | 'approver' | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLS = `m.id, m.handle, m.role, m.email, m.display_name, m.disabled, m.scim_disabled, m.scim_user_name, m.scim_external_id, m.scim_name,
  m.created_at, m.scim_updated_at, m.manual_role`;
/** Members the identity provider can see: the ones it manages. */
const VISIBLE = `m.scim_user_name IS NOT NULL AND m.scim_deleted_at IS NULL`;

export interface ScimDeps {
  db: Db;
  /** The engine's cancel path (it audits each cancellation). */
  cancelRun: (runId: string, actor: Member) => Promise<void>;
  /** The engine's path for cancelling the person's pending delegations, in the offboarding transaction (it audits and tells the other person). */
  cancelDelegations: (tx: Tx, memberId: string, actorId: string) => Promise<unknown>;
  /** Where the SCIM API is served: <public url>/scim/v2 */
  baseUrl: string;
  /** The configured OpenID Connect issuer, for recognizing an account that already signed in with it. */
  oidcIssuer: string | undefined;
}

export class Scim {
  constructor(private readonly d: ScimDeps) {}

  private userResource(r: UserRow, groups: { id: string; display_name: string }[]) {
    return {
      schemas: [USER_SCHEMA],
      id: r.id,
      ...(r.scim_external_id !== null ? { externalId: r.scim_external_id } : {}),
      userName: r.scim_user_name,
      ...(r.scim_name ? { name: r.scim_name } : {}),
      ...(r.display_name ? { displayName: r.display_name } : {}),
      emails: r.email ? [{ value: r.email, type: 'work', primary: true }] : [],
      active: !r.disabled,
      groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${this.d.baseUrl}/Groups/${g.id}` })),
      meta: { resourceType: 'User', created: r.created_at, lastModified: r.scim_updated_at ?? r.created_at, location: `${this.d.baseUrl}/Users/${r.id}` },
    };
  }

  private groupResource(g: GroupRow, members: { id: string; handle: string }[] | null) {
    return {
      schemas: [GROUP_SCHEMA],
      id: g.id,
      ...(g.external_id !== null ? { externalId: g.external_id } : {}),
      displayName: g.display_name,
      ...(members ? { members: members.map((m) => ({ value: m.id, display: m.handle, $ref: `${this.d.baseUrl}/Users/${m.id}` })) } : {}),
      meta: { resourceType: 'Group', created: g.created_at, lastModified: g.updated_at, location: `${this.d.baseUrl}/Groups/${g.id}` },
    };
  }

  private async groupsOf(db: Queryable, memberIds: string[]): Promise<Map<string, { id: string; display_name: string }[]>> {
    const out = new Map<string, { id: string; display_name: string }[]>();
    if (!memberIds.length) return out;
    const { rows } = await db.query<{ member_id: string; id: string; display_name: string }>(
      `SELECT gm.member_id, g.id, g.display_name FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id WHERE gm.member_id = ANY($1) ORDER BY g.display_name`,
      [memberIds],
    );
    for (const r of rows) out.set(r.member_id, [...(out.get(r.member_id) ?? []), { id: r.id, display_name: r.display_name }]);
    return out;
  }

  private async membersOf(db: Queryable, groupIds: string[]): Promise<Map<string, { id: string; handle: string }[]>> {
    const out = new Map<string, { id: string; handle: string }[]>(groupIds.map((id) => [id, []]));
    if (!groupIds.length) return out;
    const { rows } = await db.query<{ group_id: string; id: string; handle: string }>(
      `SELECT gm.group_id, m.id, m.handle FROM scim_group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ANY($1) ORDER BY m.handle`,
      [groupIds],
    );
    for (const r of rows) out.get(r.group_id)!.push({ id: r.id, handle: r.handle });
    return out;
  }

  private list<T>(resources: T[], total: number, offset: number) {
    return { schemas: [LIST_SCHEMA], totalResults: total, startIndex: offset + 1, itemsPerPage: resources.length, Resources: resources };
  }

  // ------------------------------------------------------------ Users

  async listUsers(q: { filter?: string; startIndex?: unknown; count?: unknown; excludedAttributes?: string }) {
    const params: unknown[] = [];
    const where = `${VISIBLE}${userWhere(parseFilter(q.filter), params)}`;
    const { offset, limit } = paging(q.startIndex, q.count);
    const total = Number((await this.d.db.query<{ n: string }>(`SELECT count(*) AS n FROM members m WHERE ${where}`, params)).rows[0]!.n);
    const { rows } = limit
      ? await this.d.db.query<UserRow>(`SELECT ${USER_COLS} FROM members m WHERE ${where} ORDER BY m.created_at, m.id OFFSET ${offset} LIMIT ${limit}`, params)
      : { rows: [] as UserRow[] };
    const groups = excluded(q.excludedAttributes, 'groups') ? new Map() : await this.groupsOf(this.d.db, rows.map((r) => r.id));
    return this.list(rows.map((r) => this.userResource(r, groups.get(r.id) ?? [])), total, offset);
  }

  async getUser(id: string, db: Queryable = this.d.db) {
    const r = await this.userRow(db, id);
    return this.userResource(r, (await this.groupsOf(db, [id])).get(id) ?? []);
  }

  private async userRow(db: Queryable, id: string, lock = false): Promise<UserRow> {
    if (!UUID.test(id)) throw new ScimError(404, null, 'user_not_found', 'no such User');
    const r = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM members m WHERE m.id = $1 AND ${VISIBLE}${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!r) throw new ScimError(404, null, 'user_not_found', 'no such User');
    return r;
  }

  /**
   * POST /Users. A deleted User with the same userName comes back as the same member (history kept,
   * access not restored). An existing account is only taken over when the identity provider proves it is
   * the same identity (externalId is the account's SSO subject at the configured issuer), never by email.
   */
  async createUser(actor: ScimActor, body: unknown): Promise<{ resource: ReturnType<Scim['userResource']>; runsToCancel: string[] }> {
    const input = readUser(body);
    return this.write(async (tx) => {
      const same = (await tx.query<{ id: string; scim_deleted_at: Date | null }>(`SELECT id, scim_deleted_at FROM members WHERE lower(scim_user_name) = lower($1)`, [input.userName])).rows[0];
      if (same && !same.scim_deleted_at) throw taken('a User with this userName exists');
      await this.assertExternalIdFree(tx, input.externalId, same?.id ?? null);
      let id: string;
      if (same) {
        id = same.id;
        await tx.query(`UPDATE members SET scim_deleted_at = NULL WHERE id = $1`, [id]);
        await audit(tx, { actorId: actor.tokenId, action: 'scim.member_restored', subjectType: 'member', subjectId: id, outcome: 'ok' });
      } else {
        const adopted = await this.sameIdentity(tx, input.externalId);
        if (adopted) {
          id = adopted;
          await tx.query(`UPDATE members SET scim_user_name = $2 WHERE id = $1`, [id, input.userName]);
          await audit(tx, { actorId: actor.tokenId, action: 'scim.member_linked', subjectType: 'member', subjectId: id, outcome: 'ok' });
        } else {
          // Someone with this email who signed up before provisioning: only an admin may link them (docs/scim.md).
          const email = input.email ?? (EMAIL.test(input.userName) ? input.userName : null);
          const clash = email ? (await tx.query(`SELECT 1 FROM members WHERE lower(email) = lower($1) AND scim_user_name IS NULL`, [email])).rowCount : 0;
          if (clash) {
            throw new ScimError(409, 'uniqueness', 'existing_account_not_linked', 'An account with this email already exists in Dittoly. An admin links it to this User under Settings, Provisioning (SCIM).', {
              action: 'scim.member_create_refused',
              subjectType: 'org',
              subjectId: 'scim',
              errorType: 'existing_account_not_linked',
            });
          }
          id = await this.insertMember(tx, input);
          await audit(tx, { actorId: actor.tokenId, action: 'scim.member_created', subjectType: 'member', subjectId: id, outcome: 'ok' });
        }
      }
      const runsToCancel = await this.applyUser(tx, actor, id, { ...input, active: input.active ?? true }, true);
      return { resource: await this.getUser(id, tx), runsToCancel };
    });
  }

  /** PUT /Users/:id: the whole User. */
  async replaceUser(actor: ScimActor, id: string, body: unknown) {
    const input = readUser(body);
    return this.write(async (tx) => {
      await this.userRow(tx, id, true);
      const runsToCancel = await this.applyUser(tx, actor, id, input, false);
      return { resource: await this.getUser(id, tx), runsToCancel };
    });
  }

  /** PATCH /Users/:id */
  async patchUser(actor: ScimActor, id: string, body: unknown) {
    const ops = readPatch(body);
    return this.write(async (tx) => {
      const r = await this.userRow(tx, id, true);
      const cur: UserInput = { userName: r.scim_user_name, externalId: r.scim_external_id, displayName: r.display_name, name: r.scim_name, email: r.email, active: undefined };
      const runsToCancel = await this.applyUser(tx, actor, id, applyUserPatch(cur, ops), false);
      return { resource: await this.getUser(id, tx), runsToCancel };
    });
  }

  /** DELETE /Users/:id: offboarded like a deactivation, then no longer a SCIM resource. The member is kept. */
  async deleteUser(actor: ScimActor, id: string): Promise<{ runsToCancel: string[] }> {
    return this.write(async (tx) => {
      const r = await this.userRow(tx, id, true);
      const runsToCancel = r.disabled ? [] : await this.offboard(tx, actor, r, 'deleted');
      // Their group memberships go too, so teams and access reviews no longer list them.
      const groups = (await tx.query<GroupRow>(`SELECT g.* FROM scim_groups g JOIN scim_group_members gm ON gm.group_id = g.id WHERE gm.member_id = $1`, [id])).rows;
      for (const g of groups) await this.removeMember(tx, actor, g, id);
      await this.syncRoles(tx, actor, [id]);
      await tx.query(`UPDATE members SET scim_deleted_at = now(), scim_disabled = true, scim_updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, { actorId: actor.tokenId, action: 'scim.member_deleted', subjectType: 'member', subjectId: id, outcome: 'ok' });
      return { runsToCancel };
    });
  }

  private async assertExternalIdFree(tx: Tx, externalId: string | null, self: string | null): Promise<void> {
    if (externalId === null) return;
    const r = await tx.query(`SELECT 1 FROM members WHERE scim_external_id = $1 AND id IS DISTINCT FROM $2`, [externalId, self]);
    if (r.rowCount) throw taken('a User with this externalId exists');
  }

  /** An account that already signed in with the configured issuer, as the subject the identity provider names. */
  private async sameIdentity(tx: Tx, externalId: string | null): Promise<string | null> {
    if (!externalId || !this.d.oidcIssuer) return null;
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM members WHERE rtrim(oidc_issuer, '/') = rtrim($1, '/') AND oidc_subject = $2 AND scim_user_name IS NULL`,
      [this.d.oidcIssuer, externalId],
    );
    return rows[0]?.id ?? null;
  }

  private async insertMember(tx: Tx, input: UserInput): Promise<string> {
    const base = handleFrom(EMAIL.test(input.userName) ? input.userName.toLowerCase() : `${input.userName.toLowerCase()}@x`, input.userName);
    for (let i = 0; i < 20; i++) {
      const handle = i === 0 ? base : `${base.slice(0, 34)}-${i + 1}`;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO members (handle, role, scim_user_name) VALUES ($1, 'member', $2) ON CONFLICT (handle) DO NOTHING RETURNING id`,
        [handle, input.userName],
      );
      if (rows[0]) return rows[0].id;
    }
    throw conflict('handle_unavailable');
  }

  /**
   * Store what the identity provider sent and act on `active`: false offboards (once), true re-enables an
   * account it disabled. An account an admin disabled by hand stays disabled.
   */
  private async applyUser(tx: Tx, actor: ScimActor, id: string, input: UserInput, created: boolean): Promise<string[]> {
    const before = await this.userRow(tx, id, true);
    if (input.userName.toLowerCase() !== before.scim_user_name.toLowerCase()) {
      const r = await tx.query(`SELECT 1 FROM members WHERE lower(scim_user_name) = lower($1) AND id <> $2`, [input.userName, id]);
      if (r.rowCount) throw taken('a User with this userName exists');
    }
    await this.assertExternalIdFree(tx, input.externalId, id);
    const displayName = input.displayName ?? input.name?.formatted ?? (cleanText([input.name?.givenName, input.name?.familyName].filter(Boolean).join(' ')) || null);
    await tx.query(
      `UPDATE members SET scim_user_name = $2, scim_external_id = $3, scim_name = $4, display_name = COALESCE($5, display_name), email = COALESCE($6, email), scim_updated_at = now()
       WHERE id = $1`,
      [id, input.userName, input.externalId, input.name ? JSON.stringify(input.name) : null, displayName, input.email],
    );
    const changed =
      input.userName !== before.scim_user_name ||
      input.externalId !== before.scim_external_id ||
      sameName(input.name) !== sameName(before.scim_name) ||
      (displayName !== null && displayName !== before.display_name) ||
      (input.email !== null && input.email !== before.email);
    if (changed && !created) await audit(tx, { actorId: actor.tokenId, action: 'scim.member_updated', subjectType: 'member', subjectId: id, outcome: 'ok' });
    if (input.active === false && !before.disabled) return this.offboard(tx, actor, before, 'deactivated');
    if (input.active === true && before.disabled && before.scim_disabled) {
      // Re-enabled, nothing more: tokens, agents and devices revoked at offboarding stay revoked.
      await tx.query(`UPDATE members SET disabled = false, scim_disabled = false WHERE id = $1`, [id]);
      await audit(tx, { actorId: actor.tokenId, action: 'scim.member_reactivated', subjectType: 'member', subjectId: id, outcome: 'ok' });
    }
    return [];
  }

  /**
   * Offboarding: the account is disabled (history and audit kept) and everything that acts for the person
   * stops at once: portal sessions, phones and chats, the API token, MCP tokens and agents. Admins are told,
   * so someone takes over what the person owned. Returns the runs to cancel once this commits.
   */
  private async offboard(tx: Tx, actor: ScimActor, m: UserRow, why: 'deactivated' | 'deleted'): Promise<string[]> {
    if (m.role === 'admin') {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM members WHERE role = 'admin' AND NOT disabled AND id <> $1`, [m.id]);
      if (Number(rows[0]!.n) === 0) throw lastAdmin(m.id, `scim.member_${why === 'deleted' ? 'delete' : 'deactivate'}_refused`);
    }
    const had = (await tx.query<{ token: boolean }>(`SELECT token_hash IS NOT NULL AS token FROM members WHERE id = $1`, [m.id])).rows[0]!.token;
    await tx.query(`UPDATE members SET disabled = true, scim_disabled = true, token_hash = NULL, scim_updated_at = now() WHERE id = $1`, [m.id]);
    // A DELETE is audited as scim.member_deleted by its caller.
    if (why === 'deactivated') await audit(tx, { actorId: actor.tokenId, action: 'scim.member_deactivated', subjectType: 'member', subjectId: m.id, outcome: 'ok' });
    const sessions = await tx.query(`DELETE FROM sessions WHERE member_id = $1`, [m.id]);
    if (sessions.rowCount) await audit(tx, { actorId: actor.tokenId, action: 'scim.sessions_revoked', subjectType: 'member', subjectId: m.id, outcome: 'ok' });
    await tx.query(`DELETE FROM device_pairings WHERE member_id = $1`, [m.id]);
    const devices = await tx.query<{ id: string }>(`UPDATE devices SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL RETURNING id`, [m.id]);
    for (const d of devices.rows) await audit(tx, { actorId: actor.tokenId, action: 'device.revoked', subjectType: 'device', subjectId: d.id, outcome: 'ok', relatedId: m.id });
    if (had) await audit(tx, { actorId: actor.tokenId, action: 'member.token_revoked', subjectType: 'member', subjectId: m.id, outcome: 'ok' });
    for (const agentId of await revokeAgentsOf(tx, m.id)) {
      await audit(tx, { actorId: actor.tokenId, action: 'mcp.token_revoked', subjectType: 'member', subjectId: m.id, outcome: 'ok', relatedId: agentId });
    }
    // Pending delegations they asked for or were asked to run: cancelled, the other person told.
    await this.d.cancelDelegations(tx, m.id, actor.tokenId);
    // Admins are told; the Provisioning page lists what the person owned and the delegations cancelled (notifications hold IDs only).
    const admins = await tx.query<{ id: string }>(`SELECT id FROM members WHERE role = 'admin' AND NOT disabled AND id <> $1`, [m.id]);
    for (const a of admins.rows) await notify(tx, a.id, 'member_offboarded');
    const runs = await tx.query<{ id: string }>(
      `SELECT id FROM runs WHERE run_as = $1 AND status IN ('running', 'waiting', 'paused') ORDER BY parent_run_id IS NOT NULL, created_at`,
      [m.id],
    );
    return runs.rows.map((r) => r.id);
  }

  /** Cancel an offboarded person's unfinished runs through the engine, which audits each one. */
  async cancelRuns(actor: ScimActor, runIds: string[]): Promise<void> {
    const as: Member = { id: actor.tokenId, handle: 'scim', role: 'admin' };
    for (const id of runIds) {
      await this.d.cancelRun(id, as).catch((err: unknown) => {
        // A child run its Super Flow already cancelled has finished; anything else is logged.
        if (!(err instanceof AppError && err.code === 'run_finished')) log.warn('scim_cancel_failed', { runId: id, errorType: err instanceof AppError ? err.code : 'internal' });
      });
    }
  }

  // ------------------------------------------------------------ Groups

  async listGroups(q: { filter?: string; startIndex?: unknown; count?: unknown; excludedAttributes?: string }) {
    const params: unknown[] = [];
    const where = `true${groupWhere(parseFilter(q.filter), params)}`;
    const { offset, limit } = paging(q.startIndex, q.count);
    const total = Number((await this.d.db.query<{ n: string }>(`SELECT count(*) AS n FROM scim_groups g WHERE ${where}`, params)).rows[0]!.n);
    const { rows } = limit
      ? await this.d.db.query<GroupRow>(`SELECT g.* FROM scim_groups g WHERE ${where} ORDER BY g.created_at, g.id OFFSET ${offset} LIMIT ${limit}`, params)
      : { rows: [] as GroupRow[] };
    const members = excluded(q.excludedAttributes, 'members') ? null : await this.membersOf(this.d.db, rows.map((g) => g.id));
    return this.list(rows.map((g) => this.groupResource(g, members ? members.get(g.id)! : null)), total, offset);
  }

  async getGroup(id: string, opts: { excludedAttributes?: string } = {}, db: Queryable = this.d.db) {
    const g = await this.groupRow(db, id);
    return this.groupResource(g, excluded(opts.excludedAttributes, 'members') ? null : (await this.membersOf(db, [id])).get(id)!);
  }

  private async groupRow(db: Queryable, id: string, lock = false): Promise<GroupRow> {
    if (!UUID.test(id)) throw new ScimError(404, null, 'group_not_found', 'no such Group');
    const g = (await db.query<GroupRow>(`SELECT * FROM scim_groups WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!g) throw new ScimError(404, null, 'group_not_found', 'no such Group');
    return g;
  }

  /** POST /Groups: a new team for the group (named after it), with its members. */
  async createGroup(actor: ScimActor, body: unknown) {
    const { displayName, externalId, members } = readGroup(body);
    return this.write(async (tx) => {
      if ((await tx.query(`SELECT 1 FROM scim_groups WHERE lower(display_name) = lower($1)`, [displayName])).rowCount) throw taken('a Group with this displayName exists');
      const teamId = await this.newTeam(tx, displayName);
      const g = (await tx.query<GroupRow>(`INSERT INTO scim_groups (display_name, external_id, team_id) VALUES ($1, $2, $3) RETURNING *`, [displayName, externalId, teamId])).rows[0]!;
      await audit(tx, { actorId: actor.tokenId, action: 'scim.group_created', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: g.id });
      await this.setMembers(tx, actor, g, members ?? []);
      return this.getGroup(g.id, {}, tx);
    });
  }

  /** PUT /Groups/:id: name and the whole member list. */
  async replaceGroup(actor: ScimActor, id: string, body: unknown) {
    const { displayName, externalId, members } = readGroup(body);
    return this.write(async (tx) => {
      const g = await this.groupRow(tx, id, true);
      await this.rename(tx, actor, g, displayName);
      await tx.query(`UPDATE scim_groups SET external_id = $2, updated_at = now() WHERE id = $1`, [id, externalId]);
      // Okta sends a PUT without members when it only renames a group.
      if (members) await this.setMembers(tx, actor, g, members);
      return this.getGroup(id, {}, tx);
    });
  }

  /**
   * PATCH /Groups/:id. Members are added and removed with path "members" (a list of {value}), or removed
   * one at a time with Entra ID's `members[value eq "<id>"]`; Okta renames with a pathless replace.
   */
  async patchGroup(actor: ScimActor, id: string, body: unknown) {
    const ops = readPatch(body);
    return this.write(async (tx) => {
      const g = await this.groupRow(tx, id, true);
      const touched = new Set<string>();
      const ids = (v: unknown) => memberIds(v);
      const add = async (list: string[]) => {
        for (const m of list) if (await this.addMember(tx, actor, g, m)) touched.add(m);
      };
      const remove = async (list: string[]) => {
        for (const m of list) if (await this.removeMember(tx, actor, g, m)) touched.add(m);
      };
      for (const o of ops) {
        const p = o.path?.toLowerCase().replace(GROUP_SCHEMA.toLowerCase() + ':', '') ?? null;
        const one = o.path ? /^members\[\s*value\s+eq\s+"([^"]*)"\s*\]$/i.exec(o.path) : null;
        if (one) {
          if (o.op === 'remove') await remove([one[1]!]);
          else await add([one[1]!]);
        } else if (p === 'members') {
          if (o.op === 'add') await add(ids(o.value));
          else if (o.op === 'replace') for (const m of await this.setMembers(tx, actor, g, ids(o.value), false)) touched.add(m);
          else if (o.value === undefined || o.value === null) await remove(await this.memberList(tx, g.id));
          else await remove(ids(o.value));
        } else if (p === 'displayname') {
          if (o.op === 'remove') throw new ScimError(400, 'mutability', 'invalid_value', 'displayName cannot be removed');
          await this.rename(tx, actor, g, readDisplayName(o.value));
        } else if (p === 'externalid') {
          await tx.query(`UPDATE scim_groups SET external_id = $2 WHERE id = $1`, [id, o.op === 'remove' ? null : readExternalId(o.value)]);
        } else if (p === null) {
          if (o.op === 'remove') throw new ScimError(400, 'noTarget', 'invalid_value', 'remove needs a path');
          const name = attr(o.value, 'displayName');
          if (name !== undefined) await this.rename(tx, actor, g, readDisplayName(name));
          const ext = attr(o.value, 'externalId');
          if (ext !== undefined) await tx.query(`UPDATE scim_groups SET external_id = $2 WHERE id = $1`, [id, readExternalId(ext)]);
          const mem = attr(o.value, 'members');
          if (mem !== undefined) {
            if (o.op === 'add') await add(ids(mem));
            else for (const m of await this.setMembers(tx, actor, g, ids(mem), false)) touched.add(m);
          }
        }
        // Other attributes of a Group are not kept.
      }
      await tx.query(`UPDATE scim_groups SET updated_at = now() WHERE id = $1`, [id]);
      await this.syncRoles(tx, actor, [...touched]);
      return this.getGroup(id, {}, tx);
    });
  }

  /** DELETE /Groups/:id: its members leave the team (as if removed from the group); the team itself stays. */
  async deleteGroup(actor: ScimActor, id: string): Promise<void> {
    await this.write(async (tx) => {
      const g = await this.groupRow(tx, id, true);
      const members = await this.memberList(tx, id);
      for (const m of members) await this.removeMember(tx, actor, g, m);
      await tx.query(`DELETE FROM scim_groups WHERE id = $1`, [id]);
      await this.syncRoles(tx, actor, members);
      await audit(tx, { actorId: actor.tokenId, action: 'scim.group_deleted', subjectType: 'team', subjectId: g.team_id, outcome: 'ok', relatedId: id });
    });
  }

  private async memberList(tx: Queryable, groupId: string): Promise<string[]> {
    return (await tx.query<{ member_id: string }>(`SELECT member_id FROM scim_group_members WHERE group_id = $1`, [groupId])).rows.map((r) => r.member_id);
  }

  /** Make the group's members exactly these; returns who changed. Roles are synced unless the caller does it. */
  private async setMembers(tx: Tx, actor: ScimActor, g: GroupRow, wanted: string[], sync = true): Promise<string[]> {
    const now = new Set(await this.memberList(tx, g.id));
    const want = new Set(wanted);
    const changed: string[] = [];
    // Additions first, so a group that swaps one admin for another never has none in between.
    for (const m of want) if (!now.has(m) && (await this.addMember(tx, actor, g, m))) changed.push(m);
    for (const m of now) if (!want.has(m) && (await this.removeMember(tx, actor, g, m))) changed.push(m);
    if (sync) await this.syncRoles(tx, actor, changed);
    return changed;
  }

  /** Into the group and its team (as a team member). Unknown Users are skipped and listed as sync errors. */
  private async addMember(tx: Tx, actor: ScimActor, g: GroupRow, memberId: string): Promise<boolean> {
    const known = UUID.test(memberId) && (await tx.query(`SELECT 1 FROM members m WHERE m.id = $1 AND ${VISIBLE}`, [memberId])).rowCount;
    if (!known) {
      await recordScimError(tx, { method: 'PATCH', resource: '/Groups/:id', status: 200, scimType: null, code: 'unknown_member_skipped' });
      return false;
    }
    if ((await tx.query(`SELECT 1 FROM scim_group_members WHERE group_id = $1 AND member_id = $2`, [g.id, memberId])).rowCount) return false;
    const joined = await tx.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [g.team_id, memberId]);
    await tx.query(`INSERT INTO scim_group_members (group_id, member_id, added_team) VALUES ($1, $2, $3)`, [g.id, memberId, !!joined.rowCount]);
    await audit(tx, { actorId: actor.tokenId, action: 'scim.group_member_added', subjectType: 'team', subjectId: g.team_id, outcome: 'ok', relatedId: memberId });
    return true;
  }

  /**
   * Out of the group, and out of its team if SCIM put them there. Someone is never left in no team at all,
   * and a team keeps its last team admin; both are audited.
   */
  private async removeMember(tx: Tx, actor: ScimActor, g: GroupRow, memberId: string): Promise<boolean> {
    const gone = await tx.query<{ added_team: boolean }>(`DELETE FROM scim_group_members WHERE group_id = $1 AND member_id = $2 RETURNING added_team`, [g.id, memberId]);
    if (!gone.rows[0]) return false;
    await audit(tx, { actorId: actor.tokenId, action: 'scim.group_member_removed', subjectType: 'team', subjectId: g.team_id, outcome: 'ok', relatedId: memberId });
    if (gone.rows[0].added_team) await this.leaveTeam(tx, actor, g.team_id, memberId);
    return true;
  }

  private async leaveTeam(tx: Tx, actor: ScimActor, teamId: string, memberId: string): Promise<void> {
    const teams = Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM team_members WHERE member_id = $1`, [memberId])).rows[0]!.n);
    const role = (await tx.query<{ role: string }>(`SELECT role FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, memberId])).rows[0]?.role;
    if (!role) return;
    let kept: string | null = teams <= 1 ? 'only_team' : null;
    if (!kept && role === 'admin') {
      const others = await tx.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND role = 'admin' AND member_id <> $2`, [teamId, memberId]);
      if (!others.rowCount) kept = 'last_team_admin';
    }
    if (kept) {
      await audit(tx, { actorId: actor.tokenId, action: 'scim.team_member_kept', subjectType: 'team', subjectId: teamId, outcome: 'denied', errorType: kept, relatedId: memberId });
      return;
    }
    await tx.query(`DELETE FROM team_members WHERE team_id = $1 AND member_id = $2`, [teamId, memberId]);
    await audit(tx, { actorId: actor.tokenId, action: 'team.member_removed', subjectType: 'team', subjectId: teamId, outcome: 'ok', relatedId: memberId });
  }

  private async rename(tx: Tx, actor: ScimActor, g: GroupRow, displayName: string): Promise<void> {
    if (displayName === g.display_name) return;
    if ((await tx.query(`SELECT 1 FROM scim_groups WHERE lower(display_name) = lower($1) AND id <> $2`, [displayName, g.id])).rowCount) throw taken('a Group with this displayName exists');
    await tx.query(`UPDATE scim_groups SET display_name = $2, updated_at = now() WHERE id = $1`, [g.id, displayName]);
    // Only a team the group made follows its name; a team an admin linked keeps its own.
    if (g.owns_team) await tx.query(`UPDATE teams SET name = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM teams WHERE name = $2)`, [g.team_id, teamName(displayName)]);
    g.display_name = displayName;
    await audit(tx, { actorId: actor.tokenId, action: 'scim.group_renamed', subjectType: 'team', subjectId: g.team_id, outcome: 'ok', relatedId: g.id });
  }

  private async newTeam(tx: Tx, displayName: string): Promise<string> {
    const base = teamName(displayName);
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? base : `${base.slice(0, 54)} (${i})`;
      const r = await tx.query<{ id: string }>(`INSERT INTO teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`, [name]);
      if (r.rows[0]) return r.rows[0].id;
    }
    throw conflict('team_name_taken');
  }

  // ------------------------------------------------------------ roles from groups

  /**
   * A member's role is the higher of the one an admin set by hand and the highest role their SCIM groups
   * grant. When a group stops granting it, they fall back to the hand-set role (kept in manual_role), so a
   * role an admin gave is never stripped. Raises go first, so swapping admins never leaves none.
   */
  async syncRoles(tx: Tx, actor: ScimActor | Member, memberIds: string[]): Promise<void> {
    const targets: { id: string; role: Role; target: Role; base: Role; disabled: boolean }[] = [];
    for (const id of new Set(memberIds)) {
      const r = (
        await tx.query<{ role: Role; manual_role: Role | null; disabled: boolean; granted: Role | null }>(
          `SELECT m.role, m.manual_role, m.disabled,
                  (SELECT g.grants_role FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id
                   WHERE gm.member_id = m.id AND g.grants_role IS NOT NULL ORDER BY g.grants_role = 'admin' DESC LIMIT 1) AS granted
           FROM members m WHERE m.id = $1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!r) continue;
      const base = r.manual_role ?? r.role;
      targets.push({ id, role: r.role, target: higher(base, r.granted ?? 'member'), base, disabled: r.disabled });
    }
    targets.sort((a, b) => ROLE_RANK[b.target] - ROLE_RANK[b.role] - (ROLE_RANK[a.target] - ROLE_RANK[a.role]));
    const actorId = 'tokenId' in actor ? actor.tokenId : actor.id;
    for (const t of targets) {
      if (t.target === t.role) {
        if (t.target === t.base) await tx.query(`UPDATE members SET manual_role = NULL WHERE id = $1 AND manual_role IS NOT NULL`, [t.id]);
        continue;
      }
      if (t.role === 'admin' && !t.disabled) {
        const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM members WHERE role = 'admin' AND NOT disabled AND id <> $1`, [t.id]);
        if (Number(rows[0]!.n) === 0) throw lastAdmin(t.id, 'scim.role_remove_refused');
      }
      await tx.query(`UPDATE members SET role = $2, manual_role = $3 WHERE id = $1`, [t.id, t.target, t.target === t.base ? null : t.base]);
      const raised = ROLE_RANK[t.target] > ROLE_RANK[t.role];
      await audit(tx, { actorId, action: raised ? 'scim.role_granted' : 'scim.role_removed', subjectType: 'member', subjectId: t.id, outcome: 'ok', relatedId: t.target });
    }
  }

  // ------------------------------------------------------------ admin (portal)

  /** Everything the Provisioning (SCIM) settings show. */
  async overview(actor: Member) {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const db = this.d.db;
    const token = (await db.query<{ id: string; created_at: Date; last_used_at: Date | null }>(`SELECT id, created_at, last_used_at FROM scim_tokens WHERE revoked_at IS NULL`)).rows[0] ?? null;
    const groups = await db.query<{ id: string; display_name: string; team_id: string; team: string; owns_team: boolean; grants_role: string | null; members: number }>(
      `SELECT g.id, g.display_name, g.team_id, t.name AS team, g.owns_team, g.grants_role,
              (SELECT count(*)::int FROM scim_group_members gm WHERE gm.group_id = g.id) AS members
       FROM scim_groups g JOIN teams t ON t.id = g.team_id ORDER BY g.display_name`,
    );
    const errors = await db.query(`SELECT at, method, resource, status, scim_type AS "scimType", code FROM scim_errors ORDER BY id DESC LIMIT 20`);
    const users = await db.query<{ n: number; disabled: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE disabled)::int AS disabled FROM members m WHERE ${VISIBLE}`);
    const off = await db.query<{ id: string; handle: string; display_name: string | null; at: Date | null; deleted: boolean }>(
      `SELECT id, handle, display_name, scim_updated_at AS at, scim_deleted_at IS NOT NULL AS deleted FROM members WHERE scim_disabled AND disabled ORDER BY scim_updated_at DESC NULLS LAST LIMIT 50`,
    );
    const offboarded = [];
    for (const m of off.rows) offboarded.push({ id: m.id, handle: m.handle, displayName: m.display_name, at: m.at, deleted: m.deleted, owned: await ownedBy(db, m.id) });
    return {
      baseUrl: this.d.baseUrl,
      token: token ? { id: token.id, createdAt: token.created_at, lastUsedAt: token.last_used_at } : null,
      lastSyncAt: token?.last_used_at ?? null,
      users: users.rows[0],
      groups: groups.rows.map((g) => ({ id: g.id, displayName: g.display_name, teamId: g.team_id, team: g.team, ownsTeam: g.owns_team, grantsRole: g.grants_role, members: g.members })),
      errors: errors.rows,
      offboarded,
    };
  }

  /** An admin links a pushed group to another team, and/or maps it to a role. */
  async configureGroup(actor: Member, groupId: string, change: { teamId?: string | undefined; grantsRole?: 'admin' | 'approver' | null | undefined }): Promise<void> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    await withTx(this.d.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(4245)');
      const g = (await tx.query<GroupRow>(`SELECT * FROM scim_groups WHERE id = $1 FOR UPDATE`, [groupId])).rows[0];
      if (!g) throw notFound('scim_group');
      const members = await this.memberList(tx, g.id);
      if (change.teamId && change.teamId !== g.team_id) {
        if (!(await tx.query(`SELECT 1 FROM teams WHERE id = $1`, [change.teamId])).rowCount) throw notFound('team');
        if ((await tx.query(`SELECT 1 FROM scim_groups WHERE team_id = $1`, [change.teamId])).rowCount) throw conflict('team_already_linked');
        // Members move with the group: into the new team, and out of the old one where SCIM put them.
        const scimActor = { tokenId: actor.id };
        for (const m of members) {
          const added = (await tx.query<{ added_team: boolean }>(`SELECT added_team FROM scim_group_members WHERE group_id = $1 AND member_id = $2`, [g.id, m])).rows[0]!.added_team;
          if (added) await this.leaveTeam(tx, scimActor, g.team_id, m);
          const joined = await tx.query(`INSERT INTO team_members (team_id, member_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [change.teamId, m]);
          await tx.query(`UPDATE scim_group_members SET added_team = $3 WHERE group_id = $1 AND member_id = $2`, [g.id, m, !!joined.rowCount]);
        }
        await tx.query(`UPDATE scim_groups SET team_id = $2, owns_team = false WHERE id = $1`, [g.id, change.teamId]);
        await audit(tx, { actorId: actor.id, action: 'scim.group_linked', subjectType: 'team', subjectId: change.teamId, outcome: 'ok', relatedId: g.id });
      }
      if (change.grantsRole !== undefined && change.grantsRole !== g.grants_role) {
        await tx.query(`UPDATE scim_groups SET grants_role = $2 WHERE id = $1`, [g.id, change.grantsRole]);
        await audit(tx, { actorId: actor.id, action: 'scim.group_role_mapped', subjectType: 'team', subjectId: g.team_id, outcome: 'ok', relatedId: change.grantsRole ?? 'none' });
        await this.syncRoles(tx, actor, members);
      }
    });
  }

  /**
   * An admin links an existing member (who signed up before provisioning) to the identity provider's
   * User, so the provider finds it by userName instead of creating a second account.
   */
  async linkMember(actor: Member, memberId: string, userName: string): Promise<void> {
    if (actor.role !== 'admin') throw forbidden('admin_only');
    const name = readUserName(userName);
    await withTx(this.d.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(4245)');
      if ((await tx.query(`SELECT 1 FROM members WHERE lower(scim_user_name) = lower($1)`, [name])).rowCount) throw conflict('scim_user_name_taken');
      const r = await tx.query(`UPDATE members SET scim_user_name = $2, scim_deleted_at = NULL, scim_updated_at = now() WHERE id = $1 AND scim_user_name IS NULL`, [memberId, name]);
      if (!r.rowCount) throw conflict('member_already_linked_or_missing');
      await audit(tx, { actorId: actor.id, action: 'scim.member_linked', subjectType: 'member', subjectId: memberId, outcome: 'ok' });
    });
  }

  /** Run a SCIM write in a transaction. SCIM writes go one at a time, so the last-admin checks hold. */
  private write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTx(this.d.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(4245)');
      return fn(tx);
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lastAdmin(memberId: string, action: string): ScimError {
  return new ScimError(409, 'mutability', 'last_admin', 'Dittoly keeps at least one enabled admin: make someone else an admin first.', {
    action,
    subjectType: 'member',
    subjectId: memberId,
    errorType: 'last_admin',
  });
}

/** A name in a fixed key order, for comparing. */
function sameName(n: UserInput['name']): string {
  return n ? JSON.stringify([n.givenName ?? null, n.familyName ?? null, n.formatted ?? null]) : 'null';
}

function excluded(list: string | undefined, name: string): boolean {
  return (list ?? '').split(',').some((a) => a.trim().toLowerCase() === name);
}

function readDisplayName(v: unknown): string {
  const t = cleanText(v, 200);
  if (!t) throw invalid('displayName is required');
  return t;
}

/** The ids of a members value: [{ value }], one { value }, or (rarely) plain ids. */
function memberIds(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return list.map((x) => (typeof x === 'string' ? x : attr(x, 'value'))).filter((x): x is string => typeof x === 'string');
}

function readGroup(body: unknown): { displayName: string; externalId: string | null; members: string[] | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('send a Group object', 'invalidSyntax');
  const members = attr(body, 'members');
  return { displayName: readDisplayName(attr(body, 'displayName')), externalId: readExternalId(attr(body, 'externalId')), members: members === undefined ? null : memberIds(members) };
}

/** A team name from a group name: the characters team names allow, at most 60. */
export function teamName(displayName: string): string {
  const name = displayName.replace(/[^\p{L}\p{N} ._&'-]/gu, ' ').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').trim().slice(0, 60).trim();
  return name || 'Identity provider group';
}

/** What an offboarded person owned that runs as them, so someone can take it over. */
export async function ownedBy(db: Queryable, memberId: string) {
  const q = async (sql: string) => (await db.query<{ id: string; name: string }>(sql, [memberId])).rows;
  return {
    flows: await q(`SELECT id, name FROM flows WHERE created_by = $1 ORDER BY name`),
    schedules: await q(`SELECT s.id, f.name || ' (' || s.cron || ')' AS name FROM schedules s JOIN flow_versions v ON v.id = s.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE s.run_as = $1 AND s.enabled`),
    watches: await q(`SELECT id, name FROM watches WHERE run_as = $1 AND enabled`),
    webhooks: await q(`SELECT t.id, f.name FROM triggers t JOIN flow_versions v ON v.id = t.flow_version_id JOIN flows f ON f.id = v.flow_id WHERE t.run_as = $1 AND t.enabled`),
    endpoints: await q(`SELECT id, name FROM flow_endpoints WHERE run_as = $1 AND enabled`),
    followups: await q(`SELECT x.id, f.name FROM flow_followups x JOIN flow_versions v ON v.id = x.target_version_id JOIN flows f ON f.id = v.flow_id WHERE x.run_as = $1 AND x.enabled`),
    /** Pending delegations offboarding cancelled: the action, the Flow, and the other person. */
    delegations: await q(
      `SELECT d.id, d.action || ' in ' || f.name || CASE WHEN d.requester_id = $1 THEN ' (asked of ' || dm.handle || ')' ELSE ' (asked by ' || rm.handle || ')' END AS name
       FROM delegations d JOIN runs r ON r.id = d.run_id JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
       JOIN members rm ON rm.id = d.requester_id JOIN members dm ON dm.id = d.delegate_id
       WHERE d.cancelled_for = $1 ORDER BY d.created_at`,
    ),
  };
}

/** A failed SCIM request, for the admin page: codes only. The newest 100 are kept. */
export async function recordScimError(db: Queryable, e: { method: string; resource: string; status: number; scimType: string | null; code: string }): Promise<void> {
  await db.query(`INSERT INTO scim_errors (method, resource, status, scim_type, code) VALUES ($1, $2, $3, $4, $5)`, [
    e.method.slice(0, 10),
    e.resource.slice(0, 80),
    e.status,
    e.scimType,
    /^[a-z0-9_.:-]{1,80}$/i.test(e.code) ? e.code : 'error',
  ]);
  await db.query(`DELETE FROM scim_errors WHERE id <= (SELECT max(id) - 100 FROM scim_errors)`);
}
