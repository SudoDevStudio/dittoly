import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export { canonicalJson, constantTimeEqual, sha256Hex } from '../runtime/crypto.js';

/**
 * Envelope format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 * The associated data (aad) binds a ciphertext to the row it belongs to, so a
 * value copied into another member's row fails to decrypt.
 *
 * Key custody, rotation and recovery are still an open Step 0 decision; the
 * prototype uses one master key from the environment.
 */
export class Cipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('cipher key must be 32 bytes');
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(envelope: string, aad: string): string {
    if (!envelope.startsWith('v1:')) throw new Error('unknown ciphertext version');
    const raw = Buffer.from(envelope.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T = unknown>(envelope: string, aad: string): T {
    return JSON.parse(this.decrypt(envelope, aad)) as T;
  }

  /**
   * A keyed hash for finding an encrypted value without decrypting everything (e.g. a data
   * table row by its key). It changes with the master key; key rotation recomputes it.
   */
  lookupHash(value: string): string {
    // The label never changes: stored lookup hashes were made with it.
    const sub = createHash('sha256').update(this.key).update(Buffer.from('6d6f64756c6f6f6d2d6c6f6f6b75702d7631', 'hex')).digest();
    return createHmac('sha256', sub).update(value, 'utf8').digest('hex');
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
