import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiHandler } from '../scripts/api.js';
import { createDatabase, migrateLatest, openDatabase, rollbackLastMigration } from '../scripts/database.js';

const adminPassword = 'Test-only-admin-password-728!';
const database = createDatabase(':memory:');
const uploadDirectory = mkdtempSync(join(tmpdir(), 'bjlive-api-test-'));
const api = createApiHandler({ database, environment: { ADMIN_PASSWORD: adminPassword }, uploadDirectory });
const server = createServer((request, response) => {
  void api(request, response, new URL(request.url, `http://${request.headers.host}`));
});
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(uploadDirectory, { recursive: true, force: true });
});

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('health and public catalogue return the exact owner-provided values with no listings', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', database: 'connected' });

  const catalog = await request('/api/packages');
  const { packages } = await catalog.json();
  assert.equal(packages.length, 5);
  assert.deepEqual(packages.map((item) => [item.startingPriceKes, item.minimumPriceKes, item.maximumPriceKes]), [
    [2000, 2000, 4000],
    [2500, 2500, 5000],
    [3000, 3000, 5000],
    [4000, 4000, 5000],
    [8000, 8000, 10000],
  ]);

  const properties = await request('/api/properties?location=Mombasa');
  assert.deepEqual((await properties.json()).properties, []);
});

test('booking estimates dates, stays pending and safely returns the first request for a repeated key', async () => {
  const body = {
    location: 'Mombasa',
    accommodationType: 'Single room',
    checkIn: '2027-02-10',
    checkOut: '2027-02-13',
    guests: 2,
    customerName: 'Test Guest',
    customerPhone: '+254700000001',
  };
  const headers = { 'Idempotency-Key': 'test-request-001' };
  const first = await request('/api/bookings', { method: 'POST', body, headers });
  const firstResult = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstResult.booking.durationDays, 3);
  assert.equal(firstResult.booking.estimatedMinimumKes, 6000);
  assert.equal(firstResult.booking.estimatedMaximumKes, 12000);
  assert.equal(firstResult.booking.status, 'pending');
  const bookingCookie = first.headers.get('set-cookie').split(';')[0];

  const privateStatus = await request(`/api/bookings/${firstResult.booking.reference}`, { headers: { Cookie: bookingCookie } });
  assert.equal(privateStatus.status, 200);
  assert.equal((await privateStatus.json()).booking.customerPhone, '+254700000001');
  const publicStatus = await request(`/api/bookings/${firstResult.booking.reference}`);
  assert.equal(publicStatus.status, 404);

  const duplicate = await request('/api/bookings', { method: 'POST', body, headers });
  const duplicateResult = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateResult.duplicate, true);
  assert.equal(duplicate.headers.get('set-cookie').split(';')[0], bookingCookie);
  assert.equal(duplicateResult.booking.id, firstResult.booking.id);
  assert.equal(database.prepare('SELECT count(*) AS count FROM booking_requests').get().count, 1);
});

