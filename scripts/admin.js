window.lucide?.createIcons();

const loginPanel = document.querySelector('#login-panel');
const adminPanel = document.querySelector('#admin-panel');
const loginForm = document.querySelector('#login-form');
const propertyForm = document.querySelector('#property-form');
const propertyList = document.querySelector('#property-list');
const notice = document.querySelector('#admin-notice');
const logoutButton = document.querySelector('#logout-button');
let packages = [];
let properties = [];

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'The request could not be completed.');
  return result;
}

function showNotice(message, kind = 'success') {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function money(value) {
  return `KSh ${Number(value).toLocaleString('en-KE')}`;
}

function guestMessageUrl(booking, status) {
  const phone = booking.customerPhone.replace(/\D/g, '');
  const internationalPhone = phone.startsWith('0') ? `254${phone.slice(1)}` : phone;
  const message = status === 'confirmed'
    ? `Hello ${booking.customerName}, your booking request ${booking.reference} has been accepted for ${booking.location}. The confirmed total is ${money(booking.confirmedAmountKes)}. Please reply if you have any questions.`
    : `Hello ${booking.customerName}, we are sorry but Marevia is unable to accept booking request ${booking.reference} for ${booking.location}. Please contact us if you would like help with another stay.`;
  return `https://wa.me/${internationalPhone}?text=${encodeURIComponent(message)}`;
}

function showLogin(configured) {
  loginPanel.hidden = false;
  adminPanel.hidden = true;
  logoutButton.hidden = true;
  document.querySelector('#admin-setup-note').textContent = configured
    ? 'Sign in with the administrator password configured on this server.'
    : 'Admin login is disabled. Set ADMIN_PASSWORD to at least 14 characters in the server environment, then restart the site.';
  loginForm.querySelector('button[type="submit"]').disabled = !configured;
}

async function enterAdmin() {
  loginPanel.hidden = true;
  adminPanel.hidden = false;
  logoutButton.hidden = false;
  showNotice('Loading business records…');
  await Promise.all([loadProperties(), loadPackages()]);
  await Promise.all([loadBookings(), loadPayments()]);
  showNotice('Business records are up to date.');
}

function propertyPayload(form) {
  const values = new FormData(form);
  return {
    name: values.get('name'),
    location: values.get('location'),
    accommodationType: values.get('accommodationType'),
    dailyPriceKes: Number(values.get('dailyPriceKes')),
    guestCapacity: Number(values.get('guestCapacity')),
    bedrooms: values.get('bedrooms') || null,
    bathrooms: values.get('bathrooms') || null,
    description: values.get('description'),
    amenities: String(values.get('amenities') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    availabilityStatus: values.get('availabilityStatus'),
    priceConfirmed: values.has('priceConfirmed'),
    published: values.has('published'),
  };
}

function resetPropertyForm() {
  propertyForm.reset();
  propertyForm.elements.namedItem('id').value = '';
  document.querySelector('#property-form-title').textContent = 'New property';
  propertyForm.hidden = true;
}

function renderProperty(property) {
  const card = element('article', 'admin-record');
  const head = element('div', 'admin-record-head');
  const summary = document.createElement('div');
  summary.append(element('h3', '', property.name));
  summary.append(element('p', 'admin-record-meta', `${property.location} · ${property.accommodationType} · ${property.guestCapacity} guests`));
  const status = element('span', 'admin-status-pill', property.published ? 'Published' : 'Unpublished');
  status.dataset.status = property.published ? 'published' : 'unpublished';
  head.append(summary, status);
  card.append(head);
  card.append(element('p', 'admin-record-meta', `${money(property.dailyPriceKes)} per day · ${property.priceConfirmed ? 'price confirmed' : 'price needs confirmation'} · availability ${property.availabilityStatus}`));

  const photos = element('div', 'admin-record-photos');
  for (const photo of property.photos) {
    const figure = document.createElement('figure');
    const isVideo = /\.(mp4|webm|mov)$/i.test(photo);
    const media = isVideo ? document.createElement('video') : document.createElement('img');
    media.src = photo;
    if (isVideo) {
      media.controls = true;
      media.preload = 'metadata';
      media.playsInline = true;
      media.setAttribute('aria-label', `${property.name} property video`);
    } else {
      media.alt = `${property.name} property photo`;
      media.loading = 'lazy';
    }
    const remove = element('button', '', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove property media');
    remove.dataset.removePhoto = photo;
    figure.append(media, remove);
    photos.append(figure);
  }
  if (property.photos.length) card.append(photos);

  const controls = element('div', 'admin-record-controls');
  const edit = element('button', 'admin-button', 'Edit');
  edit.type = 'button';
  edit.dataset.editProperty = property.id;
  const upload = element('button', 'admin-button', 'Upload gallery media');
  upload.type = 'button';
  const uploadIcon = document.createElement('i');
  uploadIcon.dataset.lucide = 'images';
  uploadIcon.setAttribute('aria-hidden', 'true');
  upload.prepend(uploadIcon);
  const mediaInput = document.createElement('input');
  mediaInput.type = 'file';
  mediaInput.accept = 'image/jpeg,image/png,image/webp,video/mp4,video/webm';
  mediaInput.multiple = true;
  mediaInput.hidden = true;
  mediaInput.setAttribute('aria-label', `Choose gallery media for ${property.name}`);
  upload.addEventListener('click', () => mediaInput.click());
  mediaInput.addEventListener('change', async () => {
    const files = [...mediaInput.files];
    if (!files.length) return;
    upload.disabled = true;
    try {
      for (const file of files) {
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is larger than 4 MB.`);
        await request(`/api/admin/properties/${property.id}/photos`, {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type },
        });
      }
      showNotice(`${files.length} gallery item${files.length === 1 ? '' : 's'} uploaded for ${property.name}.`);
      await loadProperties();
    } catch (error) {
      showNotice(error.message, 'error');
      await loadProperties().catch(() => {});
    } finally {
      mediaInput.value = '';
      upload.disabled = false;
    }
  });
  const remove = element('button', 'admin-button admin-button-quiet', 'Remove');
  remove.type = 'button';
  remove.dataset.deleteProperty = property.id;
  controls.append(edit, upload, remove, mediaInput);
  card.append(controls);

  const details = document.createElement('details');
  const summaryLabel = document.createElement('summary');
  summaryLabel.textContent = 'Manage blocked dates';
  details.append(summaryLabel);
  const dateForm = element('form', 'admin-block-form');
  dateForm.dataset.blockProperty = property.id;
  for (const [label, name] of [['From', 'startsOn'], ['Until', 'endsOn']]) {
    const field = element('label', '', label);
    const input = document.createElement('input');
    input.type = 'date';
    input.name = name;
    input.required = true;
    field.append(input);
    dateForm.append(field);
  }
  const addBlock = element('button', 'admin-button', 'Block dates');
  addBlock.type = 'submit';
  dateForm.append(addBlock);
  details.append(dateForm, element('div', 'admin-block-list', 'Open to load blocked dates.'));
  details.addEventListener('toggle', () => {
    if (details.open) void loadBlocks(property.id, details.querySelector('.admin-block-list'));
  });
  card.append(details);
  return card;
}

async function loadProperties() {
  const result = await request('/api/admin/properties');
  properties = result.properties;
  propertyList.replaceChildren();
  if (!properties.length) {
    propertyList.append(element('p', 'admin-empty', 'No properties yet. Add a verified listing to publish it after review.'));
  } else {
    properties.forEach((property) => propertyList.append(renderProperty(property)));
  }
  window.lucide?.createIcons();
}

async function loadPackages() {
  const result = await request('/api/admin/packages');
  packages = result.packages;
  const typeSelect = propertyForm.elements.namedItem('accommodationType');
  typeSelect.replaceChildren(new Option('Choose type', ''));
  packages.forEach((item) => typeSelect.add(new Option(item.type, item.type)));

  const rows = document.querySelector('#rate-rows');
  rows.replaceChildren();
  packages.forEach((item) => {
    const row = element('div', 'admin-rate-row');
    row.dataset.packageType = item.type;
    row.append(element('span', '', item.type));
    for (const [key, value, label] of [
      ['startingPriceKes', item.startingPriceKes, 'Starting price'],
      ['minimumPriceKes', item.minimumPriceKes, 'Minimum price'],
      ['maximumPriceKes', item.maximumPriceKes, 'Maximum price'],
    ]) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '100';
      input.max = '1000000';
      input.step = '1';
      input.required = true;
      input.value = String(value);
      input.dataset.priceKey = key;
      input.setAttribute('aria-label', `${item.type} ${label}`);
      row.append(input);
    }
    row.append(element('span', 'admin-rate-unit', 'per day'));
    rows.append(row);
  });
}

function renderBookings(bookings) {
  const tbody = document.querySelector('#booking-rows');
  tbody.replaceChildren();
  if (!bookings.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 9;
    cell.textContent = 'No booking requests have been received.';
    return;
  }
  for (const booking of bookings) {
    const row = tbody.insertRow();
    const reference = row.insertCell();
    reference.textContent = booking.reference;
    reference.append(element('small', '', `${booking.location} · ${booking.accommodationType}`));
    const dates = row.insertCell();
    dates.textContent = `${booking.checkIn} to ${booking.checkOut}`;
    dates.append(element('small', '', `${booking.durationDays} days · ${booking.guests} guests`));
    const guest = row.insertCell();
    guest.textContent = booking.customerName;
    guest.append(element('small', '', booking.customerPhone));
    const estimate = row.insertCell();
    estimate.textContent = booking.estimatedMinimumKes === booking.estimatedMaximumKes
      ? money(booking.estimatedMinimumKes)
      : `${money(booking.estimatedMinimumKes)}–${money(booking.estimatedMaximumKes)}`;
    estimate.append(element('small', '', 'Estimate only'));
    const propertyCell = row.insertCell();
    const propertySelect = document.createElement('select');
    propertySelect.setAttribute('aria-label', `Property for ${booking.reference}`);
    propertySelect.dataset.bookingProperty = booking.id;
    propertySelect.add(new Option('Choose property', '', false, !booking.propertyId));
    properties
      .filter((property) => property.location === booking.location
        && property.accommodationType === booking.accommodationType
        && property.guestCapacity >= booking.guests
        && (property.published || property.id === booking.propertyId))
      .forEach((property) => propertySelect.add(new Option(property.name, property.id, false, property.id === booking.propertyId)));
    propertyCell.append(propertySelect);
    const confirmedAmount = row.insertCell();
    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = String(booking.estimatedMinimumKes);
    amountInput.max = String(booking.estimatedMaximumKes);
    amountInput.step = '1';
    amountInput.value = booking.confirmedAmountKes ? String(booking.confirmedAmountKes) : '';
    amountInput.placeholder = `${booking.estimatedMinimumKes}–${booking.estimatedMaximumKes}`;
    amountInput.dataset.confirmedAmount = booking.id;
    amountInput.setAttribute('aria-label', `Guest-agreed total in KSh for ${booking.reference}`);
    confirmedAmount.append(amountInput);
    const statusCell = row.insertCell();
    const status = document.createElement('select');
    status.setAttribute('aria-label', `Status for ${booking.reference}`);
    for (const value of ['pending', 'reviewing', 'confirmed', 'declined', 'cancelled']) {
      status.add(new Option(value[0].toUpperCase() + value.slice(1), value, false, value === booking.status));
    }
    status.dataset.bookingStatus = booking.id;
    statusCell.append(status);
    row.insertCell().textContent = new Date(booking.createdAt).toLocaleDateString();
    const messageCell = row.insertCell();
    const messageLink = element('a', 'admin-guest-message', 'WhatsApp guest');
    messageLink.href = guestMessageUrl(booking, booking.status);
    messageLink.target = '_blank';
    messageLink.rel = 'noopener noreferrer';
    messageLink.dataset.guestMessage = booking.id;
    messageLink.setAttribute('aria-label', `Prepare a WhatsApp message for ${booking.customerName}`);
    messageLink.hidden = !['confirmed', 'declined'].includes(booking.status);
    messageCell.append(messageLink);
  }
}

async function loadBookings() {
  const result = await request('/api/admin/bookings');
  renderBookings(result.bookings);
}

async function loadPayments() {
  const result = await request('/api/admin/payments');
  const tbody = document.querySelector('#payment-rows');
  tbody.replaceChildren();
  if (!result.payments.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.textContent = 'No payment attempts have been recorded.';
    return;
  }
  for (const payment of result.payments) {
    const row = tbody.insertRow();
    row.insertCell().textContent = payment.public_reference;
    row.insertCell().textContent = payment.provider;
    row.insertCell().textContent = money(payment.amount_kes);
    row.insertCell().textContent = payment.status;
    row.insertCell().textContent = new Date(payment.created_at).toLocaleDateString();
  }
}

async function loadBlocks(propertyId, container) {
  try {
    const result = await request(`/api/admin/properties/${propertyId}/availability`);
    container.replaceChildren();
    if (!result.blocks.length) container.append(element('span', '', 'No blocked date ranges.'));
    for (const block of result.blocks) {
      const row = element('div', 'admin-block-row');
      row.append(element('span', '', `${block.starts_on} to ${block.ends_on} · ${block.reason}`));
      const remove = element('button', '', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await request(`/api/admin/properties/${propertyId}/availability/${block.id}`, { method: 'DELETE' });
          await loadBlocks(propertyId, container);
          showNotice('Blocked dates removed.');
        } catch (error) { showNotice(error.message, 'error'); }
      });
      row.append(remove);
      container.append(row);
    }
  } catch (error) { container.textContent = error.message; }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const password = new FormData(loginForm).get('password');
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    loginForm.reset();
    await enterAdmin();
  } catch (error) { showNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

logoutButton.addEventListener('click', async () => {
  try {
    await request('/api/admin/logout', { method: 'POST', body: '{}' });
    showLogin(true);
    showNotice('You have signed out.');
  } catch (error) { showNotice(error.message, 'error'); }
});

document.querySelector('#new-property-button').addEventListener('click', () => {
  resetPropertyForm();
  propertyForm.hidden = false;
  propertyForm.elements.namedItem('name').focus();
});
document.querySelector('#close-property-form').addEventListener('click', resetPropertyForm);
document.querySelector('#cancel-property-form').addEventListener('click', resetPropertyForm);

propertyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = propertyForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const id = propertyForm.elements.namedItem('id').value;
    const saved = await request(id ? `/api/admin/properties/${id}` : '/api/admin/properties', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(propertyPayload(propertyForm)),
    });
    const property = saved.property;
    const selectedFiles = [...propertyForm.elements.namedItem('photos').files];
    for (const file of selectedFiles) {
      if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is larger than 4 MB.`);
      await request(`/api/admin/properties/${property.id}/photos`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type },
      });
    }
    resetPropertyForm();
    await loadProperties();
    showNotice('Property saved. Publishing does not confirm availability.');
  } catch (error) { showNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

propertyList.addEventListener('click', async (event) => {
  const editId = event.target.dataset.editProperty;
  const deleteId = event.target.dataset.deleteProperty;
  const photo = event.target.dataset.removePhoto;
  try {
    if (editId) {
      const property = properties.find((item) => item.id === editId);
      if (!property) return;
      propertyForm.hidden = false;
      document.querySelector('#property-form-title').textContent = 'Edit property';
      for (const [key, value] of Object.entries({
        id: property.id,
        name: property.name,
        location: property.location,
        accommodationType: property.accommodationType,
        dailyPriceKes: property.dailyPriceKes,
        guestCapacity: property.guestCapacity,
        bedrooms: property.bedrooms ?? '',
        bathrooms: property.bathrooms ?? '',
        description: property.description,
        amenities: property.amenities.join('\n'),
        availabilityStatus: property.availabilityStatus,
        priceConfirmed: property.priceConfirmed,
        published: property.published,
      })) {
        const field = propertyForm.elements.namedItem(key);
        if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = String(value);
      }
      propertyForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (deleteId && window.confirm('Remove this property and its photos? Related booking requests will be retained.')) {
      await request(`/api/admin/properties/${deleteId}`, { method: 'DELETE' });
      await loadProperties();
      showNotice('Property removed. Existing booking records were retained.');
    } else if (photo && event.target.closest('figure')) {
      const propertyId = event.target.closest('.admin-record').querySelector('[data-edit-property]').dataset.editProperty;
      await request(`/api/admin/properties/${propertyId}/photos`, { method: 'DELETE', body: JSON.stringify({ photo }) });
      await loadProperties();
      showNotice('Property photo removed.');
    }
  } catch (error) { showNotice(error.message, 'error'); }
});

propertyList.addEventListener('submit', async (event) => {
  if (!event.target.matches('[data-block-property]')) return;
  event.preventDefault();
  const form = event.target;
  const propertyId = form.dataset.blockProperty;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request(`/api/admin/properties/${propertyId}/availability`, { method: 'POST', body: JSON.stringify(values) });
    form.reset();
    await loadBlocks(propertyId, form.nextElementSibling);
    showNotice('Unavailable date range recorded.');
  } catch (error) { showNotice(error.message, 'error'); }
});

document.querySelector('#rates-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const updated = await Promise.all([...document.querySelectorAll('.admin-rate-row')].map((row) => {
      const values = Object.fromEntries([...row.querySelectorAll('[data-price-key]')].map((input) => [input.dataset.priceKey, Number(input.value)]));
      return request(`/api/admin/packages/${encodeURIComponent(row.dataset.packageType)}`, { method: 'PUT', body: JSON.stringify(values) });
    }));
    packages = updated.map((result) => result.package);
    showNotice('Package prices saved. Property-specific prices remain managed on each listing.');
  } catch (error) { showNotice(error.message, 'error'); }
});

