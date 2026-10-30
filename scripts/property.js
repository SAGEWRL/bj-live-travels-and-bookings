import { createMediaSlideshow } from './media-slideshow.js';

function textElement(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function money(value) {
  return `KSh ${Number(value).toLocaleString('en-KE')}`;
}

function addFact(container, label, value) {
  if (value === null || value === undefined || value === '') return;
  const row = document.createElement('div');
  row.append(textElement('dt', label), textElement('dd', String(value)));
  container.append(row);
}

async function loadProperty() {
  const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
  const status = document.querySelector('#property-detail-status');
  const detail = document.querySelector('#property-detail');
  try {
    const response = await fetch(`/api/properties/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'This property is no longer available.');
    const property = result.property;
    const rateResponse = await fetch('/api/packages');
    const rateData = await rateResponse.json();
    const packageRate = rateData.packages?.find((item) => item.type === property.accommodationType);

    document.title = `${property.name} | Marevia Travels and Booking`;
    document.querySelector('#property-breadcrumb').textContent = property.name;
    document.querySelector('#property-detail-type').textContent = property.accommodationType;
    document.querySelector('#property-detail-name').textContent = property.name;
    document.querySelector('#property-detail-location').textContent = `${property.location} · Up to ${property.guestCapacity} guests`;
    document.querySelector('#property-detail-description').textContent = property.description || 'Property details are available on request.';

    const price = document.querySelector('#property-detail-price');
    if (property.priceConfirmed) {
      price.append(textElement('strong', money(property.dailyPriceKes)), textElement('span', 'per day · property rate confirmed'));
    } else if (packageRate) {
      price.append(textElement('strong', `${money(packageRate.minimumPriceKes)}–${money(packageRate.maximumPriceKes)}`), textElement('span', 'per day · confirm exact price'));
    } else {
      price.append(textElement('span', 'Price confirmed on enquiry'));
    }

    const facts = document.querySelector('#property-detail-facts');
    addFact(facts, 'Accommodation type', property.accommodationType);
    addFact(facts, 'Guest capacity', property.guestCapacity);
    addFact(facts, 'Bedrooms', property.bedrooms);
    addFact(facts, 'Bathrooms', property.bathrooms);
    addFact(facts, 'Availability', 'Confirm dates directly with Marevia');

    const amenities = document.querySelector('#property-detail-amenities');
    if (property.amenities?.length) {
      const list = amenities.querySelector('ul');
      property.amenities.forEach((amenity) => list.append(textElement('li', amenity)));
      amenities.hidden = false;
    }

    const gallery = document.querySelector('#property-gallery');
    const media = Array.isArray(property.media) && property.media.length
      ? property.media
      : (property.photos || []).map((url) => ({ url, kind: /\.(mp4|webm|mov)$/i.test(url) ? 'video' : 'image' }));
    gallery.replaceChildren(createMediaSlideshow(media, property.name));

    const booking = document.querySelector('#property-booking-link');
    booking.href = `/booking?propertyId=${encodeURIComponent(property.id)}&location=${encodeURIComponent(property.location)}&type=${encodeURIComponent(property.accommodationType)}`;
    status.hidden = true;
    detail.hidden = false;
    window.lucide?.createIcons();
  } catch (error) {
    status.textContent = error.message;
    document.querySelector('#property-not-found').hidden = false;
  }
}

await loadProperty();