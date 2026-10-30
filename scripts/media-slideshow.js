function isVideo(item) {
  const url = typeof item === 'string' ? item : item?.url || '';
  return item?.kind === 'video' || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url);
}

export function createMediaSlideshow(items, label, extraClass = '') {
  const media = (Array.isArray(items) ? items : [])
    .map((item) => ({ url: typeof item === 'string' ? item : item?.url, kind: isVideo(item) ? 'video' : 'image' }))
    .filter((item) => item.url);
  const slideshow = document.createElement('div');
  slideshow.className = ['media-slideshow', extraClass].filter(Boolean).join(' ');

  if (!media.length) {
    const empty = document.createElement('p');
    empty.className = 'media-slideshow-empty';
    empty.textContent = 'Images for this stay are not available yet.';
    slideshow.append(empty);
    return slideshow;
  }

  slideshow.setAttribute('role', 'region');
  slideshow.setAttribute('aria-roledescription', 'carousel');
  slideshow.setAttribute('aria-label', `${label} photos and videos`);

  const track = document.createElement('div');
  track.className = 'media-slideshow-track';
  track.setAttribute('tabindex', '0');
  track.setAttribute('aria-label', 'Swipe or scroll to view more media');
  const slides = media.map((item, index) => {
    const slide = document.createElement('figure');
    slide.className = 'media-slide';
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `${index + 1} of ${media.length}`);

    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.preload = index === 0 ? 'metadata' : 'none';
      video.playsInline = true;
      video.setAttribute('aria-label', `${label} video ${index + 1}`);
      slide.append(video);
    } else {
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = `${label} photo ${index + 1}`;
      image.loading = index === 0 ? 'eager' : 'lazy';
      image.draggable = false;
      slide.append(image);
    }

    track.append(slide);
    return slide;
  });
  slideshow.append(track);

  if (slides.length < 2) return slideshow;

  const controls = document.createElement('div');
  controls.className = 'media-slideshow-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'media-slideshow-button';
  previous.setAttribute('aria-label', 'Previous photo or video');
  previous.innerHTML = '<i data-lucide="chevron-left" aria-hidden="true"></i>';
  const counter = document.createElement('span');
  counter.className = 'media-slideshow-counter';
  counter.setAttribute('aria-live', 'polite');
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'media-slideshow-button';
  next.setAttribute('aria-label', 'Next photo or video');
  next.innerHTML = '<i data-lucide="chevron-right" aria-hidden="true"></i>';
  controls.append(previous, counter, next);
  slideshow.append(controls);

  let currentIndex = 0;
  let timer;
  let visible = typeof IntersectionObserver !== 'function';
  let paused = false;
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function updateCounter() {
    counter.textContent = `${currentIndex + 1} / ${slides.length}`;
  }

  function goTo(index, behavior = 'smooth') {
    currentIndex = (index + slides.length) % slides.length;
    track.scrollTo({ left: slides[currentIndex].offsetLeft, behavior: prefersReducedMotion ? 'auto' : behavior });
    track.querySelectorAll('video').forEach((video) => video.pause());
    updateCounter();
  }

  function updateAutoplay() {
    window.clearInterval(timer);
    if (prefersReducedMotion || paused || !visible || document.hidden || media.some((item) => item.kind === 'video')) return;
    timer = window.setInterval(() => goTo(currentIndex + 1), 6000);
  }

  previous.addEventListener('click', () => goTo(currentIndex - 1));
  next.addEventListener('click', () => goTo(currentIndex + 1));
  track.addEventListener('scroll', () => {
    currentIndex = slides.reduce((closest, slide, index) => (
      Math.abs(slide.offsetLeft - track.scrollLeft) < Math.abs(slides[closest].offsetLeft - track.scrollLeft) ? index : closest
    ), 0);
    updateCounter();
  }, { passive: true });
  slideshow.addEventListener('mouseenter', () => { paused = true; updateAutoplay(); });
  slideshow.addEventListener('mouseleave', () => { paused = false; updateAutoplay(); });
  slideshow.addEventListener('focusin', () => { paused = true; updateAutoplay(); });
  slideshow.addEventListener('focusout', (event) => {
    if (!slideshow.contains(event.relatedTarget)) {
      paused = false;
      updateAutoplay();
    }
  });
  document.addEventListener('visibilitychange', updateAutoplay);
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      updateAutoplay();
    });
    observer.observe(slideshow);
  }

  updateCounter();
  window.lucide?.createIcons();
  updateAutoplay();
  return slideshow;
}