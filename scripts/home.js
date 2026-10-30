import { createMediaSlideshow } from './media-slideshow.js';

const searchForm = document.querySelector('#stay-search-form');
const priceGrid = document.querySelector('#package-price-grid');
const propertyGrid = document.querySelector('#featured-properties');
const propertyEmpty = document.querySelector('#property-empty');
const searchMessage = document.querySelector('#search-message');
const results = document.querySelector('#stay-results');
let packageRates = [];

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatMoney(value) {
  return `KSh ${Number(value).toLocaleString('en-KE')}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'The accommodation service could not respond.');
  return result;
}

function renderRates() {
  priceGrid.replaceChildren();
  const typeFilter = searchForm.elements.namedItem('type');
  typeFilter.replaceChildren(new Option('All types', ''));
  for (const rate of packageRates) {
    typeFilter.add(new Option(rate.type, rate.type));
    const card = makeElement('article', 'package-price-card');
    card.append(makeElement('span', '', 'PER DAY · OWNER-SUPPLIED'));
    card.append(makeElement('h3', '', rate.type));
    card.append(makeElement('strong', '', `From ${formatMoney(rate.startingPriceKes)}`));
    card.append(makeElement('small', '', `Range ${formatMoney(rate.minimumPriceKes)}–${formatMoney(rate.maximumPriceKes)}`));
    const button = makeElement('button', '', 'Enquire about this type');
    button.type = 'button';
    const icon = document.createElement('i');
    icon.dataset.lucide = 'arrow-up-right';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', () => {
      searchForm.elements.namedItem('type').value = rate.type;
      searchForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      searchForm.elements.namedItem('location').focus();
    });
    card.append(button);
    priceGrid.append(card);
  }
  window.lucide?.createIcons();
}

function renderProperty(property) {
  const card = makeElement('article', 'property-card');
  const media = Array.isArray(property.media) && property.media.length
    ? property.media
    : (property.photos || []).map((url) => ({ url, kind: /\.(mp4|webm|mov)$/i.test(url) ? 'video' : 'image' }));
  card.append(createMediaSlideshow(media, property.name, 'property-card-image'));

  const body = makeElement('div', 'property-card-body');
  body.append(makeElement('span', 'property-card-type', property.accommodationType));
  const heading = document.createElement('h3');
  const title = document.createElement('a');
  title.href = `/properties/${encodeURIComponent(property.slug)}`;
  title.textContent = property.name;
  heading.append(title);
  body.append(heading, makeElement('p', 'property-card-location', `${property.location} · Up to ${property.guestCapacity} guests`));

  const rate = packageRates.find((item) => item.type === property.accommodationType);
  const price = makeElement('div', 'property-card-price');
  if (property.priceConfirmed) {
    price.append(makeElement('strong', '', formatMoney(property.dailyPriceKes)), makeElement('span', '', 'per day · property rate confirmed'));
  } else if (rate) {
    price.append(makeElement('strong', '', `${formatMoney(rate.minimumPriceKes)}–${formatMoney(rate.maximumPriceKes)}`), makeElement('span', '', 'per day · confirm exact rate'));
  } else {
    price.append(makeElement('span', '', 'Confirm daily price with Marevia'));
  }
  body.append(price);

  const foot = makeElement('div', 'property-card-foot');
  foot.append(makeElement('span', '', 'Availability confirmed on enquiry'));
  const enquiry = document.createElement('a');
  enquiry.href = `/booking?propertyId=${encodeURIComponent(property.id)}&location=${encodeURIComponent(property.location)}&type=${encodeURIComponent(property.accommodationType)}`;
  enquiry.append(document.createTextNode('Request stay '));
  const icon = document.createElement('i');
  icon.dataset.lucide = 'arrow-up-right';
  icon.setAttribute('aria-hidden', 'true');
  enquiry.append(icon);
  foot.append(enquiry);
  body.append(foot);
  card.append(body);
  return card;
}

function renderResults(properties, container) {
  container.replaceChildren();
  properties.forEach((property) => container.append(renderProperty(property)));
  window.lucide?.createIcons();
}

function showMessage(message, kind = 'info') {
  searchMessage.textContent = message;
  searchMessage.dataset.kind = kind;
}

async function loadFeaturedProperties() {
  const result = await fetchJson('/api/properties?sort=price-asc');
  renderResults(result.properties.slice(0, 3), propertyGrid);
  propertyEmpty.hidden = result.properties.length > 0;
}

searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!searchForm.reportValidity()) return;
  const values = Object.fromEntries(new FormData(searchForm));
  if (values.checkOut <= values.checkIn) {
    showMessage('Check-out must be after check-in.', 'error');
    searchForm.elements.namedItem('checkOut').focus();
    return;
  }
  const params = new URLSearchParams({
    location: values.location,
    checkIn: values.checkIn,
    checkOut: values.checkOut,
    guests: values.guests,
    sort: values.sort,
  });
  if (values.type) params.set('type', values.type);
  const button = searchForm.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Searching…';
  showMessage('Searching published listings…');
  results.replaceChildren();
  try {
    const result = await fetchJson(`/api/properties?${params}`);
    renderResults(result.properties, results);
    if (result.properties.length) {
      showMessage(`${result.properties.length} published ${result.properties.length === 1 ? 'listing' : 'listings'} match these filters. ${result.availabilityDisclaimer}`);
    } else {
      showMessage('No published listings match those filters yet. Send Marevia your dates and location for help finding a stay.');
      const enquiry = document.createElement('a');
      enquiry.className = 'button button-primary';
      enquiry.href = `/booking?location=${encodeURIComponent(values.location)}&type=${encodeURIComponent(values.type || '')}&checkIn=${encodeURIComponent(values.checkIn)}&checkOut=${encodeURIComponent(values.checkOut)}&guests=${encodeURIComponent(values.guests)}`;
      enquiry.textContent = 'Send a booking enquiry';
      results.append(enquiry);
    }
  } catch (error) {
    showMessage(error.message || 'Search failed. Check your connection and try again.', 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Search stays <i data-lucide="search" aria-hidden="true"></i>';
    window.lucide?.createIcons();
  }
});

document.querySelectorAll('[data-location]').forEach((button) => {
  button.addEventListener('click', () => {
    searchForm.elements.namedItem('location').value = button.dataset.location;
    searchForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    searchForm.elements.namedItem('checkIn').focus();
  });
});

try {
  const packageResult = await fetchJson('/api/packages');
  packageRates = packageResult.packages;
  renderRates();
  await loadFeaturedProperties();
} catch (error) {
  priceGrid.replaceChildren(makeElement('p', 'catalog-loading', 'Package rates could not load. Refresh the page or try again shortly.'));
  propertyGrid.replaceChildren();
  propertyEmpty.hidden = false;
  propertyEmpty.textContent = error.message || 'Published listings could not load. Please try again.';
}

const today = new Date().toISOString().slice(0, 10);
searchForm.elements.namedItem('checkIn').min = today;
searchForm.elements.namedItem('checkOut').min = today;