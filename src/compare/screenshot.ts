import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface ScreenshotDiff {
  status: 'PASS' | 'FAIL' | 'WARNING';
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  sizeMismatch?: { reference: [number, number]; actual: [number, number] };
  // Bounding box of differing pixels, so the model only needs to look at this region if at all.
  diffBox?: { x: number; y: number; width: number; height: number };
  diffImage?: string;
}

function crop(png: PNG, w: number, h: number): Buffer {
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) png.data.copy(out, y * w * 4, y * png.width * 4, (y * png.width + w) * 4);
  return out;
}

/**
 * Pixel diff on the overlapping area. Size mismatch is reported separately and caps the result at WARNING.
 * threshold: per-pixel color sensitivity (pixelmatch, 0-1). maxDiffRatio: allowed share of differing pixels.
 */
export async function compareImages(opts: {
  reference: string | Buffer;
  actual: string | Buffer;
  threshold: number;
  maxDiffRatio: number;
  diffOutput?: string;
}): Promise<ScreenshotDiff> {
  const load = async (x: string | Buffer) => PNG.sync.read(typeof x === 'string' ? await readFile(x) : x);
  const [ref, act] = await Promise.all([load(opts.reference), load(opts.actual)]);
  const w = Math.min(ref.width, act.width);
  const h = Math.min(ref.height, act.height);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(crop(ref, w, h), crop(act, w, h), diff.data, w, h, {
    threshold: opts.threshold,
    includeAA: false,
  });

  // pixelmatch paints differing pixels red (255,0,0); scan for their bounds.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  if (diffPixels) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
  }

  const totalPixels = Math.max(ref.width, act.width) * Math.max(ref.height, act.height);
  // Area outside the overlap counts as different.
  const outside = totalPixels - w * h;
  const diffRatio = Math.round(((diffPixels + outside) / totalPixels) * 10000) / 10000;
  const sizeDiffers = ref.width !== act.width || ref.height !== act.height;

  const result: ScreenshotDiff = {
    status: diffRatio <= opts.maxDiffRatio ? (sizeDiffers ? 'WARNING' : 'PASS') : 'FAIL',
    diffPixels,
    totalPixels,
    diffRatio,
  };
  if (sizeDiffers) result.sizeMismatch = { reference: [ref.width, ref.height], actual: [act.width, act.height] };
  if (maxX >= 0) result.diffBox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  if (opts.diffOutput && diffPixels) {
    await mkdir(dirname(opts.diffOutput), { recursive: true });
    await writeFile(opts.diffOutput, PNG.sync.write(diff));
    result.diffImage = opts.diffOutput;
  }
  return result;
}
