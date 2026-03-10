import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const carouselSource = path.join(rootDir, '.well-known', 'carousel.json');
const carouselTarget = path.join(distDir, '.well-known', 'carousel.json');
const previewSource = path.join(rootDir, 'preview-carousel.png');
const previewTarget = path.join(distDir, 'preview-carousel.png');

await mkdir(path.dirname(carouselTarget), { recursive: true });
await cp(carouselSource, carouselTarget);
await cp(previewSource, previewTarget);
