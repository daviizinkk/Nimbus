import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SlidingWindowLimiter,
  contentDisposition,
  escapeLike,
  fileExtension,
  kindForMime,
  parseCookies,
  parseRange,
  prettyBytes,
  resolveMime,
  safeFilename,
  serializeCookie,
  truncate,
} from '../src/server/utils.js';

test('parseRange accepts full, bounded, open and suffix ranges', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=0-1000', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=5-5', 100), { start: 5, end: 5 });
});

test('parseRange rejects unsupported or out-of-bounds ranges', () => {
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=9-4', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=-', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,4-5', 100), 'invalid');
  assert.equal(parseRange('items=0-1', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1', 0), 'invalid');
});

test('safeFilename strips control characters and path separators', () => {
  assert.equal(safeFilename('holiday\u0000photo.jpg'), 'holidayphoto.jpg');
  assert.equal(safeFilename('../../etc/passwd'), '.. .. etc passwd');
  assert.equal(safeFilename(''), 'file');
  assert.equal(safeFilename('   '), 'file');
  assert.equal(safeFilename('x'.repeat(500)).length, 240);
});

test('fileExtension only returns simple lowercase extensions', () => {
  assert.equal(fileExtension('photo.JPG'), '.jpg');
  assert.equal(fileExtension('archive.tar.gz'), '.gz');
  assert.equal(fileExtension('no-extension'), '');
  assert.equal(fileExtension('.hidden'), '');
  assert.equal(fileExtension('trailing.'), '');
  assert.equal(fileExtension('weird.thing!'), '');
});

test('resolveMime prefers a valid supplied type and falls back to the name', () => {
  assert.equal(resolveMime('photo.jpg', 'image/jpeg'), 'image/jpeg');
  assert.equal(resolveMime('notes.txt', 'text/plain; charset=utf-8'), 'text/plain');
  assert.equal(resolveMime('photo.jpg', 'application/octet-stream'), 'image/jpeg');
  assert.equal(resolveMime('photo.jpg', 'not a mime'), 'image/jpeg');
  assert.equal(resolveMime('unknown.zzz'), 'application/octet-stream');
});

test('kindForMime classifies media and files', () => {
  assert.equal(kindForMime('image/png'), 'photo');
  assert.equal(kindForMime('video/mp4'), 'video');
  assert.equal(kindForMime('application/pdf'), 'file');
  assert.equal(kindForMime('audio/mpeg'), 'file');
});

test('contentDisposition produces a safe ascii and utf-8 filename', () => {
  const header = contentDisposition('attachment', 'férias "2026".jpg');
  assert.match(header, /^attachment; filename="f_rias _2026_.jpg"; filename\*=UTF-8''/);
  assert.ok(header.includes(encodeURIComponent('férias "2026".jpg').replace(/%20/g, '%20')));
});

test('cookie helpers round-trip values and set safe defaults', () => {
  const parsed = parseCookies('nimbus_session=abc%20123; theme=dark; malformed');
  assert.deepEqual(parsed, { nimbus_session: 'abc 123', theme: 'dark' });

  const cookie = serializeCookie('nimbus_session', 'a b', { maxAge: 60.9, secure: true });
  assert.equal(cookie, 'nimbus_session=a%20b; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
});

test('escapeLike escapes SQL LIKE wildcards', () => {
  assert.equal(escapeLike('100%_done\\'), '100\\%\\_done\\\\');
});

test('prettyBytes stays readable across magnitudes', () => {
  assert.equal(prettyBytes(0), '0 B');
  assert.equal(prettyBytes(999), '999 B');
  assert.equal(prettyBytes(1024), '1.0 KB');
  assert.equal(prettyBytes(10 * 1024), '10 KB');
  assert.equal(prettyBytes(1024 ** 3 * 1.5), '1.5 GB');
  assert.equal(prettyBytes(-4), '0 B');
});

test('truncate adds an ellipsis only when needed', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello', 5), 'hello');
});

test('SlidingWindowLimiter enforces its budget and resets', async () => {
  const limiter = new SlidingWindowLimiter(2, 25);
  assert.equal(limiter.allow('owner'), true);
  assert.equal(limiter.allow('owner'), true);
  assert.equal(limiter.allow('owner'), false);
  limiter.reset('owner');
  assert.equal(limiter.allow('owner'), true);
  limiter.prune();
  assert.equal(limiter.allow('owner'), true);
  assert.equal(limiter.allow('owner'), false);
  await new Promise((resolve) => setTimeout(resolve, 35));
  limiter.prune();
  assert.equal(limiter.allow('owner'), true);
});
