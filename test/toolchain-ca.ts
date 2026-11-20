import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where these tests run behind a TLS-inspecting proxy (NODE_EXTRA_CA_CERTS names its CA bundle), the
 * toolchains in the containers must trust it too: the bundle (and a Java trust store with it) is copied
 * into the project, untracked, and each toolchain's own CA setting points at it. Without one, nothing.
 */
export async function testCa(repo: string): Promise<Record<string, string>> {
  const bundle = process.env.NODE_EXTRA_CA_CERTS;
  if (!bundle || !(await stat(bundle).catch(() => null))) return {};
  await copyFile(bundle, path.join(repo, '.test-ca.pem'));
  const env: Record<string, string> = {};
  for (const k of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'CARGO_HTTP_CAINFO', 'DENO_CERT', 'BUNDLE_SSL_CA_CERT', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE']) env[k] = '/app/.test-ca.pem';
  const javaStore = '/etc/ssl/certs/java/cacerts';
  if (await stat(javaStore).catch(() => null)) {
    await copyFile(javaStore, path.join(repo, '.test-ca.jks'));
    // JDK_JAVA_OPTIONS: the step's JAVA_TOOL_OPTIONS carries the proxy and stays as it is.
    env.JDK_JAVA_OPTIONS = '-Djavax.net.ssl.trustStore=/app/.test-ca.jks -Djavax.net.ssl.trustStorePassword=changeit';
  }
  return env;
}
