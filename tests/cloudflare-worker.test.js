import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1Database } from '../scripts/d1-database.js';
import worker from '../workers/index.js';

test('D1 adapter executes schema statements separately', async () => {
  const statements = [];
  const database = createD1Database({
    prepare(sql) {
      return { run: async () => (statements.push(sql), { success: true }) };
    },
  });

  await database.exec('CREATE TABLE first_table (id TEXT); CREATE TABLE second_table (id TEXT);');

  assert.deepEqual(statements, ['CREATE TABLE first_table (id TEXT)', 'CREATE TABLE second_table (id TEXT)']);
});

test('Cloudflare Worker maps friendly admin route to static HTML', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/admin'), {
    ASSETS: { fetch: (request) => new Response(new URL(request.url).pathname) },
  });

  assert.equal(await response.text(), '/pages/admin.html');
});

test('Cloudflare Worker maps the gallery route to static HTML', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/gallery'), {
    ASSETS: { fetch: (request) => new Response(new URL(request.url).pathname) },
  });

  assert.equal(await response.text(), '/pages/gallery.html');
});

test('Cloudflare Worker reports missing required API configuration', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/api/admin/session'), {});

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'deployment_not_configured');
});