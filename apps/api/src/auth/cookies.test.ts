import { describe, expect, it } from 'vitest';
import { originRequiresSecureCookies } from './cookies.js';

describe('originRequiresSecureCookies', () => {
  it('requires Secure when WEB_ORIGIN is https', () => {
    expect(originRequiresSecureCookies('https://app.example.com')).toBe(true);
  });

  it('does not require Secure over plain http (the compose.yaml one-command deployment baseline)', () => {
    expect(originRequiresSecureCookies('http://localhost:8080')).toBe(false);
  });

  it('defaults to not requiring Secure when WEB_ORIGIN is unset', () => {
    expect(originRequiresSecureCookies(undefined)).toBe(false);
  });
});
