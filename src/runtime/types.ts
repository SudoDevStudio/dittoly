/**
 * The shapes the runtime works with: a module's manifest (what the module may do, as reviewed)
 * and the parts of a Flow it carries out itself. Plain types, so the runtime needs no schema library.
 */

export type CredentialPlacement =
  | { type: 'bearer' }
  | { type: 'header'; name: string; prefix: string }
  | { type: 'basic' }
  | { type: 'google_service_account'; scopes: string[] }
  | { type: 'env'; name: string };

export interface ManifestCredential {
  id: string;
  service: string;
  label: string;
  /** The credential is attached only to requests for these hosts. */
  hosts: string[];
  placement: CredentialPlacement;
  optional?: boolean | undefined;
  scopes?: string[] | undefined;
}

/** help and example: what the setting is, shown to the admin behind an "i" next to it. */
type SettingHelp = { help?: string | undefined; example?: string | undefined };
export type ManifestSetting =
  | ({ id: string; type: 'host'; label: string; pattern: string; default: string } & SettingHelp)
  | ({ id: string; type: 'text'; label: string; default?: string | undefined } & SettingHelp)
  | ({ id: string; type: 'certificate'; label: string } & SettingHelp);

export interface ManifestAction {
  name: string;
  title: string;
  description: string;
  /** 'write' actions change data in the target app; they are never retried when the outcome is uncertain, unless idempotent. */
  effect: 'read' | 'write';
  /** For write actions: a repeat finds what an earlier call made, so a lost answer is retried. */
  idempotent?: boolean | undefined;
  credentials: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  /** For write actions: the action that reverses it, with input built from {{ input.x }} and {{ output.y }}. */
  undo?: { action: string; input: Record<string, unknown> } | undefined;
}

export type SqlParamType = 'string' | 'integer' | 'number' | 'boolean' | 'timestamp';

export interface DbQuery {
  id: string;
  effect: 'read' | 'write';
  sql: string;
  params: Record<string, { type: SqlParamType; nullable?: boolean | undefined }>;
  maxRows: number;
}

export interface MongoOperationDecl {
  id: string;
  effect: 'read' | 'write';
  collection: string;
  op: 'find' | 'findOne' | 'countDocuments' | 'aggregate' | 'insertOne' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
  filter?: Record<string, unknown> | undefined;
  projection?: Record<string, unknown> | undefined;
  sort?: Record<string, unknown> | undefined;
  pipeline?: Record<string, unknown>[] | undefined;
  document?: Record<string, unknown> | undefined;
  update?: Record<string, unknown> | undefined;
  upsert?: boolean | undefined;
  params: Record<string, { type: SqlParamType | 'objectId'; nullable?: boolean | undefined }>;
  maxRows: number;
}

interface EndpointBase {
  id: string;
  host: string;
}
interface DbEndpointOf<P extends 'postgres' | 'mysql' | 'mssql'> extends EndpointBase {
  protocol: P;
  database: string;
  tls: boolean;
  ca?: string | undefined;
  credential: string;
  queries: DbQuery[];
}

/** Connections other than plain HTTPS requests. Each is reviewed and enforced by the broker. */
export type Endpoint =
  | (EndpointBase & { protocol: 'smtp'; tls: 'starttls' | 'implicit' | 'none'; credential?: string | undefined; from: string })
  | (EndpointBase & { protocol: 'amqp'; tls: boolean; vhost: string; exchanges: string[]; credential?: string | undefined })
  | (EndpointBase & { protocol: 'mqtt'; tls: boolean; topics: string[]; credential?: string | undefined })
  | (EndpointBase & { protocol: 'websocket'; tls: boolean; credential?: string | undefined })
  | (EndpointBase & { protocol: 'sse'; tls: boolean; credential?: string | undefined })
  | DbEndpointOf<'postgres'>
  | DbEndpointOf<'mysql'>
  | DbEndpointOf<'mssql'>
  | (EndpointBase & {
      protocol: 'mongodb';
      srv: boolean;
      database: string;
      tls: boolean;
      ca?: string | undefined;
      credential: string;
      authSource: string;
      operations: MongoOperationDecl[];
    });

export interface Manifest {
  name: string;
  version: string;
  title: string;
  description: string;
  hosts: string[];
  settings: ManifestSetting[];
  credentials: ManifestCredential[];
  publicWeb?: 'read' | undefined;
  browser?: { hosts: string[] } | undefined;
  endpoints: Endpoint[];
  actions: ManifestAction[];
}

export type OptionValue = string | number | boolean;

/** Where a select box gets its choices. */
export type OptionsSource =
  | { fixed: { value: OptionValue; label?: string | undefined }[] }
  | { module: string; action: string; input: Record<string, unknown>; items: string; value: string; label?: string | undefined }
  | { fromStep: string; value: string; label?: string | undefined };

export interface FormField {
  /** Run form: the Flow input it fills. Input step: the key in the step's output. */
  name: string;
  label: string;
  help?: string | undefined;
  widget: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'email' | 'url' | 'checklist';
  placeholder?: string | undefined;
  required?: boolean | undefined;
  options?: OptionsSource | undefined;
  default?: string | number | boolean | undefined;
}

/** Whose AI a step uses: the organization's (configured once) or the runner's own key. */
export interface AiChoice {
  ai: 'organization' | 'runner';
  provider?: 'openai' | 'anthropic' | undefined;
}

export interface AiStep extends AiChoice {
  id: string;
  instruction: string;
  output: 'text' | 'checklist' | 'json';
  /** For output "json": the JSON Schema the answer must match (output { data }). */
  schema?: Record<string, unknown> | undefined;
}

export interface ReportStep {
  id: string;
  heading: string;
}

export type ColumnType = 'text' | 'number' | 'boolean' | 'date';
export interface Column {
  name: string;
  type: ColumnType;
}

/** A choice in a select box. */
export interface Choice {
  value: string | number | boolean;
  label: string;
}
