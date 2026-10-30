# Marevia Travels and Booking

Accommodation enquiries for Mombasa, Diani, Malindi, and Kisumu. The site uses an HTML/CSS/vanilla JavaScript frontend and a same-origin Node API. Local development uses SQLite; Vercel deployments use Neon PostgreSQL and Vercel Blob for durable data and property photos.

## Run locally

1. Use Node.js 24 or newer for local development.
2. Copy `.env.example` to `.env`.
3. Set `ADMIN_PASSWORD` to a unique password with at least 14 characters and `BOOKING_ACCESS_SECRET` to at least 32 random characters. Do not commit `.env` or send secrets in chat.
4. Run `npm run migrate` to apply the schema.
5. Run `npm run dev` and open `http://localhost:4173`.
6. Run `npm test` for API, booking, pricing, authentication, and form checks.

The SQLite database is created at `data/bjlive.sqlite` by default. Set `DATABASE_PATH` to change it. Set `PUBLIC_SITE_URL` to the production origin when deploying. Back up the database and `storage/property-images/` together. `npm run migrate:rollback` reverses the latest schema migration; back up persistent data before rolling back.

## Administrator

Open `/admin`, sign in with `ADMIN_PASSWORD`, and use the workspace to edit package price ranges, add or update property details, upload approved photos, manage blocked dates, and review booking requests. New properties are unpublished by default. Publish a listing only after its name, location, type, capacity, photos, description, amenities, and price have been confirmed. Booking requests can only be marked confirmed when the administrator enters an exact guest-agreed total within the original estimate range. Package rates can be edited in the same screen.

The initial database contains schema only and no property or booking records. No example inventory is inserted. Public listings appear after an administrator adds and publishes them.

Uploads are explicitly selected in the admin form, limited to JPEG/PNG/WebP and 4 MB per image, and signature-checked. Local uploads are stored under `storage/property-images/`; Vercel uploads use public Vercel Blob URLs. Do not copy a whole phone photo library into the storage folder.

## Prices and booking requests

The built-in package card shows the business-provided starts and ranges per day:

| Accommodation type | Start | Supplied range |
| --- | ---: | ---: |
| Single room | KSh 2,000 | KSh 2,000–4,000 |
| Double room | KSh 2,500 | KSh 2,500–5,000 |
| BnB studio | KSh 3,000 | KSh 3,000–5,000 |
| One-bedroom accommodation | KSh 4,000 | KSh 4,000–5,000 |
| Two-bedroom accommodation | KSh 8,000 | KSh 8,000–10,000 |

A booking request calculates days as the check-out date minus check-in date, stores a pending request, returns a reference, and prevents duplicate submissions with an idempotency key. It is not a reservation. The admin must confirm exact property, price, and availability directly with the guest. Customer status access uses a 7-day HttpOnly cookie; only a hash of the per-request token is stored. `BOOKING_ACCESS_SECRET` must remain stable between restarts so existing customer request links keep working.

## M-Pesa

The Daraja adapter is implemented and verified with mocked provider responses only; no live or sandbox credentials were available, so no real payment was attempted. It supports OAuth, STK Push, provider status query, idempotency, and a secret-token callback route. A payment can start only for a privately accessed, administrator-confirmed booking with an exact total in its estimate range. A booking/payment status changes to succeeded only after the callback is authenticated and the provider query, receipt, amount, and customer phone match the stored attempt.

For sandbox testing, first obtain Daraja sandbox credentials and confirm the shortcode/passkey and transaction type with Safaricom. Configure `MPESA_ENV=sandbox`, `MPESA_TRANSACTION_TYPE` (`CustomerPayBillOnline` or `CustomerBuyGoodsOnline`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_TOKEN` (at least 32 random characters), and `MPESA_CALLBACK_URL` as the public URL ending in `/api/payments/mpesa/callback`. The server appends the callback token to that URL. Provide a reachable HTTPS callback host for production; the local callback cannot be reached by Safaricom. Test STK success, cancellation, timeout, duplicate callbacks, receipt reuse, wrong amount/phone, and network failure in sandbox before enabling live credentials.

For live M-Pesa, the business must complete Safaricom merchant onboarding/approval, obtain production keys and shortcode/passkey, register the exact public HTTPS callback URL, set `MPESA_ENV=production`, and protect/rotate secrets using the hosting platform’s secret manager. Do not advertise online payment until a real provider approval and end-to-end production-like test has passed. Bank payments are not implemented.

## Cloudflare deployment

Cloudflare Workers can serve the static site and API from `workers/index.js`. Worker assets are built into `dist/`; D1 provides the SQLite-compatible database, and R2 stores property photos. The Worker uses `wrangler.jsonc` to create the D1 database and R2 bucket on first deploy.

1. Sign in locally with `npx wrangler login`.
2. Set `ADMIN_PASSWORD` and `BOOKING_ACCESS_SECRET` with `npx wrangler secret put ADMIN_PASSWORD` and `npx wrangler secret put BOOKING_ACCESS_SECRET`. Enter secret values directly into the CLI prompt. The password must be at least 14 characters and the booking secret at least 32 random characters.
3. Run `npm run cloudflare:deploy`. Wrangler builds the static assets and deploys the Worker, D1 database, and R2 bucket.
4. Verify `/api/health`, `/admin`, property photo upload, and booking flows on the generated `workers.dev` URL before attaching a custom domain.

For local Worker development, copy `.dev.vars.example` to `.dev.vars`, enter local-only secret values, then run `npm run cloudflare:dev`. Never commit `.dev.vars`.

Cloudflare D1 starts empty; local SQLite records and uploaded files are not migrated automatically. Add only approved listings and photos to the Cloudflare deployment. Live M-Pesa requires a reachable HTTPS callback and provider-approved credentials; do not enable it for public testing without those checks.

## Vercel client preview

The Vercel function at `api/index.js` serves the same API routes as the local Node server. A rewrite forwards all `/api/*` paths to this entrypoint while preserving the original route path. It uses Neon PostgreSQL for listings, booking requests, prices, payments, audit records, and administrator sessions; Vercel Blob stores approved property photos. The PostgreSQL schema is initialized idempotently when the API first starts. Vercel does not use the local SQLite file or `storage/property-images/` directory.

1. Link the repository to a Vercel project and add a Neon database and Vercel Blob store.
2. Configure these values in Vercel Project Settings for the Preview environment: `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `ADMIN_PASSWORD` (a unique value of at least 14 characters), and `BOOKING_ACCESS_SECRET` (at least 32 random characters). Keep the values private and stable between deployments.
3. Deploy a Preview build and test the public catalog, `/admin` login, property creation/photo upload, booking requests, and admin updates. Do not configure live M-Pesa credentials for client preview.

The hosted database starts empty; local SQLite records and ignored uploaded files are not copied to Vercel. Add only client-approved test listings and photos to the Preview environment. Use separate Preview and Production credentials and storage where possible.

For production, set `NODE_ENV=production`, use unique production secrets, configure a verified `PUBLIC_SITE_URL`, and complete M-Pesa merchant onboarding and callback verification before enabling payments. Back up hosted data and review Neon/Blob retention and access settings before launch.

Property inventory and exact prices remain business-managed data. Add only approved property photos and verified descriptions/amenities. The featured image at `images/hotel.jpg` is the supplied business image; confirm its visible signage is appropriate for the featured accommodation before publication.
