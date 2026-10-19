import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Include the transformation version in the URL so cached previews remain immutable.
export const PREVIEW_FILENAME = 'preview-600-v1.webp';

export function screenshotHash(image: Uint8Array): string {
  return createHash('sha256').update(image).digest('hex');
}

export function createScreenshotPreview(image: Uint8Array): Promise<Buffer> {
  return sharp(image)
    .resize(600, 600, { fit: 'contain', background: '#ffffff' })
    .webp({ quality: 80 })
    .toBuffer();
}