document.querySelector('#booking-rows').addEventListener('change', async (event) => {
  const bookingId = event.target.dataset.bookingStatus || event.target.dataset.bookingProperty || event.target.dataset.confirmedAmount;
  if (!bookingId) return;
  try {
    const row = event.target.closest('tr');
    const status = row.querySelector('[data-booking-status]').value;
    const propertyId = row.querySelector('[data-booking-property]').value || null;
    const amount = document.querySelector(`[data-confirmed-amount="${bookingId}"]`)?.value;
    await request(`/api/admin/bookings/${bookingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, propertyId, confirmedAmountKes: amount || null }),
    });
    const messageLink = row.querySelector('[data-guest-message]');
    if (messageLink) {
      messageLink.href = guestMessageUrl({
        reference: row.cells[0].firstChild.textContent,
        customerName: row.cells[2].firstChild.textContent,
        customerPhone: row.cells[2].querySelector('small')?.textContent || '',
        location: row.cells[0].querySelector('small').textContent.split(' · ')[0],
        confirmedAmountKes: amount,
      }, status);
      messageLink.hidden = !['confirmed', 'declined'].includes(status);
    }
    const notice = status === 'confirmed'
      ? 'Booking accepted. The guest can see the decision on their request page.'
      : status === 'declined'
        ? 'Booking declined. The guest can see the decision on their request page.'
        : 'Booking request details updated.';
    showNotice(notice);
  } catch (error) { showNotice(error.message, 'error'); await loadBookings(); }
});

document.querySelector('[data-refresh-bookings]').addEventListener('click', () => loadBookings().then(() => showNotice('Booking requests refreshed.')).catch((error) => showNotice(error.message, 'error')));
document.querySelector('[data-refresh-payments]').addEventListener('click', () => loadPayments().then(() => showNotice('Payment records refreshed.')).catch((error) => showNotice(error.message, 'error')));

try {
  const session = await request('/api/admin/session');
  if (session.authenticated) await enterAdmin();
  else showLogin(session.configured);
} catch (error) {
  showLogin(false);
  showNotice(error.message, 'error');
}