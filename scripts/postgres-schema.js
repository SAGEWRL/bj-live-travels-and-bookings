export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS package_prices (
  accommodation_type TEXT PRIMARY KEY,
  starting_price_kes INTEGER NOT NULL CHECK (starting_price_kes > 0),
  minimum_price_kes INTEGER NOT NULL CHECK (minimum_price_kes > 0),
  maximum_price_kes INTEGER NOT NULL CHECK (maximum_price_kes >= minimum_price_kes),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('Mombasa', 'Diani', 'Malindi', 'Kisumu')),
  accommodation_type TEXT NOT NULL CHECK (accommodation_type IN ('Single room', 'Double room', 'BnB studio', 'One-bedroom accommodation', 'Two-bedroom accommodation')),
  daily_price_kes INTEGER NOT NULL CHECK (daily_price_kes > 0),
  price_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (price_confirmed IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  guest_capacity INTEGER NOT NULL CHECK (guest_capacity > 0),
  bedrooms INTEGER CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms INTEGER CHECK (bathrooms IS NULL OR bathrooms >= 0),
  amenities_json TEXT NOT NULL DEFAULT '[]',
  photos_json TEXT NOT NULL DEFAULT '[]',
  availability_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (availability_status IN ('unconfirmed', 'available', 'unavailable')),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS properties_location_type_idx ON properties(location, accommodation_type, is_published);
CREATE INDEX IF NOT EXISTS properties_price_idx ON properties(daily_price_kes, is_published);

CREATE TABLE IF NOT EXISTS availability_blocks (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'unavailable' CHECK (reason IN ('unavailable', 'maintenance')),
  CHECK (ends_on > starts_on)
);

CREATE INDEX IF NOT EXISTS availability_blocks_dates_idx ON availability_blocks(property_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS booking_requests (
  id TEXT PRIMARY KEY,
  public_reference TEXT NOT NULL UNIQUE,
  property_id TEXT REFERENCES properties(id) ON DELETE SET NULL,
  accommodation_type TEXT NOT NULL CHECK (accommodation_type IN ('Single room', 'Double room', 'BnB studio', 'One-bedroom accommodation', 'Two-bedroom accommodation')),
  location TEXT NOT NULL CHECK (location IN ('Mombasa', 'Diani', 'Malindi', 'Kisumu')),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  guests INTEGER NOT NULL CHECK (guests > 0),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  estimated_minimum_kes INTEGER NOT NULL CHECK (estimated_minimum_kes >= 0),
  estimated_maximum_kes INTEGER NOT NULL CHECK (estimated_maximum_kes >= estimated_minimum_kes),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'confirmed', 'declined', 'cancelled')),
  idempotency_key TEXT UNIQUE,
  confirmed_amount_kes INTEGER CHECK (confirmed_amount_kes IS NULL OR confirmed_amount_kes > 0),
  customer_access_token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (check_out > check_in)
);

CREATE INDEX IF NOT EXISTS booking_requests_status_created_idx ON booking_requests(status, created_at);
CREATE INDEX IF NOT EXISTS booking_requests_property_dates_idx ON booking_requests(property_id, check_in, check_out);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES booking_requests(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('mpesa')),
  amount_kes INTEGER NOT NULL CHECK (amount_kes > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  receipt_number TEXT UNIQUE,
  provider_result_code TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payment_attempts_booking_idx ON payment_attempts(booking_id, created_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count >= 0),
  window_ends_at BIGINT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS admin_login_attempts_expiry_idx ON admin_login_attempts(window_ends_at);
`;

export const D1_SCHEMA = POSTGRES_SCHEMA;