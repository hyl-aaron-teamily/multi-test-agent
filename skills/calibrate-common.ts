// Shared calibration steps (android-app / android-web / web calibrators): reference images with region
// hashes, and the review queue for elements that could not be found or failed their self-check.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Box, decodePng, dHash, meanGrey, scaleBox } from '../core/image';
import { type Profile, SKILL_DIR } from './profile';

/** Save `buf` as the reference of `page` and hash its regions (boxes in surface coordinates; dpr = image px per surface px). */
export async function saveRef(prof: Profile, page: string, buf: Buffer, regions: Record<string, Box | undefined>, dpr = 1, log: (s: string) => void = () => {}): Promise<void> {
  const img = decodePng(buf);
  const file = join(SKILL_DIR, 'refs', prof.name, `${page}.png`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  const r: Profile['refs'][string] = { image: `refs/${prof.name}/${page}.png`, regions: {}, hashes: {}, greys: {} };
  for (const [k, b] of Object.entries(regions)) {
    if (!b) continue;
    const px = dpr === 1 ? b : scaleBox(b, dpr);
    r.regions[k] = b;
    r.hashes[k] = dHash(img, px);
    r.greys[k] = Math.round(meanGrey(img, px));
  }
  prof.refs[page] = r;
  log(`  ▣ ref ${page} (${Object.keys(r.regions).join(', ') || 'full'})`);
}

/** An element that needs a human look (not found / self-check failed). */
export function queueReview(prof: Profile, element: string, reason: string, image = ''): void {
  prof.reviewQueue.push({ element, image, reason });
}