test('booking rejects invalid date ranges and unsupported locations', async () => {
  const response = await request('/api/bookings', {
    method: 'POST',
    body: {
      location: 'Nairobi',
      accommodationType: 'Single room',
      checkIn: '2027-02-12',
      checkOut: '2027-02-12',
      guests: 1,
      customerName: 'Test Guest',
      customerPhone: '+254700000001',
    },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_location');
});

test('an administrator must confirm a guest-agreed amount within the estimate before confirming a request', async () => {
  const submitted = await request('/api/bookings', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'confirmed-total-test' },
    body: {
      location: 'Mombasa',
      accommodationType: 'Single room',
      checkIn: '2027-05-10',
      checkOut: '2027-05-12',
      guests: 1,
      customerName: 'Confirmed Guest',
      customerPhone: '+254700000002',
    },
  });
  const { booking } = await submitted.json();
  const adminLogin = await request('/api/admin/login', {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: { password: adminPassword },
  });
  const adminHeaders = { Cookie: adminLogin.headers.get('set-cookie').split(';')[0], Origin: baseUrl };
  const propertyResponse = await request('/api/admin/properties', {
    method: 'POST',
    headers: adminHeaders,
    body: {
      name: 'Confirmed booking test property',
      location: 'Mombasa',
      accommodationType: 'Single room',
      dailyPriceKes: 2500,
      guestCapacity: 2,
      availabilityStatus: 'available',
      priceConfirmed: true,
      published: true,
    },
  });
  const property = (await propertyResponse.json()).property;

  const noAmount = await request(`/api/admin/bookings/${booking.id}`, {
    method: 'PATCH', headers: adminHeaders, body: { status: 'confirmed' },
  });
  assert.equal(noAmount.status, 400);
  assert.equal((await noAmount.json()).error.code, 'confirmed_total_required');

  const outOfRange = await request(`/api/admin/bookings/${booking.id}`, {
    method: 'PATCH', headers: adminHeaders, body: { status: 'confirmed', confirmedAmountKes: 15000 },
  });
  assert.equal(outOfRange.status, 400);
  assert.equal((await outOfRange.json()).error.code, 'invalid_confirmed_amount');

  const confirmed = await request(`/api/admin/bookings/${booking.id}`, {
    method: 'PATCH', headers: adminHeaders, body: { status: 'confirmed', propertyId: property.id, confirmedAmountKes: 5000 },
  });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).booking.confirmedAmountKes, 5000);

  const customerStatus = await request(`/api/bookings/${booking.reference}`, {
    headers: { Cookie: submitted.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal((await customerStatus.json()).booking.status, 'confirmed');

  const declined = await request(`/api/admin/bookings/${booking.id}`, {
    method: 'PATCH', headers: adminHeaders, body: { status: 'declined', propertyId: property.id },
  });
  assert.equal(declined.status, 200);
  const declinedStatus = await request(`/api/bookings/${booking.reference}`, {
    headers: { Cookie: submitted.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal((await declinedStatus.json()).booking.status, 'declined');
});

test('property changes require an admin session and published listings are searchable', async () => {
  const unauthorized = await request('/api/admin/properties');
  assert.equal(unauthorized.status, 401);

  const login = await request('/api/admin/login', {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: { password: adminPassword },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const adminHeaders = { Cookie: cookie, Origin: baseUrl };

  const created = await request('/api/admin/properties', {
    method: 'POST',
    headers: adminHeaders,
    body: {
      name: 'Test listing',
      location: 'Diani',
      accommodationType: 'Double room',
      dailyPriceKes: 3200,
      guestCapacity: 2,
      description: 'Temporary API test record.',
      amenities: [],
      published: false,
    },
  });
  assert.equal(created.status, 201);
  const property = (await created.json()).property;

  const unpublishedSearch = await request('/api/properties?location=Diani');
  assert.deepEqual((await unpublishedSearch.json()).properties, []);

  const updated = await request(`/api/admin/properties/${property.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: { published: true, priceConfirmed: true, availabilityStatus: 'unconfirmed' },
  });
  assert.equal(updated.status, 200);

  const publishedSearch = await request('/api/properties?location=Diani&type=Double%20room&guests=2');
  const results = (await publishedSearch.json()).properties;
  assert.equal(results.length, 1);
  assert.equal(results[0].dailyPriceKes, 3200);
  assert.equal(results[0].priceConfirmed, true);

  const detail = await request(`/api/properties/${property.slug}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).property.id, property.id);

  const priceReview = await request(`/api/admin/properties/${property.id}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: { priceConfirmed: false },
  });
  assert.equal(priceReview.status, 200);
  const publicPrice = await request(`/api/properties/${property.slug}`);
  const publicProperty = (await publicPrice.json()).property;
  assert.equal(publicProperty.dailyPriceKes, null);
  assert.deepEqual(publicProperty.priceRange, { minimumPriceKes: 2500, maximumPriceKes: 5000, unit: 'per day' });

  const block = await request(`/api/admin/properties/${property.id}/availability`, {
    method: 'POST',
    headers: adminHeaders,
    body: { startsOn: '2027-02-10', endsOn: '2027-02-12', reason: 'maintenance' },
  });
  assert.equal(block.status, 201);
  const filtered = await request('/api/properties?location=Diani&checkIn=2027-02-10&checkOut=2027-02-11');
  assert.deepEqual((await filtered.json()).properties, []);

  const blockedBooking = await request('/api/bookings', {
    method: 'POST',
    body: {
      propertyId: property.id,
      location: 'Diani',
      accommodationType: 'Double room',
      checkIn: '2027-02-10',
      checkOut: '2027-02-11',
      guests: 2,
      customerName: 'Test Guest',
      customerPhone: '+254700000001',
    },
  });
  assert.equal(blockedBooking.status, 409);
  assert.equal((await blockedBooking.json()).error.code, 'dates_blocked');

  const photoBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const upload = await request(`/api/admin/properties/${property.id}/photos`, {
    method: 'POST',
    headers: adminHeaders,
    body: { contentType: 'image/png', data: photoBytes.toString('base64') },
  });
  assert.equal(upload.status, 201);
  const photos = (await upload.json()).photos;
  assert.equal(photos.length, 1);
  assert.equal(existsSync(join(uploadDirectory, photos[0].split('/').pop())), true);

  const rawUpload = await fetch(`${baseUrl}/api/admin/properties/${property.id}/photos`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'image/png' },
    body: photoBytes,
  });
  assert.equal(rawUpload.status, 201);
  const rawPhotos = (await rawUpload.json()).photos;
  assert.equal(rawPhotos.length, 2);
  assert.equal(existsSync(join(uploadDirectory, rawPhotos[1].split('/').pop())), true);
});

test('property media uploads accept image and video files and are exposed on the public property record', async () => {
  const login = await request('/api/admin/login', {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: { password: adminPassword },
  });
  const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: baseUrl };

  const propertyResponse = await request('/api/admin/properties', {
    method: 'POST',
    headers: adminHeaders,
    body: {
      name: 'Gallery media test property',
      location: 'Mombasa',
      accommodationType: 'Single room',
      dailyPriceKes: 2800,
      guestCapacity: 2,
      availabilityStatus: 'available',
      priceConfirmed: true,
      published: true,
    },
  });
  const property = (await propertyResponse.json()).property;

  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const video = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00]);

  const imageUpload = await request(`/api/admin/properties/${property.id}/photos`, {
    method: 'POST',
    headers: adminHeaders,
    body: { contentType: 'image/png', data: image.toString('base64') },
  });
  assert.equal(imageUpload.status, 201);
  assert.equal((await imageUpload.json()).photos.length, 1);

  const videoUpload = await request(`/api/admin/properties/${property.id}/photos`, {
    method: 'POST',
    headers: adminHeaders,
    body: { contentType: 'video/webm', data: video.toString('base64') },
  });
  assert.equal(videoUpload.status, 201);
  const media = (await videoUpload.json()).photos;
  assert.equal(media.length, 2);
  assert.ok(media.every((url) => typeof url === 'string' && url.length > 0));

  const publicProperty = await request(`/api/properties/${property.slug}`);
  const publicPayload = await publicProperty.json();
  assert.equal(publicPayload.property.photos.length, 2);
  assert.ok(publicPayload.property.photos.some((url) => url.includes('.png') || url.includes('.jpg') || url.includes('.webp')));
  assert.ok(publicPayload.property.photos.some((url) => url.includes('.webm') || url.includes('.mp4')));
});

test('M-Pesa stays disabled until the merchant configuration exists', async () => {
  const response = await request('/api/payments/mpesa', { method: 'POST', headers: { Origin: baseUrl }, body: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'mpesa_not_configured');
  assert.equal(database.prepare('SELECT count(*) AS count FROM payment_attempts').get().count, 0);
});

test('schema migrations apply and roll back without adding records', () => {
  const migrationDatabase = openDatabase(':memory:');
  migrateLatest(migrationDatabase);
  assert.equal(migrationDatabase.prepare('SELECT count(*) AS count FROM properties').get().count, 0);
  assert.equal(migrationDatabase.prepare('SELECT count(*) AS count FROM booking_requests').get().count, 0);
  assert.equal(rollbackLastMigration(migrationDatabase), '006_admin_login_attempts');
  assert.equal(rollbackLastMigration(migrationDatabase), '005_admin_sessions');
  assert.equal(rollbackLastMigration(migrationDatabase), '004_booking_access_tokens');
  assert.equal(rollbackLastMigration(migrationDatabase), '003_confirmed_booking_total');
  assert.equal(rollbackLastMigration(migrationDatabase), '002_payment_idempotency');
  assert.equal(rollbackLastMigration(migrationDatabase), '001_initial');
  assert.equal(migrationDatabase.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 0);
  migrateLatest(migrationDatabase);
  migrationDatabase.close();
});