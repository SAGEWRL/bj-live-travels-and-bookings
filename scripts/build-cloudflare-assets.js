import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(root, 'dist');
const browserScripts = [
  'admin.js',
  'booking-form.js',
  'booking.js',
  'gallery.js',
  'home.js',
  'media-slideshow.js',
  'property.js',
  'site.js',
];

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, 'scripts'), { recursive: true });
await cp(resolve(root, 'index.html'), resolve(output, 'index.html'));
await cp(resolve(root, 'pages'), resolve(output, 'pages'), { recursive: true });
await cp(resolve(root, 'styles'), resolve(output, 'styles'), { recursive: true });
await cp(resolve(root, 'images'), resolve(output, 'images'), { recursive: true });
await cp(resolve(root, 'robots.txt'), resolve(output, 'robots.txt'));

for (const script of browserScripts) {
  await cp(resolve(root, 'scripts', script), resolve(output, 'scripts', script));
}

await cp(resolve(root, 'pages/404.html'), resolve(output, '404.html'));
console.log('Cloudflare static assets built in dist/.');