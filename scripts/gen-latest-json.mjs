#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function buildLatestJson({ version, signature, url, pubDate, notes = '' }) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'darwin-aarch64': { signature, url },
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}

// CLI: node gen-latest-json.mjs --version X --signature-file f.sig --url U --pub-date D [--notes N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  const manifest = buildLatestJson({
    version: a.version,
    signature: readFileSync(a['signature-file'], 'utf8').trim(),
    url: a.url,
    pubDate: a['pub-date'],
    notes: a.notes ?? '',
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
