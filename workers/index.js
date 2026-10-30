import { createApiHandler } from '../scripts/api.js';
import { createD1Database } from '../scripts/d1-database.js';
import { D1_SCHEMA } from '../scripts/postgres-schema.js';

let schemaReady;
let apiHandler;

function nodeResponse() {
  let status = 200;
  const headers = new Headers();
  return {
    response: null,
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      for (const [key, value] of Object.entries(nextHeaders)) headers.set(key, value);
      return this;
    },
    end(body) {
      const responseBody = status === 204 || status === 304 ? null : body ?? null;
      this.response = new Response(responseBody, { status, headers });
      return this;
    },
  };
}

function nodeRequest(request, url, body) {
  return {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    url: `${url.pathname}${url.search}`,
    body,
    socket: { remoteAddress: request.headers.get('cf-connecting-ip') || 'unknown' },
  };
}

function assetUrl(url) {
  if (url.pathname === '/admin') return '/pages/admin.html';
  if (url.pathname === '/booking') return '/pages/booking.html';
  if (url.pathname === '/contact') return '/pages/contact.html';
  if (/^\/properties\/[a-z0-9-]+$/i.test(url.pathname)) return '/pages/property.html';
  return null;
}

async function servePhoto(request, env, url) {
  const fileName = url.pathname.slice('/uploads/properties/'.length);
  if (!/^[0-9a-f-]+\.(?:jpg|png|webp)$/i.test(fileName)) return new Response('Not found', { status: 404 });
  const photo = await env.PROPERTY_PHOTOS.get(fileName);
  if (!photo) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  photo.writeHttpMetadata(headers);
  headers.set('etag', photo.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(request.method === 'HEAD' ? null : photo.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/uploads/properties/') && ['GET', 'HEAD'].includes(request.method)) {
      return servePhoto(request, env, url);
    }

    if (!url.pathname.startsWith('/api/')) {
      const mappedPath = assetUrl(url);
      if (mappedPath) {
        url.pathname = mappedPath;
        return env.ASSETS.fetch(new Request(url, request));
      }
      return env.ASSETS.fetch(request);
    }

    const missing = [
      !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 14 ? 'ADMIN_PASSWORD' : null,
      !env.BOOKING_ACCESS_SECRET || env.BOOKING_ACCESS_SECRET.length < 32 ? 'BOOKING_ACCESS_SECRET' : null,
      !env.DB && 'D1 database binding',
      !env.PROPERTY_PHOTOS && 'R2 bucket binding',
    ].filter(Boolean);
    if (missing.length) {
      return Response.json({
        error: { code: 'deployment_not_configured', message: `Configure ${missing.join(', ')} for this deployment.` },
      }, { status: 503 });
    }

    try {
      const database = createD1Database(env.DB);
      schemaReady ??= database.exec(D1_SCHEMA).catch((error) => {
        schemaReady = undefined;
        throw error;
      });
      await schemaReady;
      const environment = { ...env, NODE_ENV: 'production' };
      apiHandler ??= createApiHandler({
        database,
        environment,
        uploadDirectory: '/unused',
        photoStorage: {
          async put(fileName, bytes, contentType) {
            await env.PROPERTY_PHOTOS.put(fileName, bytes, { httpMetadata: { contentType } });
            return `/uploads/properties/${fileName}`;
          },
          async delete(photo) {
            const fileName = photo.split('/').pop();
            await env.PROPERTY_PHOTOS.delete(fileName);
          },
        },
      });

      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : Buffer.from(await request.arrayBuffer());
      const response = nodeResponse();
      await apiHandler(nodeRequest(request, url, body), response, url);
      return response.response || Response.json({ error: { code: 'empty_response', message: 'The request could not be completed.' } }, { status: 500 });
    } catch (error) {
      console.error('Cloudflare Worker request failed:', error);
      return Response.json({ error: { code: 'service_unavailable', message: 'The service is not configured or temporarily unavailable.' } }, { status: 503 });
    }
  },
};