/**
 * Prefixes Dittoly used before it took the "dty" ones. Nothing new is issued with them; they are only still accepted,
 * so a sign-in, an MCP token or an app connection made before keeps working, and leftovers are still cleaned up.
 */
export const OLD = 'mlm';
export const OLD_SESSION_COOKIE = `${OLD}_session`;
export const OLD_DEVICE_COOKIE = `${OLD}_device`;
export const OLD_MCP_TOKEN_PREFIX = `${OLD}_mcp_`;
export const OLD_MCP_ACCESS_PREFIX = `${OLD}_oat_`;
export const OLD_MCP_CLIENT_PREFIX = `${OLD}_client_`;
