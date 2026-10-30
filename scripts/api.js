import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOMMODATION_TYPES, LOCATIONS, getAccommodationType, getAccommodationTypes } from './catalog.js';
import { createMpesaClient, normalizeKenyanPhone } from './mpesa.js';

const DAY_MS = 86_400_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 7 * 1024 * 1024;
const MAX_PROPERTY_PHOTO_BYTES = 4 * 1024 * 1024;
const VALID_BOOKING_STATUSES = new Set(['pending', 'reviewing', 'confirmed', 'declined', 'cancelled']);
const VALID_AVAILABILITY = new Set(['unconfirmed', 'available', 'unavailable']);
const ALLOWED_MEDIA_TYPES = new Map([
  ['image/jpeg', { ext: '.jpg', signature: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/png', { ext: '.png', signature: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/webp', { ext: '.webp', signature: (bytes) => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' }],
  ['video/mp4', { ext: '.mp4', signature: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'ftyp' || bytes.subarray(4, 8).toString('ascii').includes('ftyp') }],
  ['video/webm', { ext: '.webm', signature: (bytes) => bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) }],
]);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function getBookingToken(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('bjlive_booking='));
  return cookie?.slice('bjlive_booking='.length) || '';
}

function bookingAccessTokenMatches(request, booking) {
  const token = getBookingToken(request);
  if (!token || !booking.customer_access_token_hash) return false;
  const provided = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const stored = Buffer.from(booking.customer_access_token_hash);
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

function bookingCookie(token, environment) {
  const secure = environment.NODE_ENV === 'production' ? '; Secure' : '';
  return `bjlive_booking=${token}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=604800${secure}`;
}

async function readJson(request) {
  if (!request.headers['content-type']?.includes('application/json')) {
    throw new ApiError(415, 'json_required', 'Send this request as JSON.');
  }

  if (request.body !== undefined) {
    if (typeof request.body === 'string' || Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
      const body = Buffer.from(request.body).toString('utf8');
      if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new ApiError(413, 'request_too_large', 'The request is too large.');
      try { return JSON.parse(body); } catch { throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.'); }
    }
    if (typeof request.body === 'object' && request.body !== null) return request.body;
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new ApiError(413, 'request_too_large', 'The request is too large.');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

async function readBytes(request, maxBytes) {
  if (typeof request.body === 'string') {
    const body = Buffer.from(request.body);
    if (body.length > maxBytes) throw new ApiError(413, 'request_too_large', 'The uploaded image is too large.');
    return body;
  }
  if (Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
    const body = Buffer.from(request.body);
    if (body.length > maxBytes) throw new ApiError(413, 'request_too_large', 'The uploaded image is too large.');
    return body;
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'request_too_large', 'The uploaded image is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mediaFromUrls(urls) {
  return (Array.isArray(urls) ? urls : []).filter(Boolean).map((url) => {
    const extension = String(url).split('?')[0].split('/').at(-1)?.toLowerCase() || '';
    const kind = extension.endsWith('.mp4') || extension.endsWith('.webm') || extension.endsWith('.mov') ? 'video' : 'image';
    return { url, kind };
  });
}

function propertyFromRow(row) {
  const photos = JSON.parse(row.photos_json);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    location: row.location,
    accommodationType: row.accommodation_type,
    dailyPriceKes: row.daily_price_kes,
    priceConfirmed: Boolean(row.price_confirmed),
    description: row.description,
    guestCapacity: row.guest_capacity,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    amenities: JSON.parse(row.amenities_json),
    photos,
    media: mediaFromUrls(photos),
    availabilityStatus: row.availability_status,
    published: Boolean(row.is_published),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicPropertyFromRow(row, packageRates) {
  const property = propertyFromRow(row);
  const packageRate = packageRates.find((rate) => rate.type === property.accommodationType);
  return {
    ...property,
    media: mediaFromUrls(property.photos),
    dailyPriceKes: property.priceConfirmed ? property.dailyPriceKes : null,
    priceRange: packageRate
      ? { minimumPriceKes: packageRate.minimumPriceKes, maximumPriceKes: packageRate.maximumPriceKes, unit: 'per day' }
      : null,
  };
}

function bookingFromRow(row) {
  return {
    id: row.id,
    reference: row.public_reference,
    propertyId: row.property_id,
    accommodationType: row.accommodation_type,
    location: row.location,
    checkIn: row.check_in,
    checkOut: row.check_out,
    durationDays: row.duration_days,
    guests: row.guests,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    estimatedMinimumKes: row.estimated_minimum_kes,
    estimatedMaximumKes: row.estimated_maximum_kes,
    confirmedAmountKes: row.confirmed_amount_kes,
    status: row.status,
    createdAt: row.created_at,
  };
}

function validDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseDateRange(checkIn, checkOut) {
  if (!validDate(checkIn) || !validDate(checkOut)) {
    throw new ApiError(400, 'invalid_dates', 'Choose valid check-in and check-out dates.');
  }
  const durationDays = (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS;
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) {
    throw new ApiError(400, 'invalid_duration', 'Check-out must be after check-in and within one year.');
  }
  return durationDays;
}

function slugify(value) {
  return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

async function audit(database, action, entityType, entityId) {
  await database.prepare('INSERT INTO admin_audit_log (id, action, entity_type, entity_id) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), action, entityType, entityId);
}

function getSessionId(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('bjlive_admin='));
  return cookie?.slice('bjlive_admin='.length) || '';
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
  } catch {
    return false;
  }
}

async function validateProperty(payload, previous, database) {
  const values = { ...previous, ...payload };
  const name = String(values.name ?? '').trim();
  const location = values.location;
  const accommodationType = values.accommodationType;
  const rate = await getAccommodationType(accommodationType, database);
  const dailyPriceKes = Number(values.dailyPriceKes);
  const guestCapacity = Number(values.guestCapacity);
  const bedrooms = values.bedrooms === '' || values.bedrooms == null ? null : Number(values.bedrooms);
  const bathrooms = values.bathrooms === '' || values.bathrooms == null ? null : Number(values.bathrooms);
  const description = String(values.description ?? '').trim();
  const amenities = values.amenities ?? [];

  if (!name || name.length > 120) throw new ApiError(400, 'invalid_name', 'Property name is required and must be under 120 characters.');
  if (!LOCATIONS.includes(location)) throw new ApiError(400, 'invalid_location', 'Choose a supported location.');
  if (!rate) throw new ApiError(400, 'invalid_accommodation_type', 'Choose a supported accommodation type.');
  if (!Number.isSafeInteger(dailyPriceKes) || dailyPriceKes < rate.minimumPriceKes || dailyPriceKes > rate.maximumPriceKes) {
    throw new ApiError(400, 'invalid_price', `Daily price must be within KSh ${rate.minimumPriceKes.toLocaleString()}–${rate.maximumPriceKes.toLocaleString()}.`);
  }
  if (!Number.isSafeInteger(guestCapacity) || guestCapacity < 1 || guestCapacity > 30) {
    throw new ApiError(400, 'invalid_capacity', 'Guest capacity must be from 1 to 30.');
  }
  if (bedrooms !== null && (!Number.isSafeInteger(bedrooms) || bedrooms < 0 || bedrooms > 20)) {
    throw new ApiError(400, 'invalid_bedrooms', 'Enter a valid bedroom count.');
  }
  if (bathrooms !== null && (!Number.isSafeInteger(bathrooms) || bathrooms < 0 || bathrooms > 20)) {
    throw new ApiError(400, 'invalid_bathrooms', 'Enter a valid bathroom count.');
  }
  if (description.length > 4000) throw new ApiError(400, 'description_too_long', 'Description must be under 4,000 characters.');
  if (!Array.isArray(amenities) || amenities.length > 30 || amenities.some((item) => typeof item !== 'string' || item.trim().length > 80)) {
    throw new ApiError(400, 'invalid_amenities', 'Amenities must be a list of up to 30 short labels.');
  }

  return {
    name,
    location,
    accommodationType,
    dailyPriceKes,
    priceConfirmed: Boolean(values.priceConfirmed),
    description,
    guestCapacity,
    bedrooms,
    bathrooms,
    amenities: amenities.map((item) => item.trim()).filter(Boolean),
    availabilityStatus: VALID_AVAILABILITY.has(values.availabilityStatus) ? values.availabilityStatus : 'unconfirmed',
    published: Boolean(values.published),
  };
}

async function saveProperty(database, id, slug, property) {
  const statement = database.prepare(`
    INSERT INTO properties (
      id, slug, name, location, accommodation_type, daily_price_kes, price_confirmed,
      description, guest_capacity, bedrooms, bathrooms, amenities_json, photos_json,
      availability_status, is_published, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, location=excluded.location, accommodation_type=excluded.accommodation_type,
      daily_price_kes=excluded.daily_price_kes, price_confirmed=excluded.price_confirmed,
      description=excluded.description, guest_capacity=excluded.guest_capacity,
      bedrooms=excluded.bedrooms, bathrooms=excluded.bathrooms, amenities_json=excluded.amenities_json,
      availability_status=excluded.availability_status, is_published=excluded.is_published,
      updated_at=CURRENT_TIMESTAMP
  `);
  await statement.run(
    id, slug, property.name, property.location, property.accommodationType, property.dailyPriceKes,
    Number(property.priceConfirmed), property.description, property.guestCapacity, property.bedrooms,
    property.bathrooms, JSON.stringify(property.amenities), property.availabilityStatus, Number(property.published),
  );
}

function setCookie(request, sessionId, maxAge, environment) {
  const secure = environment.NODE_ENV === 'production' ? '; Secure' : '';
  return `bjlive_admin=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function createApiHandler({ database, environment = process.env, uploadDirectory, photoStorage, mpesaClient = createMpesaClient({ environment }) }) {
  const configuredPassword = environment.ADMIN_PASSWORD || '';
  const passwordSalt = randomBytes(32);
  const passwordDigest = configuredPassword.length >= 14
    ? scryptSync(configuredPassword, passwordSalt, 64)
    : null;
  if (environment.NODE_ENV === 'production' && (environment.BOOKING_ACCESS_SECRET || '').length < 32) {
    throw new Error('Set BOOKING_ACCESS_SECRET to at least 32 characters before production startup.');
  }
  const bookingAccessSecret = environment.BOOKING_ACCESS_SECRET?.length >= 32
    ? environment.BOOKING_ACCESS_SECRET
    : randomBytes(32);
  const filesDirectory = resolve(uploadDirectory || fileURLToPath(new URL('../storage/property-images', import.meta.url)));

  function customerAccessTokenFor(idempotencyKey) {
    return createHmac('sha256', bookingAccessSecret).update(idempotencyKey).digest('hex');
  }

  async function sessionFor(request) {
    const id = getSessionId(request);
    if (!id) return null;
    const session = await database.prepare('SELECT expires_at FROM admin_sessions WHERE id = ?').get(id);
    if (!session || Number(session.expires_at) <= Date.now()) {
      if (session) await database.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
      return null;
    }
    return id;
  }

  async function requireAdmin(request) {
    if (!await sessionFor(request)) throw new ApiError(401, 'admin_required', 'Sign in as an administrator to continue.');
  }

  async function recordFailedLogin(ip, attempts) {
    await database.prepare(`
      INSERT INTO admin_login_attempts (ip, count, window_ends_at)
      VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET count = excluded.count, window_ends_at = excluded.window_ends_at
    `).run(ip, attempts.count + 1, attempts.until);
  }

  function ensureOrigin(request) {
    if (!isSameOrigin(request)) throw new ApiError(403, 'origin_rejected', 'This request must come from the Marevia website.');
  }

  async function createBooking(request) {
    const body = await readJson(request);
    const location = body.location;
    const accommodationType = body.accommodationType;
    if (!LOCATIONS.includes(location)) throw new ApiError(400, 'invalid_location', 'Choose Mombasa, Diani, Malindi, or Kisumu.');
    const packageRate = await getAccommodationType(accommodationType, database);
    if (!packageRate) throw new ApiError(400, 'invalid_accommodation_type', 'Choose one of the listed accommodation types.');

    const durationDays = parseDateRange(body.checkIn, body.checkOut);
    const guests = Number(body.guests);
    if (!Number.isSafeInteger(guests) || guests < 1 || guests > 30) throw new ApiError(400, 'invalid_guests', 'Guest count must be between 1 and 30.');

    const customerName = String(body.customerName ?? '').trim();
    const customerPhone = String(body.customerPhone ?? '').trim();
    const customerEmail = String(body.customerEmail ?? '').trim();
    if (!customerName || customerName.length > 120) throw new ApiError(400, 'invalid_customer_name', 'Enter your name.');
    if (!/^\+?[0-9 ()-]{9,20}$/.test(customerPhone)) throw new ApiError(400, 'invalid_phone', 'Enter a valid phone number.');
    if (customerEmail && (!/^\S+@\S+\.\S+$/.test(customerEmail) || customerEmail.length > 254)) {
      throw new ApiError(400, 'invalid_email', 'Enter a valid email address or leave it blank.');
    }

    let property = null;
    if (body.propertyId) {
      const row = await database.prepare('SELECT * FROM properties WHERE id = ? AND is_published = 1').get(String(body.propertyId));
      if (!row) throw new ApiError(404, 'property_not_found', 'That property is no longer available for enquiry.');
      property = propertyFromRow(row);
      if (property.location !== location || property.accommodationType !== accommodationType) {
        throw new ApiError(400, 'property_mismatch', 'The selected property does not match the selected location and accommodation type.');
      }
      if (guests > property.guestCapacity) throw new ApiError(400, 'guest_capacity_exceeded', `This property lists a guest capacity of ${property.guestCapacity}.`);
      if (property.availabilityStatus === 'unavailable') throw new ApiError(409, 'property_unavailable', 'This property is currently marked unavailable.');
      const blocked = await database.prepare(`
        SELECT 1 FROM availability_blocks
        WHERE property_id = ? AND starts_on < ? AND ends_on > ? LIMIT 1
      `).get(property.id, body.checkOut, body.checkIn);
      if (blocked) throw new ApiError(409, 'dates_blocked', 'The property is blocked for some of those dates. Choose different dates or another option.');
      const confirmedConflict = await database.prepare(`
        SELECT 1 FROM booking_requests
        WHERE property_id = ? AND status = 'confirmed' AND check_in < ? AND check_out > ? LIMIT 1
      `).get(property.id, body.checkOut, body.checkIn);
      if (confirmedConflict) throw new ApiError(409, 'dates_already_booked', 'The property already has a confirmed booking for some of those dates.');
    }

    const dailyMinimum = property?.priceConfirmed ? property.dailyPriceKes : packageRate.minimumPriceKes;
    const dailyMaximum = property?.priceConfirmed ? property.dailyPriceKes : packageRate.maximumPriceKes;
    const estimatedMinimumKes = dailyMinimum * durationDays;
    const estimatedMaximumKes = dailyMaximum * durationDays;
    const idempotencyKey = String(request.headers['idempotency-key'] || randomUUID()).slice(0, 100);
    const previous = await database.prepare('SELECT * FROM booking_requests WHERE idempotency_key = ?').get(idempotencyKey);
    if (previous) {
      return {
        status: 200,
        booking: bookingFromRow(previous),
        duplicate: true,
        customerAccessToken: customerAccessTokenFor(idempotencyKey),
      };
    }

    const id = randomUUID();
    const reference = `BJL-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const customerAccessToken = customerAccessTokenFor(idempotencyKey);
    const accessTokenHash = createHash('sha256').update(customerAccessToken).digest('hex');
    await database.prepare(`
      INSERT INTO booking_requests (
        id, public_reference, property_id, accommodation_type, location, check_in, check_out,
        duration_days, guests, customer_name, customer_phone, customer_email,
        estimated_minimum_kes, estimated_maximum_kes, idempotency_key, customer_access_token_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reference, property?.id || null, accommodationType, location, body.checkIn, body.checkOut,
      durationDays, guests, customerName, customerPhone, customerEmail || null,
      estimatedMinimumKes, estimatedMaximumKes, idempotencyKey, accessTokenHash,
    );
    return {
      status: 201,
      booking: bookingFromRow(await database.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id)),
      duplicate: false,
      customerAccessToken,
    };
  }

  async function handleAdmin(request, response, url, pathname) {
    if (pathname === '/api/admin/session' && request.method === 'GET') {
      const sessionId = await sessionFor(request);
      return sendJson(response, 200, { authenticated: Boolean(sessionId), configured: Boolean(passwordDigest) });
    }

    if (pathname === '/api/admin/login' && request.method === 'POST') {
      ensureOrigin(request);
      if (!passwordDigest) throw new ApiError(503, 'admin_not_configured', 'Set ADMIN_PASSWORD to a value of at least 14 characters in the local environment file.');
      const forwardedAddresses = request.headers['x-forwarded-for']?.split(',').map((address) => address.trim());
      const ip = forwardedAddresses?.at(-1) || request.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      const storedAttempts = await database.prepare('SELECT count, window_ends_at FROM admin_login_attempts WHERE ip = ?').get(ip);
      let attempts = storedAttempts
        ? { count: Number(storedAttempts.count), until: Number(storedAttempts.window_ends_at) }
        : { count: 0, until: now + 15 * 60 * 1000 };
      if (attempts.count >= 5) throw new ApiError(429, 'login_rate_limited', 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const body = await readJson(request);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length > 1024) {
        await recordFailedLogin(ip, attempts);
        throw new ApiError(401, 'invalid_credentials', 'The administrator password was not accepted.');
      }
      const candidate = scryptSync(password, passwordSalt, 64);
      if (!timingSafeEqual(candidate, passwordDigest)) {
        await recordFailedLogin(ip, attempts);
        throw new ApiError(401, 'invalid_credentials', 'The administrator password was not accepted.');
      }
      await database.prepare('DELETE FROM admin_login_attempts WHERE ip = ?').run(ip);
      const sessionId = randomBytes(32).toString('hex');
      await database.prepare('INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)').run(sessionId, Date.now() + SESSION_TTL_MS);
      return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': setCookie(request, sessionId, SESSION_TTL_MS / 1000, environment) });
    }

    if (pathname === '/api/admin/logout' && request.method === 'POST') {
      ensureOrigin(request);
      const sessionId = getSessionId(request);
      if (sessionId) await database.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId);
      return sendJson(response, 200, { authenticated: false }, { 'Set-Cookie': setCookie(request, '', 0, environment) });
    }

    await requireAdmin(request);
    if (request.method !== 'GET') ensureOrigin(request);

    if (pathname === '/api/admin/properties' && request.method === 'GET') {
      const properties = await database.prepare('SELECT * FROM properties ORDER BY created_at DESC').all();
      return sendJson(response, 200, { properties: properties.map(propertyFromRow) });
    }

    if (pathname === '/api/admin/properties' && request.method === 'POST') {
      const body = await readJson(request);
      const property = await validateProperty(body, {}, database);
      const id = randomUUID();
      const slug = `${slugify(property.name) || 'property'}-${id.slice(0, 8)}`;
      await saveProperty(database, id, slug, property);
      await audit(database, 'create', 'property', id);
      return sendJson(response, 201, { property: propertyFromRow(await database.prepare('SELECT * FROM properties WHERE id = ?').get(id)) });
    }

    const propertyMatch = pathname.match(/^\/api\/admin\/properties\/([0-9a-f-]+)$/i);
    if (propertyMatch && request.method === 'PATCH') {
      const row = await database.prepare('SELECT * FROM properties WHERE id = ?').get(propertyMatch[1]);
      if (!row) throw new ApiError(404, 'property_not_found', 'Property not found.');
      const body = await readJson(request);
      const property = await validateProperty(body, propertyFromRow(row), database);
      await saveProperty(database, row.id, row.slug, property);
      await audit(database, 'update', 'property', row.id);
      return sendJson(response, 200, { property: propertyFromRow(await database.prepare('SELECT * FROM properties WHERE id = ?').get(row.id)) });
    }

    if (propertyMatch && request.method === 'DELETE') {
      const row = await database.prepare('SELECT * FROM properties WHERE id = ?').get(propertyMatch[1]);
      if (!row) throw new ApiError(404, 'property_not_found', 'Property not found.');
      for (const photo of JSON.parse(row.photos_json)) await removeStoredPhoto(photo, filesDirectory, photoStorage);
      await database.prepare('DELETE FROM properties WHERE id = ?').run(row.id);
      await audit(database, 'delete', 'property', row.id);
      return sendJson(response, 200, { deleted: true });
    }

    const photosMatch = pathname.match(/^\/api\/admin\/properties\/([0-9a-f-]+)\/photos$/i);
    if (photosMatch && request.method === 'POST') {
      const row = await database.prepare('SELECT * FROM properties WHERE id = ?').get(photosMatch[1]);
      if (!row) throw new ApiError(404, 'property_not_found', 'Property not found.');
      let contentType = String(request.headers['content-type'] || '').split(';')[0].toLowerCase();
      let bytes;
      if (contentType === 'application/json') {
        const body = await readJson(request);
        contentType = body.contentType;
        if (typeof body.data !== 'string' || body.data.length > 6 * 1024 * 1024) {
          throw new ApiError(400, 'invalid_media', 'Upload a JPEG, PNG, WebP, MP4, or WebM media file no larger than 4 MB.');
        }
        bytes = Buffer.from(body.data, 'base64');
      } else {
        bytes = await readBytes(request, MAX_PROPERTY_PHOTO_BYTES);
      }
      const media = ALLOWED_MEDIA_TYPES.get(contentType);
      if (!media) throw new ApiError(400, 'invalid_media', 'Upload a JPEG, PNG, WebP, MP4, or WebM media file no larger than 4 MB.');
      if (!bytes.length || bytes.length > MAX_PROPERTY_PHOTO_BYTES || !media.signature(bytes)) {
        throw new ApiError(400, 'invalid_media_contents', 'The uploaded file does not match its media type or exceeds 4 MB.');
      }
      const fileName = `${randomUUID()}${media.ext}`;
      const photoUrl = await storePhoto(fileName, bytes, contentType, filesDirectory, photoStorage);
      const photos = [...JSON.parse(row.photos_json), photoUrl];
      await database.prepare('UPDATE properties SET photos_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(photos), row.id);
      await audit(database, 'add-photo', 'property', row.id);
      return sendJson(response, 201, { photos });
    }

    if (photosMatch && request.method === 'DELETE') {
      const row = await database.prepare('SELECT * FROM properties WHERE id = ?').get(photosMatch[1]);
      if (!row) throw new ApiError(404, 'property_not_found', 'Property not found.');
      const body = await readJson(request);
      const photos = JSON.parse(row.photos_json);
      if (!photos.includes(body.photo)) throw new ApiError(404, 'photo_not_found', 'Photo not found on this property.');
      await removeStoredPhoto(body.photo, filesDirectory, photoStorage);
      const remaining = photos.filter((photo) => photo !== body.photo);
      await database.prepare('UPDATE properties SET photos_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(remaining), row.id);
      await audit(database, 'remove-photo', 'property', row.id);
      return sendJson(response, 200, { photos: remaining });
    }

    const availabilityMatch = pathname.match(/^\/api\/admin\/properties\/([0-9a-f-]+)\/availability(?:\/([0-9a-f-]+))?$/i);
    if (availabilityMatch && request.method === 'GET') {
      return sendJson(response, 200, { blocks: await database.prepare('SELECT * FROM availability_blocks WHERE property_id = ? ORDER BY starts_on').all(availabilityMatch[1]) });
    }
    if (availabilityMatch && request.method === 'POST' && !availabilityMatch[2]) {
      const property = await database.prepare('SELECT id FROM properties WHERE id = ?').get(availabilityMatch[1]);
      if (!property) throw new ApiError(404, 'property_not_found', 'Property not found.');
      const body = await readJson(request);
      parseDateRange(body.startsOn, body.endsOn);
      const id = randomUUID();
      const reason = ['unavailable', 'maintenance'].includes(body.reason) ? body.reason : 'unavailable';
      await database.prepare('INSERT INTO availability_blocks (id, property_id, starts_on, ends_on, reason) VALUES (?, ?, ?, ?, ?)')
        .run(id, property.id, body.startsOn, body.endsOn, reason);
      await audit(database, 'block-dates', 'property', property.id);
      return sendJson(response, 201, { id, propertyId: property.id, startsOn: body.startsOn, endsOn: body.endsOn, reason });
    }
    if (availabilityMatch && request.method === 'DELETE' && availabilityMatch[2]) {
      const result = await database.prepare('DELETE FROM availability_blocks WHERE id = ? AND property_id = ?').run(availabilityMatch[2], availabilityMatch[1]);
      if (!result.changes) throw new ApiError(404, 'availability_block_not_found', 'Date block not found.');
      await audit(database, 'unblock-dates', 'property', availabilityMatch[1]);
      return sendJson(response, 200, { deleted: true });
    }

    if (pathname === '/api/admin/packages' && request.method === 'GET') {
      return sendJson(response, 200, { packages: await getAccommodationTypes(database) });
    }
    const packageMatch = pathname.match(/^\/api\/admin\/packages\/(.+)$/);
    if (packageMatch && request.method === 'PUT') {
      let type;
      try { type = decodeURIComponent(packageMatch[1]); } catch { throw new ApiError(400, 'invalid_package', 'Package type is invalid.'); }
      const existing = await getAccommodationType(type, database);
      if (!existing) throw new ApiError(404, 'package_not_found', 'Package type not found.');
      const body = await readJson(request);
      const starting = Number(body.startingPriceKes);
      const minimum = Number(body.minimumPriceKes);
      const maximum = Number(body.maximumPriceKes);
      if (![starting, minimum, maximum].every((value) => Number.isSafeInteger(value) && value >= 100 && value <= 1_000_000)
        || minimum > starting || starting > maximum) {
        throw new ApiError(400, 'invalid_package_prices', 'Enter whole-number prices with minimum <= starting <= maximum.');
      }
      await database.prepare(`
        INSERT INTO package_prices (accommodation_type, starting_price_kes, minimum_price_kes, maximum_price_kes, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(accommodation_type) DO UPDATE SET starting_price_kes=excluded.starting_price_kes,
          minimum_price_kes=excluded.minimum_price_kes, maximum_price_kes=excluded.maximum_price_kes, updated_at=CURRENT_TIMESTAMP
      `).run(type, starting, minimum, maximum);
      await audit(database, 'update-price', 'package', type);
      return sendJson(response, 200, { package: await getAccommodationType(type, database) });
    }

    if (pathname === '/api/admin/bookings' && request.method === 'GET') {
      const bookings = (await database.prepare('SELECT * FROM booking_requests ORDER BY created_at DESC LIMIT 500').all()).map(bookingFromRow);
      return sendJson(response, 200, { bookings });
    }
    const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([0-9a-f-]+)$/i);
    if (bookingMatch && request.method === 'PATCH') {
      const body = await readJson(request);
      if (!VALID_BOOKING_STATUSES.has(body.status)) throw new ApiError(400, 'invalid_booking_status', 'Choose a valid booking status.');
      const booking = await database.prepare('SELECT * FROM booking_requests WHERE id = ?').get(bookingMatch[1]);
      if (!booking) throw new ApiError(404, 'booking_not_found', 'Booking request not found.');
      const propertyId = body.propertyId === undefined ? booking.property_id : (String(body.propertyId || '').trim() || null);
      const confirmedAmount = body.confirmedAmountKes == null || body.confirmedAmountKes === '' ? null : Number(body.confirmedAmountKes);
      if (confirmedAmount !== null && (!Number.isSafeInteger(confirmedAmount)
        || confirmedAmount < booking.estimated_minimum_kes || confirmedAmount > booking.estimated_maximum_kes)) {
        throw new ApiError(400, 'invalid_confirmed_amount', 'Confirmed total must be within the original estimate range.');
      }
      if (body.status === 'confirmed' && confirmedAmount === null) {
        throw new ApiError(400, 'confirmed_total_required', 'Enter the exact guest-agreed total before confirming the request.');
      }
      if (body.status === 'confirmed') {
        if (!propertyId) throw new ApiError(400, 'confirmed_property_required', 'Assign a verified property before confirming the booking request.');
        const property = await database.prepare('SELECT * FROM properties WHERE id = ? AND is_published = 1').get(propertyId);
        if (!property || property.availability_status !== 'available') {
          throw new ApiError(409, 'property_not_confirmed', 'The assigned property must be published and marked available by the administrator.');
        }
        if (property.location !== booking.location || property.accommodation_type !== booking.accommodation_type
          || booking.guests > property.guest_capacity) {
          throw new ApiError(400, 'property_booking_mismatch', 'The assigned property does not match this request location, type, and guest count.');
        }
        const blocked = await database.prepare(`SELECT 1 FROM availability_blocks
          WHERE property_id = ? AND starts_on < ? AND ends_on > ? LIMIT 1`).get(propertyId, booking.check_out, booking.check_in);
        if (blocked) throw new ApiError(409, 'dates_blocked', 'The assigned property is blocked for some requested dates.');
        const overlapping = await database.prepare(`SELECT 1 FROM booking_requests
          WHERE property_id = ? AND status = 'confirmed' AND id != ? AND check_in < ? AND check_out > ? LIMIT 1`)
          .get(propertyId, booking.id, booking.check_out, booking.check_in);
        if (overlapping) throw new ApiError(409, 'dates_already_booked', 'The property already has a confirmed booking for some requested dates.');
      }
      const paid = await database.prepare("SELECT 1 FROM payment_attempts WHERE booking_id = ? AND status = 'succeeded' LIMIT 1").get(booking.id);
      if (paid && body.status !== 'confirmed') throw new ApiError(409, 'payment_already_verified', 'A verified payment exists; contact the guest before changing this booking status.');
      await database.prepare('UPDATE booking_requests SET status = ?, property_id = ?, confirmed_amount_kes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(body.status, propertyId, confirmedAmount, bookingMatch[1]);
      await audit(database, 'update-status', 'booking', bookingMatch[1]);
      return sendJson(response, 200, { booking: bookingFromRow(await database.prepare('SELECT * FROM booking_requests WHERE id = ?').get(bookingMatch[1])) });
    }

    if (pathname === '/api/admin/payments' && request.method === 'GET') {
      const payments = await database.prepare(`SELECT payments.*, bookings.public_reference
        FROM payment_attempts payments JOIN booking_requests bookings ON bookings.id = payments.booking_id
        ORDER BY payments.created_at DESC LIMIT 500`).all();
      return sendJson(response, 200, { payments });
    }

    throw new ApiError(404, 'not_found', 'Admin API route not found.');
  }

  return async function handleApi(request, response, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return false;

    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { Allow: 'GET, POST, PATCH, PUT, DELETE, OPTIONS' }).end();
        return true;
      }
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
        throw new ApiError(405, 'method_not_allowed', 'This method is not supported.');
      }

      if (pathname.startsWith('/api/admin/')) {
        await handleAdmin(request, response, url, pathname);
        return true;
      }

      if (pathname === '/api/health' && request.method === 'GET') {
        await database.prepare('SELECT 1').get();
        sendJson(response, 200, { status: 'ok', database: 'connected' });
        return true;
      }
      if (pathname === '/api/locations' && request.method === 'GET') {
        sendJson(response, 200, { locations: LOCATIONS });
        return true;
      }
      if (pathname === '/api/packages' && request.method === 'GET') {
        sendJson(response, 200, { packages: await getAccommodationTypes(database) });
        return true;
      }
      if (pathname === '/api/properties' && request.method === 'GET') {
        const location = url.searchParams.get('location');
        const accommodationType = url.searchParams.get('type');
        const guests = Number(url.searchParams.get('guests') || 0);
        const sort = url.searchParams.get('sort') || 'price-asc';
        const checkIn = url.searchParams.get('checkIn');
        const checkOut = url.searchParams.get('checkOut');
        const minimumPrice = url.searchParams.get('minimumPrice');
        const maximumPrice = url.searchParams.get('maximumPrice');
        if (location && !LOCATIONS.includes(location)) throw new ApiError(400, 'invalid_location', 'Choose a supported location.');
        if (accommodationType && !ACCOMMODATION_TYPES.some((item) => item.type === accommodationType)) {
          throw new ApiError(400, 'invalid_accommodation_type', 'Choose a supported accommodation type.');
        }
        if (!['price-asc', 'price-desc', 'name'].includes(sort)) throw new ApiError(400, 'invalid_sort', 'Choose a supported sort order.');
        const clauses = ['is_published = 1', "availability_status != 'unavailable'"];
        const parameters = [];
        if (checkIn || checkOut) {
          parseDateRange(checkIn, checkOut);
          clauses.push(`NOT EXISTS (
            SELECT 1 FROM availability_blocks block
            WHERE block.property_id = properties.id AND block.starts_on < ? AND block.ends_on > ?
          ) AND NOT EXISTS (
            SELECT 1 FROM booking_requests confirmed
            WHERE confirmed.property_id = properties.id AND confirmed.status = 'confirmed'
              AND confirmed.check_in < ? AND confirmed.check_out > ?
          )`);
          parameters.push(checkOut, checkIn, checkOut, checkIn);
        }
        if (location) { clauses.push('location = ?'); parameters.push(location); }
        if (accommodationType) { clauses.push('accommodation_type = ?'); parameters.push(accommodationType); }
        if (url.searchParams.has('guests')) {
          if (!Number.isSafeInteger(guests) || guests < 1 || guests > 30) throw new ApiError(400, 'invalid_guests', 'Guest count must be from 1 to 30.');
          clauses.push('guest_capacity >= ?'); parameters.push(guests);
        }
        if (minimumPrice !== null) {
          const amount = Number(minimumPrice);
          if (!Number.isSafeInteger(amount) || amount < 0) throw new ApiError(400, 'invalid_minimum_price', 'Enter a valid minimum daily price.');
          clauses.push('daily_price_kes >= ?');
          parameters.push(amount);
        }
        if (maximumPrice !== null) {
          const amount = Number(maximumPrice);
          if (!Number.isSafeInteger(amount) || amount < 0) throw new ApiError(400, 'invalid_maximum_price', 'Enter a valid maximum daily price.');
          clauses.push('daily_price_kes <= ?');
          parameters.push(amount);
        }
        const ordering = sort === 'price-desc' ? 'daily_price_kes DESC' : sort === 'name' ? 'LOWER(name) ASC' : 'daily_price_kes ASC';
        const rows = await database.prepare(`SELECT * FROM properties WHERE ${clauses.join(' AND ')} ORDER BY ${ordering} LIMIT 100`)
          .all(...parameters);
        const packageRates = await getAccommodationTypes(database);
        const properties = rows.map((row) => publicPropertyFromRow(row, packageRates));
        sendJson(response, 200, { properties, availabilityDisclaimer: 'Search results are enquiries only. Confirm property and date availability with Marevia.' });
        return true;
      }
      const publicProperty = pathname.match(/^\/api\/properties\/([a-z0-9-]+)$/i);
      if (publicProperty && request.method === 'GET') {
        const row = await database.prepare('SELECT * FROM properties WHERE (id = ? OR slug = ?) AND is_published = 1').get(publicProperty[1], publicProperty[1]);
        if (!row) throw new ApiError(404, 'property_not_found', 'Property not found.');
        const packageRates = await getAccommodationTypes(database);
        sendJson(response, 200, { property: publicPropertyFromRow(row, packageRates) });
        return true;
      }
      if (pathname === '/api/bookings' && request.method === 'POST') {
        const result = await createBooking(request);
        sendJson(response, result.status, { booking: result.booking, duplicate: result.duplicate },
          result.customerAccessToken ? { 'Set-Cookie': bookingCookie(result.customerAccessToken, environment) } : {});
        return true;
      }
      const customerBooking = pathname.match(/^\/api\/bookings\/([A-Z0-9-]+)$/i);
      if (customerBooking && request.method === 'GET') {
        const booking = await database.prepare('SELECT * FROM booking_requests WHERE public_reference = ?').get(customerBooking[1]);
        if (!booking || !bookingAccessTokenMatches(request, booking)) {
          throw new ApiError(404, 'booking_not_found', 'Booking request not found.');
        }
        const payments = await database.prepare('SELECT status, amount_kes, created_at FROM payment_attempts WHERE booking_id = ? ORDER BY created_at DESC').all(booking.id);
        sendJson(response, 200, { booking: bookingFromRow(booking), payments });
        return true;
      }
      if (pathname === '/api/payments/mpesa/config' && request.method === 'GET') {
        sendJson(response, 200, { configured: mpesaClient.configured });
        return true;
      }
      if (pathname === '/api/payments/mpesa/callback' && request.method === 'POST') {
        const expectedCallbackToken = Buffer.from(String(environment.MPESA_CALLBACK_TOKEN || ''));
        const providedCallbackToken = Buffer.from(String(url.searchParams.get('token') || ''));
        if (expectedCallbackToken.length < 32 || providedCallbackToken.length !== expectedCallbackToken.length
          || !timingSafeEqual(providedCallbackToken, expectedCallbackToken)) {
          throw new ApiError(401, 'invalid_mpesa_callback', 'The payment callback was not authorized.');
        }
        const callback = await readJson(request);
        const stkCallback = callback?.Body?.stkCallback;
        const checkoutId = stkCallback?.CheckoutRequestID;
        if (typeof checkoutId !== 'string' || checkoutId.length > 120) {
          throw new ApiError(400, 'invalid_mpesa_callback', 'The M-Pesa callback did not include a valid checkout reference.');
        }
        const payment = await database.prepare('SELECT * FROM payment_attempts WHERE checkout_request_id = ?').get(checkoutId);
        if (!payment) return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'No matching payment attempt.' });
        if (payment.status !== 'pending') return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment attempt already processed.' });

        const providerResult = await mpesaClient.queryStkPush(checkoutId);
        const providerCode = String(providerResult.ResultCode ?? '');
        if (!providerCode) {
          return sendJson(response, 202, { ResultCode: 0, ResultDesc: 'Provider status is pending reconciliation.' });
        }
        if (providerCode !== '0') {
          await database.prepare(`UPDATE payment_attempts SET status = 'failed', provider_result_code = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'pending'`).run(providerCode.slice(0, 40) || 'provider_failure', payment.id);
          return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Provider status recorded.' });
        }
        if (Number(stkCallback.ResultCode) !== 0) {
          return sendJson(response, 202, { ResultCode: 0, ResultDesc: 'Provider status is being reconciled.' });
        }

        const metadata = Object.fromEntries((stkCallback.CallbackMetadata?.Item || []).map((item) => [item.Name, item.Value]));
        const booking = await database.prepare('SELECT * FROM booking_requests WHERE id = ?').get(payment.booking_id);
        const receipt = String(metadata.MpesaReceiptNumber || '');
        let callbackPhone = '';
        try { callbackPhone = normalizeKenyanPhone(metadata.PhoneNumber); } catch { }
        const expectedPhone = normalizeKenyanPhone(booking.customer_phone);
        if (Number(metadata.Amount) !== payment.amount_kes || callbackPhone !== expectedPhone || !/^[A-Z0-9]{8,16}$/.test(receipt)) {
          return sendJson(response, 202, { ResultCode: 0, ResultDesc: 'Provider status is being reconciled.' });
        }

        try {
          await database.prepare(`UPDATE payment_attempts SET status = 'succeeded', receipt_number = ?, provider_result_code = '0', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'pending'`).run(receipt, payment.id);
        } catch (error) {
          if (!String(error.message).includes('UNIQUE')) throw error;
          await database.prepare(`UPDATE payment_attempts SET status = 'failed', provider_result_code = 'duplicate_receipt', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'pending'`).run(payment.id);
        }
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Accepted.' });
      }
      if (pathname === '/api/payments/mpesa' && request.method === 'POST') {
        ensureOrigin(request);
        if (!mpesaClient.configured) throw new ApiError(503, 'mpesa_not_configured', 'M-Pesa is not configured. No payment was started. Contact Marevia to confirm price and availability.');
        const body = await readJson(request);
        const reference = String(body.bookingReference || '').trim();
        let customerPhone;
        try { customerPhone = normalizeKenyanPhone(body.customerPhone); } catch { throw new ApiError(400, 'invalid_phone', 'Enter the phone number used for this booking request.'); }
        const booking = await database.prepare('SELECT * FROM booking_requests WHERE public_reference = ?').get(reference);
        if (!booking || normalizeKenyanPhone(booking.customer_phone) !== customerPhone || !bookingAccessTokenMatches(request, booking)) {
          throw new ApiError(404, 'booking_not_found', 'No confirmed booking request matched those details.');
        }
        if (booking.status !== 'confirmed' || !booking.confirmed_amount_kes) {
          throw new ApiError(409, 'booking_not_confirmed', 'Marevia must confirm the property, date availability, and exact total before payment.');
        }
        if (booking.confirmed_amount_kes < booking.estimated_minimum_kes || booking.confirmed_amount_kes > booking.estimated_maximum_kes) {
          throw new ApiError(409, 'confirmed_amount_changed', 'The confirmed amount is outside the original estimate. Contact Marevia to review the request.');
        }
        const idempotencyKey = String(request.headers['idempotency-key'] || '').trim().slice(0, 100);
        if (!idempotencyKey) throw new ApiError(400, 'idempotency_key_required', 'A payment retry reference is required.');
        const previous = await database.prepare('SELECT * FROM payment_attempts WHERE idempotency_key = ?').get(idempotencyKey);
        if (previous) {
          if (previous.status === 'failed' || previous.status === 'cancelled') {
            throw new ApiError(409, 'payment_attempt_failed', 'That payment attempt did not complete. Refresh the request status before starting a new attempt.');
          }
          return sendJson(response, 200, {
            payment: { id: previous.id, status: previous.status, amountKes: previous.amount_kes },
            duplicate: true,
          });
        }
        const inProgress = await database.prepare("SELECT id FROM payment_attempts WHERE booking_id = ? AND status = 'pending'").get(booking.id);
        if (inProgress) throw new ApiError(409, 'payment_in_progress', 'A payment attempt is already in progress for this booking.');

        const paymentId = randomUUID();
        await database.prepare(`INSERT INTO payment_attempts (id, booking_id, provider, amount_kes, status, idempotency_key)
          VALUES (?, ?, 'mpesa', ?, 'pending', ?)`).run(paymentId, booking.id, booking.confirmed_amount_kes, idempotencyKey);
        try {
          const initiated = await mpesaClient.initiateStkPush({
            phoneNumber: booking.customer_phone,
            amountKes: booking.confirmed_amount_kes,
            accountReference: booking.public_reference,
            description: 'Accommodation booking',
          });
          await database.prepare(`UPDATE payment_attempts SET checkout_request_id = ?, merchant_request_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(initiated.checkoutRequestId, initiated.merchantRequestId, paymentId);
          return sendJson(response, 202, {
            payment: { id: paymentId, status: 'pending', amountKes: booking.confirmed_amount_kes, customerMessage: initiated.customerMessage },
          });
        } catch (error) {
          await database.prepare("UPDATE payment_attempts SET status = 'failed', provider_result_code = 'initiation_error', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(paymentId);
          console.error('M-Pesa initiation failed:', error.message);
          throw new ApiError(502, 'payment_provider_error', 'M-Pesa did not start the payment request. No payment was confirmed; contact Marevia before retrying.');
        }
      }

      throw new ApiError(404, 'not_found', 'API route not found.');
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error('API request failed:', error);
        sendJson(response, 500, { error: { code: 'internal_error', message: 'The request could not be completed. Please try again.' } });
      }
      return true;
    }
  };
}

async function storePhoto(fileName, bytes, contentType, directory, storage) {
  if (storage) return storage.put(fileName, bytes, contentType);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, fileName), bytes, { flag: 'wx' });
  return `/uploads/properties/${fileName}`;
}

async function removeStoredPhoto(photo, directory, storage) {
  if (typeof photo === 'string' && (/^https:\/\//i.test(photo) || photo.startsWith('/uploads/properties/'))) {
    if (storage) await storage.delete(photo);
    return;
  }
  const fileName = typeof photo === 'string' ? photo.split('/').pop() : '';
  if (!/^[0-9a-f-]+\.(jpg|png|webp)$/i.test(fileName)) return;
  const target = resolve(directory, fileName);
  if (target.startsWith(`${resolve(directory)}${sep}`)) {
    try { unlinkSync(target); } catch { }
  }
}