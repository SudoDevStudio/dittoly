/**
 * What Dittoly can connect to, by protocol. The AI classifies a request into
 * these ids; whether something is supported, and how, comes from this table
 * and never from the AI.
 */

export type Support =
  /** Modules can do it today. */
  | 'supported'
  /** Partly: see the note. */
  | 'partial'
  /** Not something to choose: handled underneath (transport, encryption, addressing). */
  | 'underlying'
  /** Not possible; the note names the usual alternative. */
  | 'unsupported';

export interface ProtocolInfo {
  id: string;
  label: string;
  category: Category;
  support: Support;
  /** How it is done in Dittoly, or the alternative. */
  note: string;
}

export const CATEGORIES = {
  web_api: 'Web API (HTTPS)',
  streaming: 'Streaming and real time',
  email: 'Email',
  messaging: 'Messaging and queues',
  ai_agents: 'AI agents and tools',
  rpc: 'RPC',
  file_transfer: 'File transfer and storage',
  remote_access: 'Remote access',
  database: 'Databases and directories',
  media: 'Audio, video and peer to peer',
  network: 'Network and transport layers',
} as const;
export type Category = keyof typeof CATEGORIES;

const p = (id: string, label: string, category: Category, support: Support, note: string): ProtocolInfo => ({ id, label, category, support, note });

