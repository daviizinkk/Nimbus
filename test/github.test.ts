import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GITHUB_CHUNK_BYTES,
  chunkRanges,
  isNimbusReleaseTag,
  planChunkRead,
  releaseTagForShard,
  shouldChunkGithubFile,
} from '../src/server/storage/github.js';

test('GitHub release shards keep the chosen tag for the first release', () => {
  assert.equal(releaseTagForShard('nimbus-storage', 0), 'nimbus-storage');
  assert.equal(releaseTagForShard('nimbus-storage', 1), 'nimbus-storage');
  assert.equal(releaseTagForShard('nimbus-storage', 2), 'nimbus-storage-2');
  assert.equal(releaseTagForShard('nimbus-storage', 17), 'nimbus-storage-17');
});

test('GitHub release shard tags stay within the configured tag limit', () => {
  const base = 'x'.repeat(80);
  const tags = new Set<string>();
  for (let shard = 1; shard <= 1000; shard++) {
    const tag = releaseTagForShard(base, shard);
    assert.ok(tag.length <= 80, `${tag} is ${tag.length} characters`);
    assert.ok(!tags.has(tag), `duplicate shard tag ${tag}`);
    tags.add(tag);
  }
  assert.equal(releaseTagForShard(base, 2), `${'x'.repeat(78)}-2`);
});

test('Nimbus release tags are matched without touching unrelated releases', () => {
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'nimbus-storage'), true);
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'nimbus-storage-2'), true);
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'nimbus-storage-1000'), true);
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'nimbus-storage-old'), false);
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'my-nimbus-storage-2'), false);
  assert.equal(isNimbusReleaseTag('nimbus-storage', 'nimbus-storage-2-extra'), false);
  assert.equal(isNimbusReleaseTag('nimbus.v1+photos', 'nimbus.v1+photos-3'), true);
  assert.equal(isNimbusReleaseTag('nimbus.v1+photos', 'nimbusXv1+photos-3'), false);
  assert.equal(isNimbusReleaseTag('', 'nimbus-storage'), false);
  assert.equal(isNimbusReleaseTag('nimbus-storage', ''), false);
});

test('GitHub files are chunked above 1 GiB', () => {
  assert.equal(GITHUB_CHUNK_BYTES, 1024 * 1024 * 1024);
  assert.equal(shouldChunkGithubFile(0), false);
  assert.equal(shouldChunkGithubFile(GITHUB_CHUNK_BYTES), false);
  assert.equal(shouldChunkGithubFile(GITHUB_CHUNK_BYTES + 1), true);
});

test('chunkRanges covers a file exactly once', () => {
  assert.deepEqual(chunkRanges(0), []);
  assert.deepEqual(chunkRanges(10, 4), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 },
  ]);
  assert.deepEqual(chunkRanges(8, 4), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ]);

  const ranges = chunkRanges(10, 4);
  const rebuilt = ranges.map((range) => range.end - range.start + 1).reduce((sum, size) => sum + size, 0);
  assert.equal(rebuilt, 10);
});

test('planChunkRead stitches ranges across chunk boundaries', () => {
  const parts = [
    { offset: 0, size: 4 },
    { offset: 4, size: 4 },
    { offset: 8, size: 2 },
  ];

  assert.deepEqual(planChunkRead(parts), [
    { part: 0, localStart: 0, localEnd: 3, start: 0, end: 3 },
    { part: 1, localStart: 0, localEnd: 3, start: 4, end: 7 },
    { part: 2, localStart: 0, localEnd: 1, start: 8, end: 9 },
  ]);
  assert.deepEqual(planChunkRead(parts, { start: 3, end: 5 }), [
    { part: 0, localStart: 3, localEnd: 3, start: 3, end: 3 },
    { part: 1, localStart: 0, localEnd: 1, start: 4, end: 5 },
  ]);
  assert.deepEqual(planChunkRead(parts, { start: 9, end: 9 }), [
    { part: 2, localStart: 1, localEnd: 1, start: 9, end: 9 },
  ]);
  assert.deepEqual(planChunkRead(parts, { start: 20, end: 30 }), []);
});
