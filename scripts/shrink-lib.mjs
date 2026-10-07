// Shared shrink logic for the trial and the real run.
// Avatars: shortest side 512px (avatars are shown cropped to a circle, so the
// short side is what must stay sharp; many uploads are tall phone photos). Covers: max 1600px wide. Never upscale, keep aspect.
// Format stays the same as the original (the object is overwritten at the same
// path, so its extension and content-type must keep matching):
//   JPEG -> JPEG q85 (mozjpeg, progressive)
//   PNG  -> PNG, palette-quantised at quality 90 (keeps text and transparency crisp)
//   WebP -> WebP q85
// A result is only used when it is at least 10% smaller than the original.
import sharp from 'sharp';

export const LIMITS = { avatar: { width: 512, height: 512, fit: 'outside' }, cover: { width: 1600, fit: 'inside' } };

export async function shrink(buf, kind) {
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  const fmt = meta.format; // 'jpeg' | 'png' | 'webp' | ...
  let p = sharp(buf, { failOn: 'none' }).rotate(); // apply EXIF orientation
  const lim = LIMITS[kind];
  p = p.resize({ width: lim.width, height: lim.height, fit: lim.fit, withoutEnlargement: true });
  if (fmt === 'jpeg') p = p.jpeg({ quality: 85, mozjpeg: true, progressive: true });
  else if (fmt === 'png') p = p.png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 });
  else if (fmt === 'webp') p = p.webp({ quality: 85 });
  else return { skipped: `format ${fmt}`, meta };
  const { data, info } = await p.toBuffer({ resolveWithObject: true });
  const keep = data.length > buf.length * 0.9;
  return { data: keep ? null : data, info, meta, fmt, skipped: keep ? 'not 10% smaller' : null };
}
