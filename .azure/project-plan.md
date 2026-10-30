# Bjlive Travels & Bookings Project Plan

**Status**: Awaiting approval  
**Created**: 2026-10-19  
**Mode**: NEW

## Project Overview

Build a polished, mobile-first static travel website for Bjlive Travels & Bookings, based in Mombasa Airport Road, Kenya. The initial implementation uses HTML5, CSS3, and vanilla JavaScript, with local browser testing. It has no backend, persistent enquiry storage, live availability, admin dashboard, notifications, or payment processing.

Only the business name and Mombasa Airport Road location are confirmed. All other business facts remain unpublished until the business confirms them. The site must never imply that an enquiry was delivered, a booking was made, or availability or payment was confirmed.

## Implementation Scope

- Responsive sticky navigation with an accessible mobile menu.
- Full-width travel hero with approved imagery, readable overlay, and clear tour/enquiry links. Do not invent or imply destinations served.
- Homepage sections for tours and safaris, destinations, featured accommodation, hotel/Airbnb enquiries, ticketing, airport transfers, travel packages, FAQs, location, contact, and footer.
- Use `images/hotel.jpg` only after the authorized client photo is supplied. Until then, show a neutral visual placeholder. Use other destination imagery only when approved for use.
- Do not populate package search or filters with invented listings; only activate these controls when verified records exist.
- Enquiry form with service, destination, dates, traveller count, name, and preferred contact fields, with accessible client-side validation and a local draft review state. It must not transmit or persist personal data.
- Keep WhatsApp handoff disabled until the official business number is confirmed and configured. When enabled in a future approved update, the customer must review and send the prepared message; the handoff is not a reservation.
- Include genuine testimonials or FAQ answers only when supplied and approved.
- Respect reduced-motion preferences, keyboard access, mobile layouts, semantic HTML, and fast local loading.

## Business Accuracy

Confirmed for publication:

| Detail | Confirmed value |
|---|---|
| Business name | Bjlive Travels & Bookings |
| Location | Mombasa Airport Road, Kenya |

Do not invent or publish phone numbers, WhatsApp number, exact street address or map pin, hotel name/address, room types, amenities, prices, availability, reviews, affiliations, email, social accounts, opening hours, specific packages, or policy answers. Keep these absent until verified; do not display fake placeholder contact values.

## Technology and Local Validation

| Concern | Choice |
|---|---|
| Frontend | Static HTML5, CSS3, vanilla JavaScript |
| Backend/data | None in this phase |
| Dependencies | Avoid runtime dependencies; use native browser APIs |
| Local test command | `npm test` with Node.js built-in `node:test` for form logic |
| Browser check | Run the site locally and verify navigation, responsive layout, form validation, and disabled WhatsApp behavior |

No Azure resources, database, login, API, deployment, or secrets are needed for this phase.

## Project Structure

```text
.
├── .azure/
│   └── project-plan.md
├── images/
│   └── hotel.jpg                 # Add after receiving the authorized client photo
├── tests/
│   └── booking-form.test.js
├── index.html
├── styles.css
├── script.js
├── package.json                  # Local node:test command
└── README.md                     # Local run and verified-content guidance
```

## Acceptance Checks

- The homepage renders as a complete, responsive travel website and includes the requested sections.
- The only unqualified business claims are the confirmed business name and Mombasa Airport Road location.
- The hotel image is not represented as supplied until `images/hotel.jpg` is present and authorized.
- The enquiry form validates input and presents a local draft without sending or storing it.
- WhatsApp handoff is inactive until a confirmed number is configured.
- Navigation works by keyboard and touch; motion respects reduced-motion settings.
- `npm test` passes, and the page is manually checked at desktop and mobile widths.

## Later Phases, Not Included

Secure backend and enquiry database, staff authentication and admin dashboard, package management, live availability integrations, email/SMS notifications, M-Pesa/card payments, public deployment, and custom domain setup are separate future work. They require explicit scope, verified providers, and security review before being presented as functional.

## Next Step

Review and approve this plan in the plan view. After approval, scaffold the static frontend and validate it locally. Do not start implementation until the plan is approved.
