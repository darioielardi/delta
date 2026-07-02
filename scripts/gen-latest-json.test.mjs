import { describe, expect, it } from 'vitest';
import { buildLatestJson } from './gen-latest-json.mjs';

describe('buildLatestJson', () => {
  it('assembles a darwin-aarch64 manifest', () => {
    const m = buildLatestJson({
      version: '0.12.0',
      signature: 'SIG',
      url: 'https://github.com/darioielardi/delta/releases/download/v0.12.0/Delta.app.tar.gz',
      pubDate: '2026-07-02T00:00:00Z',
      notes: 'See the release page.',
    });
    expect(m.version).toBe('0.12.0');
    expect(m.pub_date).toBe('2026-07-02T00:00:00Z');
    expect(m.notes).toBe('See the release page.');
    expect(m.platforms['darwin-aarch64']).toEqual({
      signature: 'SIG',
      url: 'https://github.com/darioielardi/delta/releases/download/v0.12.0/Delta.app.tar.gz',
    });
  });

  it('defaults notes to empty string', () => {
    const m = buildLatestJson({ version: '1.0.0', signature: 's', url: 'u', pubDate: 'd' });
    expect(m.notes).toBe('');
  });
});
