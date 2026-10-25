import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './utils.js';

export interface ReceivedBinary {
  size: number;
  hash: string;
}

/**
 * Streams an HTTP body to disk while hashing it and enforcing the expected size.
 * `exactSize === null` accepts anything up to `maxBytes` (used for video posters).
 */
export async function receiveBinary(
  stream: NodeJS.ReadableStream,
  destination: string,
  exactSize: number | null,
  maxBytes: number,
): Promise<ReceivedBinary> {
  await mkdir(path.dirname(destination), { recursive: true });
  const hash = createHash('sha256');
  let received = 0;
  const limit = exactSize ?? maxBytes;

  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        callback(new ApiError(413, exactSize === null ? 'The uploaded preview is too large.' : 'The uploaded file is larger than expected.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, inspector, createWriteStream(destination, { mode: 0o600 }));
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }

  if (exactSize !== null && received !== exactSize) {
    await unlink(destination).catch(() => {});
    throw new ApiError(400, `Upload was incomplete (${received} of ${exactSize} bytes).`);
  }

  return { size: received, hash: hash.digest('hex') };
}
