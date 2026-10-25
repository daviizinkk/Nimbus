import sharp from 'sharp';

export interface ThumbnailResult {
  buffer: Buffer;
  width: number;
  height: number;
  originalWidth: number | null;
  originalHeight: number | null;
}

/**
 * Creates a WebP card/lightbox preview. EXIF orientation is applied and the
 * source is never enlarged. Video posters (JPEG/PNG buffers) use the same path.
 */
export async function createThumbnail(input: string | Buffer): Promise<ThumbnailResult> {
  const pipeline = sharp(input, { failOn: 'none', animated: false });
  const metadata = await pipeline.metadata();
  let originalWidth = metadata.width ?? null;
  let originalHeight = metadata.height ?? null;
  if (
    metadata.orientation &&
    metadata.orientation >= 5 &&
    metadata.orientation <= 8 &&
    originalWidth &&
    originalHeight
  ) {
    [originalWidth, originalHeight] = [originalHeight, originalWidth];
  }

  const { data, info } = await pipeline
    .rotate()
    .resize(1120, 1120, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    originalWidth,
    originalHeight,
  };
}

export async function imageMetadata(input: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const metadata = await sharp(input, { failOn: 'none' }).metadata();
    let width = metadata.width ?? null;
    let height = metadata.height ?? null;
    if (metadata.orientation && metadata.orientation >= 5 && metadata.orientation <= 8 && width && height) {
      [width, height] = [height, width];
    }
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}
