import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redactArgv,
  redactUrl,
  sanitizeForDisk,
  sanitizeObject,
  sanitizeText
} from '../../shared/redaction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const suspicious = /Ã|â€|娴|链|鏈|鐓|锟|�/;

test('package/manifest descriptions are not double-encoded', () => {
  assert.equal(typeof pkg.description, 'string');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(!suspicious.test(pkg.description), `package.json description is mojibake: ${pkg.description}`);
  assert.ok(!suspicious.test(manifest.description), `manifest.json description is mojibake: ${manifest.description}`);
});

test('package and manifest versions match', () => {
  assert.equal(pkg.version, manifest.version);
});

test('URL query values are redacted but path remains visible', () => {
  assert.equal(redactUrl('https://example.com/reset?a=secret&b=other'), 'https://example.com/reset?a=%C2%ABredacted%C2%BB&b=%C2%ABredacted%C2%BB');
  assert.equal(redactUrl('not a url?x=secret'), 'not a url?x=«redacted»');
});

test('sanitizeObject redacts nested secret keys and HAR-style headers', () => {
  const out = sanitizeObject({
    url: 'https://example.com/?access_token=secret',
    nested: { password: 'hunter2', ok: 'visible' },
    header: { name: 'Authorization', value: 'Bearer very-secret-token' },
    list: [{ name: 'Cookie', value: 'session=abc123' }]
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('very-secret-token'));
  assert.ok(!text.includes('abc123'));
  assert.equal(out.nested.ok, 'visible');
});

test('sanitizeText redacts bearer tokens and key-like secrets', () => {
  const clean = sanitizeText('password=hunter2&normal=ok Authorization: Bearer abcdefghijklmnop');
  assert.ok(!clean.includes('hunter2'));
  assert.ok(!clean.includes('abcdefghijklmnop'));
  assert.ok(clean.includes('normal=ok'));
});

test('sanitizeForDisk drops postData and query secrets', () => {
  const out = sanitizeForDisk({
    url: 'https://example.com/?session=secret&q=1',
    postData: '{"password":"hunter2"}',
    headers: { authorization: 'Bearer abc', accept: 'application/json' }
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('Bearer abc'));
  assert.equal(out.headers.accept, 'application/json');
});

test('redactArgv masks sensitive flags and bare URL queries', () => {
  const out = redactArgv([
    'fill', '--ref', '1', '--text', 'hunter2',
    'open', 'https://example.com/?access_token=very-secret&x=1',
    'upload', '--file', 'C:\\secret\\id.pdf'
  ]);
  const text = JSON.stringify(out);
  assert.ok(out.redacted);
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('very-secret'));
  assert.ok(!text.includes('id.pdf'));
  assert.ok(text.includes('--text'));
});
