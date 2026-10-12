import { describe, expect, it } from 'vitest';
import { sameOrigin } from '../src/shared/urls';

describe('sameOrigin', () => {
  it("accepts the app's own pages", () => {
    expect(sameOrigin('app://capmac/index.html', 'app://capmac')).toBe(true);
    expect(sameOrigin('app://capmac/assets/index.js?x=1#y', 'app://capmac/index.html')).toBe(true);
  });

  it('accepts the dev server only on its own port', () => {
    expect(sameOrigin('http://127.0.0.1:63043/src/main.tsx', 'http://127.0.0.1:63043/')).toBe(true);
    // Another project's dev server on the same machine.
    expect(sameOrigin('http://127.0.0.1:5173/', 'http://127.0.0.1:63043/')).toBe(false);
    expect(sameOrigin('https://127.0.0.1:63043/', 'http://127.0.0.1:63043/')).toBe(false);
  });

  it('rejects URLs whose origin is opaque (Node reports "null" for all of them)', () => {
    expect(new URL('file:///C:/x').origin).toBe(new URL('app://capmac').origin);
    expect(sameOrigin('file:///C:/Users/me/evil.html', 'app://capmac')).toBe(false);
    expect(sameOrigin('data:text/html,<script>alert(1)</script>', 'app://capmac')).toBe(false);
    expect(sameOrigin('javascript:alert(1)', 'app://capmac')).toBe(false);
    expect(sameOrigin('app://other/index.html', 'app://capmac')).toBe(false);
  });

  it('rejects anything that is not a URL', () => {
    expect(sameOrigin('', 'app://capmac')).toBe(false);
    expect(sameOrigin('not a url', 'app://capmac')).toBe(false);
  });
});
