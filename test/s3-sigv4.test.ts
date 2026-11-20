import { describe, expect, it } from 'vitest';
import { signV4 } from '../src/watches/s3.js';

/**
 * AWS Signature Version 4, checked against the official test suite
 * (awslabs/aws-c-auth tests/aws-signing-test-suite/v4).
 */
const keys = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const at = new Date('2015-08-30T12:36:00Z');

describe('SigV4', () => {
  it('get-vanilla-query-order-key-case', () => {
    const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' }, keys, 'us-east-1', 'service', at, false);
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    );
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });

  it('post-x-www-form-urlencoded (body signed)', () => {
    const h = signV4(
      { method: 'POST', url: 'https://example.amazonaws.com/', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '13' }, body: 'Param1=value1' },
      keys,
      'us-east-1',
      'service',
      at,
      true,
    );
    expect(h['x-amz-content-sha256']).toBe('9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e');
    expect(h.authorization).toContain('SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date');
    expect(h.authorization).toContain('Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b');
  });
});
