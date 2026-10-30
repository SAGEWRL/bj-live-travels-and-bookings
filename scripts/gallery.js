import { createMediaSlideshow } from './media-slideshow.js';

const galleryGrid = document.querySelector('#gallery-grid');

function formatMoney(value) {
  return `KSh ${Number(value).toLocaleString('en-KE')}`;
}

function renderMedia(property) {
  const mediaList = Array.isArray(property.media) && property.media.length
    ? property.media
    : (property.photos || []).map((url) => ({ url, kind: /\.(mp4|webm|mov)$/i.test(url) ? 'video' : 'image' }));
  return createMediaSlideshow(mediaList, property.name, 'gallery-card-media');
}

async function loadGallery() {
  try {
    const response = await fetch('/api/properties?sort=name', { headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Unable to load the gallery.');
    const properties = Array.isArray(result.properties) ? result.properties : [];
    galleryGrid.replaceChildren();

    if (!properties.length) {
      const empty = document.createElement('p');
      empty.className = 'gallery-empty';
      empty.textContent = 'New stays are being added to the gallery. Please check back soon.';
      galleryGrid.append(empty);
      return;
    }

    properties.forEach((property) => {
      const card = document.createElement('article');
      card.className = 'gallery-card';
      card.append(renderMedia(property));

      const body = document.createElement('div');
      body.className = 'gallery-card-body';
      const title = document.createElement('h2');
      title.textContent = property.name;
      const meta = document.createElement('p');
      meta.textContent = `${property.location} · ${property.accommodationType} · Up to ${property.guestCapacity} guests`;
      const price = document.createElement('p');
      const rate = property.priceConfirmed ? formatMoney(property.dailyPriceKes) : 'Price confirmed on enquiry';
      price.textContent = rate;
      const view = document.createElement('a');
      view.href = `/properties/${encodeURIComponent(property.slug)}`;
      view.textContent = 'View property';
      const icon = document.createElement('i');
      icon.dataset.lucide = 'arrow-up-right';
      icon.setAttribute('aria-hidden', 'true');
      view.append(icon);

      body.append(title, meta, price, view);
      card.append(body);
      galleryGrid.append(card);
    });

    window.lucide?.createIcons();
  } catch (error) {
    galleryGrid.replaceChildren();
    const message = document.createElement('p');
    message.className = 'gallery-empty';
    message.textContent = error.message || 'The gallery is unavailable right now.';
    galleryGrid.append(message);
  }
}

void loadGallery();