export const PROTOCOLS: ProtocolInfo[] = [
  // Web APIs: everything that is requests and responses over HTTPS.
  p('rest', 'REST', 'web_api', 'supported', 'HTTPS requests through the broker (ctx.http).'),
  p('graphql', 'GraphQL', 'web_api', 'supported', 'POST requests to the GraphQL endpoint (ctx.http). Subscriptions over WebSocket use ctx.ws.'),
  p('soap', 'SOAP', 'web_api', 'supported', 'XML over HTTPS (ctx.http).'),
  p('json-rpc', 'JSON-RPC', 'web_api', 'supported', 'Over HTTPS (ctx.http).'),
  p('xml-rpc', 'XML-RPC', 'web_api', 'supported', 'Over HTTPS (ctx.http).'),
  p('odata', 'OData', 'web_api', 'supported', 'Over HTTPS (ctx.http).'),
  p('webhook', 'Outgoing webhook', 'web_api', 'supported', 'An HTTPS POST to the receiver (ctx.http). Incoming webhooks start Flows (triggers).'),
  p('webdav', 'WebDAV', 'web_api', 'partial', 'GET, PUT and DELETE work; PROPFIND, MKCOL and LOCK do not.'),
  p('http', 'HTTP', 'web_api', 'partial', 'Plain http only for hosts an admin lists for local development; otherwise HTTPS.'),
  p('https', 'HTTPS', 'web_api', 'supported', 'Every module request (ctx.http).'),
  p('browser', 'Web browser automation (Playwright)', 'web_api', 'supported', 'A headless browser the module drives (ctx.page): website tests, and sites without an API. Pages load only declared hosts.'),
  p('http2', 'HTTP/2', 'network', 'underlying', 'Requests are sent over HTTP/1.1, which HTTP/2 servers also accept.'),
  p('http3', 'HTTP/3', 'network', 'underlying', 'Requests are sent over HTTP/1.1 on TCP, which HTTP/3 servers also accept.'),
  // Streaming
  p('websocket', 'WebSocket', 'streaming', 'supported', 'A bounded session: connect, send, collect replies, close (ctx.ws).'),
  p('wss', 'WSS (WebSocket over TLS)', 'streaming', 'supported', 'ctx.ws with TLS (the default).'),
  p('sse', 'Server-Sent Events', 'streaming', 'supported', 'Read a bounded number of events (ctx.sse).'),
  p('webtransport', 'WebTransport', 'streaming', 'unsupported', 'Use the service\'s WebSocket or HTTPS API if it has one.'),
  // Email
  p('smtp', 'SMTP', 'email', 'supported', 'Send only, through a declared SMTP server with a fixed sender (ctx.smtp).'),
  p('email-api', 'Email provider API (Mailchimp, SendGrid, Resend, Postmark, SES)', 'email', 'supported', 'The provider\'s HTTPS API (ctx.http).'),
  p('imap', 'IMAP', 'email', 'unsupported', 'Reading mailboxes: use the mail provider\'s API (Gmail API, Microsoft Graph).'),
  p('pop3', 'POP3', 'email', 'unsupported', 'Reading mailboxes: use the mail provider\'s API (Gmail API, Microsoft Graph).'),
  // Messaging
  p('amqp', 'AMQP (RabbitMQ)', 'messaging', 'partial', 'Publish to declared exchanges (ctx.amqp). Consuming is not supported; use a webhook or schedule.'),
  p('mqtt', 'MQTT', 'messaging', 'partial', 'Publish to declared topics, QoS 0 or 1 (ctx.mqtt). Subscribing is not supported.'),
  p('kafka', 'Kafka', 'messaging', 'unsupported', 'Use a Kafka REST proxy over HTTPS if one is available.'),
  p('nats', 'NATS', 'messaging', 'unsupported', 'Use an HTTPS bridge if one is available.'),
  p('stomp', 'STOMP', 'messaging', 'unsupported', 'Use the broker\'s HTTPS management API or AMQP.'),
  // AI agents
  p('mcp', 'MCP (Model Context Protocol)', 'ai_agents', 'supported', 'Import the MCP server on the Modules page (remote HTTPS, or a local package in local mode).'),
  p('a2a', 'A2A (Agent2Agent)', 'ai_agents', 'supported', 'JSON-RPC over HTTPS (ctx.http); streamed answers over SSE (ctx.sse).'),
  // RPC
  p('grpc', 'gRPC', 'rpc', 'unsupported', 'Use the service\'s REST/JSON gateway or the Connect protocol over HTTPS, if it offers one.'),
  p('thrift', 'Thrift', 'rpc', 'unsupported', 'Use an HTTPS API if the service has one.'),
  // File transfer
  p('ftp', 'FTP', 'file_transfer', 'unsupported', 'Use the storage service\'s HTTPS API (for example S3, Azure Blob, Google Drive).'),
  p('ftps', 'FTPS', 'file_transfer', 'unsupported', 'Use the storage service\'s HTTPS API.'),
  p('sftp', 'SFTP', 'file_transfer', 'unsupported', 'Use the storage service\'s HTTPS API.'),
  p('scp', 'SCP', 'file_transfer', 'unsupported', 'Use the storage service\'s HTTPS API.'),
  p('smb', 'SMB', 'file_transfer', 'unsupported', 'Use SharePoint/OneDrive (Microsoft Graph) or another HTTPS storage API.'),
  p('nfs', 'NFS', 'file_transfer', 'unsupported', 'Use an HTTPS storage API.'),
  p('s3', 'S3-compatible storage', 'file_transfer', 'partial', 'Pre-signed URLs or a storage gateway over HTTPS (ctx.http). AWS request signing needs the secret key, which modules never see.'),
  // Remote access
  p('ssh', 'SSH', 'remote_access', 'unsupported', 'Use an HTTPS API on the target (for example a CI/CD or automation service).'),
  p('telnet', 'Telnet', 'remote_access', 'unsupported', 'Not supported.'),
  // Databases and directories
  p('sql', 'SQL databases (PostgreSQL, Supabase, MySQL/MariaDB, SQL Server)', 'database', 'supported', 'Fixed, reviewed queries with bound parameters through a database endpoint (ctx.db.query); reads run read-only.'),
  p('firebase', 'Firebase (Cloud Firestore, Realtime Database)', 'database', 'supported', 'HTTPS REST APIs with a Google service account credential: Dittoly keeps the key and sends short-lived, scope-limited tokens.'),
  p('mongodb', 'MongoDB (also Atlas)', 'database', 'supported', 'Fixed, reviewed operations whose values are single typed parameters, through a database endpoint (ctx.db.query).'),
  p('redis', 'Redis', 'database', 'unsupported', 'Use an HTTPS API such as Upstash REST.'),
  p('ldap', 'LDAP', 'database', 'unsupported', 'Use the directory\'s HTTPS API (Microsoft Graph, Okta, Google Admin).'),
  // Media
  p('webrtc', 'WebRTC', 'media', 'unsupported', 'Not supported: use the service\'s HTTPS API.'),
  p('rtsp', 'RTSP', 'media', 'unsupported', 'Not supported.'),
  p('rtp', 'RTP', 'media', 'unsupported', 'Not supported.'),
  p('sip', 'SIP', 'media', 'unsupported', 'Use the telephony provider\'s HTTPS API (for example Twilio).'),
  // Network and transport layers: never a choice for an integration.
  p('tcp', 'TCP', 'network', 'underlying', 'Raw TCP sockets are not available to modules; they use the protocols above.'),
  p('udp', 'UDP', 'network', 'underlying', 'Raw UDP is not available to modules.'),
  p('quic', 'QUIC', 'network', 'underlying', 'Not used; connections run over TCP.'),
  p('ip', 'IP', 'network', 'underlying', 'Handled by the operating system.'),
  p('ipv4', 'IPv4', 'network', 'underlying', 'Handled by the operating system; private and metadata addresses are refused unless an admin allows them.'),
  p('ipv6', 'IPv6', 'network', 'underlying', 'Handled by the operating system; private and link-local addresses are refused.'),
  p('dns', 'DNS', 'network', 'underlying', 'Names are resolved by Dittoly, which checks every address before connecting.'),
  p('dhcp', 'DHCP', 'network', 'underlying', 'Not something an integration uses.'),
  p('icmp', 'ICMP (ping)', 'network', 'underlying', 'Not available to modules.'),
  p('tls', 'TLS', 'network', 'underlying', 'Required for every connection; certificates are verified.'),
  p('ssl', 'SSL', 'network', 'underlying', 'SSL is obsolete; connections use TLS.'),
];

const BY_ID = new Map(PROTOCOLS.map((x) => [x.id, x]));
export const protocolInfo = (id: string): ProtocolInfo | undefined => BY_ID.get(id);

/** The catalog as the AI sees it: ids and labels by category, without support details it could misreport. */
export function catalogForPrompt(): string {
  return (Object.keys(CATEGORIES) as Category[])
    .map((c) => `${c} (${CATEGORIES[c]}): ${PROTOCOLS.filter((x) => x.category === c).map((x) => `${x.id} = ${x.label}`).join('; ')}`)
    .join('\n');
}
