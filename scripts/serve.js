import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './api.js';
import { createDatabase } from './database.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const routes = new Map([
  ['/', 'index.html'],
  ['/booking', 'pages/booking.html'],
  ['/contact', 'pages/contact.html'],
  ['/gallery', 'pages/gallery.html'],
  ['/admin', 'pages/admin.html'],
]);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);
const publicRoots = new Set(['pages', 'scripts', 'styles', 'images']);
const database = createDatabase();
const handleApi = createApiHandler({
  database,
  environment: process.env,
  uploadDirectory: resolve(projectRoot, 'storage/property-images'),
});

export function resolveRequestPath(requestPath) {
  const pathname = decodeURIComponent(requestPath.split('?')[0]);
  const propertyPage = pathname.match(/^\/properties\/[a-z0-9-]+$/i);
  if (propertyPage) return resolve(projectRoot, 'pages/property.html');

  const routeFile = routes.get(pathname.replace(/\/$/, '') || '/');
  const relativePath = routeFile ?? pathname.replace(/^\/+/, '');
  const filePath = resolve(projectRoot, relativePath);
  const publicRoot = relative(projectRoot, filePath).split(sep)[0];
  if (['index.html', 'robots.txt', 'sitemap.xml'].includes(relative(projectRoot, filePath))) return filePath;
  return publicRoots.has(publicRoot) && filePath.startsWith(`${projectRoot}${sep}`) ? filePath : null;
}

const server = createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (await handleApi(request, response, url)) return;

  if (url.pathname === '/sitemap.xml' && ['GET', 'HEAD'].includes(request.method)) {
    const baseUrl = process.env.PUBLIC_SITE_URL || `http://${request.headers.host || 'localhost:4173'}`;
    let origin;
    try {
      const configuredUrl = new URL(baseUrl);
      if (!['http:', 'https:'].includes(configuredUrl.protocol) || configuredUrl.username || configuredUrl.password) throw new Error('Invalid public site URL');
      origin = configuredUrl.origin;
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('PUBLIC_SITE_URL must be a valid http or https origin.');
      return;
    }
    const properties = database.prepare('SELECT slug FROM properties WHERE is_published = 1 ORDER BY slug').all();
    const locations = ['/', '/booking', '/contact', ...properties.map((property) => `/properties/${encodeURIComponent(property.slug)}`)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((path) => `<url><loc>${origin}${path.replaceAll('&', '&amp;')}</loc></url>`).join('')}</urlset>`;
    response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    response.end(request.method === 'HEAD' ? undefined : xml);
    return;
  }

  const uploadMatch = url.pathname.match(/^\/uploads\/properties\/([0-9a-f-]+\.(?:jpg|png|webp))$/i);
  const uploadPath = uploadMatch ? resolve(projectRoot, 'storage/property-images', uploadMatch[1]) : null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let filePath;
  try {
    filePath = uploadPath || resolveRequestPath(url.pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    const notFoundPath = resolve(projectRoot, 'pages/404.html');
    if (existsSync(notFoundPath)) {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(notFoundPath).pipe(response);
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cache-Control': url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/images/') ? 'public, max-age=86400' : 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, '0.0.0.0', () => {
  console.log(`Marevia ready at http://localhost:${port}/`);
});

function closeServer() {
  server.close(() => database.close());
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);