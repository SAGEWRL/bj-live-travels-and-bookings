import { buildWhatsAppUrl } from './booking-form.js';

const form = document.querySelector('#booking-request-form');
const alert = document.querySelector('#booking-alert');
const layout = document.querySelector('.booking-layout');
const review = document.querySelector('#booking-review');
const summary = document.querySelector('#booking-summary');
const preview = document.querySelector('#estimate-preview');
const reviewAlert = document.querySelector('#review-alert');
const paymentPanel = document.querySelector('#booking-payment-panel');
const rates = new Map();
let properties = [];
let selectedEstimate = null;
let submittedPayloadSignature = '';
let idempotencyKey = '';
let submitting = false;
let statusRefreshTimer;

function money(value) {
  return `KSh ${Number(value).toLocaleString('en-KE')}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || 'The request could not be completed.');
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

function clearErrors() {
  form.querySelectorAll('[data-error-for]').forEach((node) => { node.textContent = ''; });
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute('aria-invalid'));
  alert.hidden = true;
  alert.textContent = '';
  reviewAlert.hidden = true;
  reviewAlert.textContent = '';
}

function showError(message, fieldName) {
  if (!review.hidden) {
    reviewAlert.textContent = message;
    reviewAlert.hidden = false;
    return;
  }
  alert.textContent = message;
  alert.hidden = false;
  if (!fieldName) return;
  const field = form.elements.namedItem(fieldName);
  const fieldError = form.querySelector(`[data-error-for="${fieldName}"]`);
  field?.setAttribute('aria-invalid', 'true');
  if (fieldError) fieldError.textContent = message;
  field?.focus();
}

function daysBetween(checkIn, checkOut) {
  return (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function currentValues() {
  return Object.fromEntries(new FormData(form));
}

function calculateEstimate(values) {
  const rate = rates.get(values.accommodationType);
  const durationDays = daysBetween(values.checkIn, values.checkOut);
  if (!rate || !Number.isInteger(durationDays) || durationDays < 1) return null;

  const property = properties.find((item) => item.id === values.propertyId);
  if (property?.priceConfirmed) {
    return {
      durationDays,
      minimum: property.dailyPriceKes * durationDays,
      maximum: property.dailyPriceKes * durationDays,
      dailyMinimum: property.dailyPriceKes,
      dailyMaximum: property.dailyPriceKes,
      priceConfirmed: true,
      property,
    };
  }

  return {
    durationDays,
    minimum: rate.minimumPriceKes * durationDays,
    maximum: rate.maximumPriceKes * durationDays,
    dailyMinimum: rate.minimumPriceKes,
    dailyMaximum: rate.maximumPriceKes,
    priceConfirmed: false,
    property,
  };
}

function updatePreview() {
  const values = currentValues();
  const estimate = calculateEstimate(values);
  if (!estimate) {
    preview.textContent = 'Select an accommodation type and valid dates to see a cost estimate.';
    return;
  }
  const amount = estimate.minimum === estimate.maximum
    ? money(estimate.minimum)
    : `${money(estimate.minimum)}–${money(estimate.maximum)}`;
  preview.textContent = `Estimated ${estimate.durationDays} ${estimate.durationDays === 1 ? 'day' : 'days'}: ${amount}. ${estimate.priceConfirmed ? 'Property daily rate configured by Marevia.' : 'Range estimate; confirm the exact property rate with Marevia.'}`;
}

async function loadProperties(selectedId = '') {
  const location = form.elements.namedItem('location').value;
  const propertySelect = form.elements.namedItem('propertyId');
  const previous = selectedId || propertySelect.value;
  propertySelect.replaceChildren(new Option('No specific property yet', ''));
  if (!location) {
    properties = [];
    updatePreview();
    return;
  }

  const params = new URLSearchParams({ location, guests: form.elements.namedItem('guests').value || '1', sort: 'price-asc' });
  const checkIn = form.elements.namedItem('checkIn').value;
  const checkOut = form.elements.namedItem('checkOut').value;
  if (validDate(checkIn) && validDate(checkOut) && daysBetween(checkIn, checkOut) > 0) {
    params.set('checkIn', checkIn);
    params.set('checkOut', checkOut);
  }
  const result = await api(`/api/properties?${params}`);
  properties = result.properties;
  for (const property of properties) {
    propertySelect.add(new Option(`${property.name} · ${property.accommodationType}`, property.id));
  }
  if (properties.some((property) => property.id === previous)) propertySelect.value = previous;
  updatePreview();
}

function renderSummary(values, estimate) {
  summary.replaceChildren();
  const amount = estimate.minimum === estimate.maximum
    ? money(estimate.minimum)
    : `${money(estimate.minimum)}–${money(estimate.maximum)}`;
  const rows = [
    ['Location', values.location],
    ['Accommodation', values.accommodationType],
    ['Property', estimate.property?.name || 'Marevia will arrange a suitable property'],
    ['Dates', `${values.checkIn} to ${values.checkOut}`],
    ['Duration', `${estimate.durationDays} ${estimate.durationDays === 1 ? 'day' : 'days'}`],
    ['Guests', String(values.guests)],
    ['Daily rate', estimate.dailyMinimum === estimate.dailyMaximum ? `${money(estimate.dailyMinimum)} per day` : `${money(estimate.dailyMinimum)}–${money(estimate.dailyMaximum)} per day`],
    ['Estimated accommodation total', amount],
    ['Name', values.customerName],
    ['Phone', values.customerPhone],
  ];
  if (values.customerEmail) rows.push(['Email', values.customerEmail]);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    summary.append(row);
  }
  selectedEstimate = estimate;
}

function validate(values) {
  if (!values.location) return ['Choose a location.', 'location'];
  if (!rates.has(values.accommodationType)) return ['Choose an accommodation type.', 'accommodationType'];
  if (!validDate(values.checkIn) || !validDate(values.checkOut) || !Number.isInteger(daysBetween(values.checkIn, values.checkOut)) || daysBetween(values.checkIn, values.checkOut) < 1) {
    return ['Check-out must be after check-in.', 'checkOut'];
  }
  const guests = Number(values.guests);
  if (!Number.isSafeInteger(guests) || guests < 1 || guests > 30) return ['Guest count must be between 1 and 30.', 'guests'];
  const property = properties.find((item) => item.id === values.propertyId);
  if (values.propertyId && !property) return ['Choose a property from the selected location, or select no specific property.', 'propertyId'];
  if (property && guests > property.guestCapacity) return [`This property lists capacity for ${property.guestCapacity} guests.`, 'guests'];
  if (!values.customerName.trim()) return ['Enter your name.', 'customerName'];
  if (!/^\+?[0-9 ()-]{9,20}$/.test(values.customerPhone.trim())) return ['Enter a valid phone number.', 'customerPhone'];
  if (values.customerEmail && !/^\S+@\S+\.\S+$/.test(values.customerEmail)) return ['Enter a valid email address or leave it blank.', 'customerEmail'];
  return null;
}

function showConfirmation(booking, values, estimate) {
  document.querySelector('#review-kicker').textContent = 'Request submitted';
  document.querySelector('#review-title').textContent = `Request ${booking.reference}`;
  document.querySelector('#review-disclaimer').textContent = 'Your booking request has been received and is pending review. This is not a confirmed reservation. Marevia must confirm the property, final price, and availability before payment.';
  summary.appendChild((() => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = 'Request status';
    detail.textContent = booking.status;
    row.append(term, detail);
    return row;
  })());
  document.querySelector('#review-actions').hidden = true;
  const confirmationActions = document.querySelector('#confirmation-actions');
  const whatsappLink = document.querySelector('#booking-whatsapp-link');
  const targetPhone = values.whatsappNumber || '0735 109 066';
  const enquiryUrl = new URL(buildWhatsAppUrl({
    enquiryType: values.accommodationType,
    destination: `${values.location}${estimate.property ? ` · ${estimate.property.name}` : ''}`,
    arrivalDate: values.checkIn,
    departureDate: values.checkOut,
    partySize: values.guests,
    name: values.customerName,
    contact: values.customerPhone,
    notes: `Request ${booking.reference}. Estimated accommodation total: ${booking.estimatedMinimumKes === booking.estimatedMaximumKes ? money(booking.estimatedMinimumKes) : `${money(booking.estimatedMinimumKes)} to ${money(booking.estimatedMaximumKes)}`}. Availability and final price require confirmation.`,
  }, targetPhone));
  whatsappLink.href = enquiryUrl.toString();
  confirmationActions.hidden = false;
  paymentPanel.hidden = false;
  document.querySelector('#booking-payment-form').hidden = true;
  document.querySelector('#refresh-booking-status').hidden = false;
  document.querySelector('#booking-payment-message').textContent = 'Marevia must confirm the property, exact amount, and availability before any payment prompt can be requested.';
  document.querySelector('#payment-phone').value = values.customerPhone;
  const url = new URL(window.location.href);
  url.searchParams.set('reference', booking.reference);
  window.history.replaceState({}, '', url);
  form.closest('.booking-layout').hidden = true;
  review.hidden = false;
  review.scrollIntoView({ behavior: 'smooth', block: 'start' });
  void refreshBookingStatus(booking.reference);
}

function renderCustomerBookingStatus(booking, payments = []) {
  const statusRow = [...summary.children].find((row) => row.querySelector('dt')?.textContent === 'Request status');
  if (statusRow) statusRow.querySelector('dd').textContent = booking.status;
  else {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = 'Request status';
    term.dataset.bookingStatus = 'label';
    detail.textContent = booking.status;
    row.append(term, detail);
    summary.append(row);
  }

  paymentPanel.hidden = false;
  const message = document.querySelector('#booking-payment-message');
  const paymentForm = document.querySelector('#booking-payment-form');
  const paymentStatus = document.querySelector('#payment-status');
  const refresh = document.querySelector('#refresh-booking-status');
  const title = document.querySelector('#booking-payment-title');
  const phone = document.querySelector('#payment-phone');
  if (booking.customerPhone) phone.value = booking.customerPhone;
  refresh.hidden = false;

  if (booking.status === 'declined' || booking.status === 'cancelled') {
    title.textContent = booking.status === 'declined' ? 'Booking request declined' : 'Booking request cancelled';
    message.textContent = booking.status === 'declined'
      ? 'Marevia was unable to accept this request. Contact us if you would like help with another stay.'
      : 'This booking request has been cancelled. Contact Marevia if you need assistance.';
    paymentForm.hidden = true;
    paymentStatus.textContent = '';
    return;
  }

  if (booking.status === 'pending' || booking.status === 'reviewing') {
    title.textContent = booking.status === 'reviewing' ? 'Request under review' : 'Request received';
    message.textContent = booking.status === 'reviewing'
      ? 'Marevia is reviewing your request. This page will show the decision when it is available.'
      : 'Your request is awaiting review. This page will show the decision when it is available.';
    paymentForm.hidden = true;
    paymentStatus.textContent = '';
    return;
  }

  if (payments.some((payment) => payment.status === 'succeeded')) {
    title.textContent = 'Payment verified';
    message.textContent = 'M-Pesa payment success was verified with the provider.';
    paymentForm.hidden = true;
    paymentStatus.textContent = 'Payment recorded.';
    return;
  }
  if (payments.some((payment) => payment.status === 'pending')) {
    title.textContent = 'Payment in progress';
    message.textContent = 'A payment prompt is in progress. Check your phone and wait for provider verification.';
    paymentForm.hidden = true;
    paymentStatus.textContent = 'The booking status changes only after M-Pesa verification.';
    return;
  }
  if (payments.some((payment) => payment.status === 'failed')) {
    title.textContent = 'Payment not completed';
    message.textContent = 'No successful payment was verified. Check with your bank or M-Pesa before starting another attempt.';
    void api('/api/payments/mpesa/config').then((configuration) => {
      paymentForm.hidden = !configuration.configured;
      paymentStatus.textContent = configuration.configured
        ? 'You can request a new prompt after checking your M-Pesa messages.'
        : 'Contact Marevia to arrange a verified payment method.';
    }).catch((error) => {
      paymentForm.hidden = true;
      paymentStatus.textContent = error.message;
    });
    return;
  }
  if (booking.status !== 'confirmed' || !booking.confirmedAmountKes) {
    title.textContent = 'Payment follows confirmation';
    message.textContent = 'Marevia must confirm this request, property, availability, and exact amount before payment.';
    paymentForm.hidden = true;
    paymentStatus.textContent = '';
    return;
  }

  title.textContent = 'Confirmed total';
  message.textContent = `Marevia confirmed ${money(booking.confirmedAmountKes)} for this request. Confirm this amount with the business before continuing.`;
  const estimateRange = `${money(booking.estimatedMinimumKes)}–${money(booking.estimatedMaximumKes)}`;
  if (booking.confirmedAmountKes < booking.estimatedMinimumKes || booking.confirmedAmountKes > booking.estimatedMaximumKes) {
    paymentForm.hidden = true;
    paymentStatus.textContent = `The confirmed amount is outside the original estimate range (${estimateRange}). Contact Marevia.`;
    return;
  }
  void api('/api/payments/mpesa/config').then((configuration) => {
    paymentForm.hidden = !configuration.configured;
    paymentStatus.textContent = configuration.configured
      ? 'If you continue, an M-Pesa prompt is sent to the number above. Never share your PIN.'
      : 'Online M-Pesa payment is not configured yet. Contact Marevia to arrange a verified payment method.';
  }).catch((error) => {
    paymentForm.hidden = true;
    paymentStatus.textContent = error.message;
  });
}

async function refreshBookingStatus(reference = new URLSearchParams(window.location.search).get('reference')) {
  if (!reference) return;
  window.clearTimeout(statusRefreshTimer);
  try {
    const result = await api(`/api/bookings/${encodeURIComponent(reference)}`);
    const booking = result.booking;
    const whatsapp = document.querySelector('#booking-whatsapp-link');
    whatsapp.href = buildWhatsAppUrl({
      enquiryType: booking.accommodationType,
      destination: booking.location,
      arrivalDate: booking.checkIn,
      departureDate: booking.checkOut,
      partySize: booking.guests,
      name: booking.customerName,
      contact: booking.customerPhone,
      notes: `Request ${booking.reference}. Status: ${booking.status}. ${booking.confirmedAmountKes ? `Guest-agreed total: ${money(booking.confirmedAmountKes)}.` : 'Exact price and availability require confirmation.'}`,
    }, '0735 109 066');
    const statusCopy = {
      pending: ['Request received', 'Your request is awaiting review. This page will show the decision when it is available.'],
      reviewing: ['Request under review', 'Marevia is reviewing your booking request. This page will show the decision when it is available.'],
      confirmed: ['Booking accepted', `Marevia accepted your booking request${booking.confirmedAmountKes ? ` for ${money(booking.confirmedAmountKes)}` : ''}. Payment is separate and is not complete until verified by the provider.`],
      declined: ['Booking declined', 'Marevia was unable to accept this request. Contact us if you would like help with another stay.'],
      cancelled: ['Booking cancelled', 'This booking request has been cancelled. Contact Marevia if you need assistance.'],
    }[booking.status] || ['Request status', 'Your booking request status has been updated.'];
    document.querySelector('#review-kicker').textContent = `Request ${booking.reference}`;
    document.querySelector('#review-title').textContent = statusCopy[0];
    document.querySelector('#review-disclaimer').textContent = statusCopy[1];
    const referenceRow = [...summary.children].find((row) => row.querySelector('dt')?.textContent === 'Request status');
    if (!referenceRow) {
      summary.replaceChildren();
      const rows = [
        ['Location', booking.location],
        ['Accommodation', booking.accommodationType],
        ['Dates', `${booking.checkIn} to ${booking.checkOut}`],
        ['Duration', `${booking.durationDays} days`],
        ['Guests', String(booking.guests)],
        ['Estimate', booking.estimatedMinimumKes === booking.estimatedMaximumKes
          ? money(booking.estimatedMinimumKes)
          : `${money(booking.estimatedMinimumKes)}–${money(booking.estimatedMaximumKes)}`],
        ['Request status', booking.status],
      ];
      rows.forEach(([label, value]) => {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        term.textContent = label;
        detail.textContent = value;
        row.append(term, detail);
        summary.append(row);
      });
    }
    renderCustomerBookingStatus(booking, result.payments);
    document.querySelector('#review-actions').hidden = true;
    document.querySelector('#confirmation-actions').hidden = false;
    layout.hidden = true;
    review.hidden = false;
    if (booking.status === 'pending' || booking.status === 'reviewing') {
      statusRefreshTimer = window.setTimeout(() => refreshBookingStatus(reference), 20000);
    }
  } catch (error) {
    paymentPanel.hidden = false;
    document.querySelector('#booking-payment-message').textContent = error.message;
    document.querySelector('#booking-payment-form').hidden = true;
    document.querySelector('#booking-payment-title').textContent = 'Request link unavailable';
    document.querySelector('#refresh-booking-status').hidden = true;
  }
}

form.addEventListener('input', () => { clearErrors(); updatePreview(); });
form.addEventListener('change', () => { clearErrors(); updatePreview(); });
form.elements.namedItem('checkIn').addEventListener('change', (event) => {
  if (!event.target.value) {
    form.elements.namedItem('checkOut').min = '';
    return;
  }
  const nextDay = new Date(`${event.target.value}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  form.elements.namedItem('checkOut').min = nextDay.toISOString().slice(0, 10);
});
form.elements.namedItem('location').addEventListener('change', () => {
  loadProperties().catch((error) => showError(error.message));
});
form.elements.namedItem('propertyId').addEventListener('change', updatePreview);
for (const name of ['checkIn', 'checkOut', 'guests']) {
  form.elements.namedItem(name).addEventListener('change', () => {
    if (form.elements.namedItem('location').value) loadProperties().catch((error) => showError(error.message));
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors();
  if (!form.reportValidity()) return;
  const values = currentValues();
  const invalid = validate(values);
  if (invalid) {
    showError(invalid[0], invalid[1]);
    return;
  }
  const estimate = calculateEstimate(values);
  if (!estimate) {
    showError('Choose a valid accommodation type and date range.');
    return;
  }
  document.querySelector('#review-kicker').textContent = 'Review before sending';
  document.querySelector('#review-title').textContent = 'Your stay estimate';
  document.querySelector('#review-disclaimer').textContent = estimate.priceConfirmed
    ? 'This estimate uses a property rate entered by Marevia. Dates and the final amount still require direct confirmation before payment.'
    : 'This is a range estimate based on the owner-provided daily rates. The property, exact price, and date availability must be confirmed before payment.';
  renderSummary(values, estimate);
  document.querySelector('#review-actions').hidden = false;
  document.querySelector('#confirmation-actions').hidden = true;
  form.closest('.booking-layout').hidden = true;
  review.hidden = false;
  review.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.querySelector('#edit-booking-button').addEventListener('click', () => {
  review.hidden = true;
  form.closest('.booking-layout').hidden = false;
  form.elements.namedItem('location').focus();
});

document.querySelector('#submit-booking-button').addEventListener('click', async (event) => {
  if (submitting) return;
  const values = currentValues();
  const invalid = validate(values);
  if (invalid) {
    review.hidden = true;
    form.closest('.booking-layout').hidden = false;
    showError(invalid[0], invalid[1]);
    return;
  }
  const payload = {
    location: values.location,
    accommodationType: values.accommodationType,
    propertyId: values.propertyId || undefined,
    checkIn: values.checkIn,
    checkOut: values.checkOut,
    guests: Number(values.guests),
    customerName: values.customerName.trim(),
    customerPhone: values.customerPhone.trim(),
    customerEmail: values.customerEmail.trim() || undefined,
  };
  const signature = JSON.stringify(payload);
  if (signature !== submittedPayloadSignature) {
    submittedPayloadSignature = signature;
    idempotencyKey = crypto.randomUUID();
  }

  submitting = true;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Submitting request…';
  try {
    const result = await api('/api/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    showConfirmation(result.booking, values, selectedEstimate || calculateEstimate(values));
  } catch (error) {
    showError(error.message || 'Your request was not submitted. Check your connection and retry.');
    button.textContent = 'Retry booking request';
  } finally {
    submitting = false;
    button.disabled = false;
    window.lucide?.createIcons();
  }
});

document.querySelector('#booking-payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.querySelector('#payment-button');
  const reference = new URLSearchParams(window.location.search).get('reference');
  if (!reference) {
    document.querySelector('#payment-status').textContent = 'This request link is missing its reference. Contact Marevia before payment.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Requesting prompt…';
  let paymentIdempotencyKey;
  try {
    paymentIdempotencyKey = sessionStorage.getItem(`mpesa-request-${reference}`);
    if (!paymentIdempotencyKey) {
      paymentIdempotencyKey = crypto.randomUUID();
      sessionStorage.setItem(`mpesa-request-${reference}`, paymentIdempotencyKey);
    }
  } catch {
    paymentIdempotencyKey = crypto.randomUUID();
  }
  try {
    const result = await api('/api/payments/mpesa', {
      method: 'POST',
      headers: { 'Idempotency-Key': paymentIdempotencyKey },
      body: JSON.stringify({ bookingReference: reference, customerPhone: document.querySelector('#payment-phone').value }),
    });
    button.hidden = true;
    document.querySelector('#payment-status').textContent = result.payment.customerMessage || 'M-Pesa prompt requested. Waiting for provider verification.';
    await refreshBookingStatus(reference);
  } catch (error) {
    if (['payment_attempt_failed', 'payment_provider_error'].includes(error.code)) {
      try { sessionStorage.removeItem(`mpesa-request-${reference}`); } catch { }
    }
    document.querySelector('#payment-status').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Request M-Pesa prompt';
  }
});
document.querySelector('#refresh-booking-status').addEventListener('click', () => refreshBookingStatus());

const params = new URLSearchParams(window.location.search);
for (const [key, name] of [['location', 'location'], ['type', 'accommodationType'], ['checkIn', 'checkIn'], ['checkOut', 'checkOut'], ['guests', 'guests']]) {
  if (params.has(key)) form.elements.namedItem(name).value = params.get(key);
}

try {
  const packageResult = await api('/api/packages');
  const typeSelect = form.elements.namedItem('accommodationType');
  for (const rate of packageResult.packages) {
    rates.set(rate.type, rate);
    typeSelect.add(new Option(`${rate.type} · from ${money(rate.startingPriceKes)}/day`, rate.type));
  }
  if (rates.has(params.get('type'))) typeSelect.value = params.get('type');
  const today = new Date().toISOString().slice(0, 10);
  form.elements.namedItem('checkIn').min = today;
  form.elements.namedItem('checkOut').min = today;
  if (params.has('propertyId')) await loadProperties(params.get('propertyId'));
  else if (form.elements.namedItem('location').value) await loadProperties();
  updatePreview();
} catch (error) {
  showError(`Booking service could not load: ${error.message}`);
}

if (params.has('reference')) await refreshBookingStatus(params.get('reference'));