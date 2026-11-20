// Spatial touches: the hero scene and the "How it works" panels tilt a little toward the pointer, and the panels fly in
// when scrolled to. Nothing moves for people who prefer reduced motion; without this script, everything simply shows.
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const tilt = (target, area, base, range) => {
    if (!target || !area) return;
    let frame = 0;
    area.addEventListener('pointermove', (e) => {
      const r = area.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        target.style.setProperty('--ry', `${base.ry + x * range.ry}deg`);
        target.style.setProperty('--rx', `${base.rx - y * range.rx}deg`);
      });
    });
    area.addEventListener('pointerleave', () => {
      target.style.removeProperty('--ry');
      target.style.removeProperty('--rx');
    });
  };

  const stage = document.getElementById('stage');
  tilt(stage, stage && stage.parentElement, { rx: 14, ry: -22 }, { rx: 10, ry: 16 });

  const flow = document.getElementById('flow');
  if (!flow || !window.matchMedia('(min-width: 901px)').matches) return;
  tilt(flow, flow.parentElement, { rx: 12, ry: -10 }, { rx: 8, ry: 12 });
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('reveal');
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      flow.classList.add('in');
      io.disconnect();
    }
  }, { threshold: 0.25 });
  io.observe(flow);
})();

// Guides page: the search box hides guides that do not mention every word typed, and the sidebar marks the guide
// being read. Without this script every guide simply shows.
(() => {
  const input = document.getElementById('guide-search');
  if (!input) return;
  // On a phone the list of guides starts folded; picking one folds it again.
  const toggle = document.querySelector('.side-toggle');
  if (toggle && window.matchMedia('(max-width: 900px)').matches) {
    toggle.open = false;
    toggle.addEventListener('click', (e) => { if (e.target.closest('a')) toggle.open = false; });
  }
  const guides = [...document.querySelectorAll('.guide')];
  const groups = [...document.querySelectorAll('.group-title')];
  const none = document.getElementById('no-results');
  input.addEventListener('input', () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const g of guides) {
      const hit = words.every((w) => g.textContent.toLowerCase().includes(w));
      g.hidden = !hit;
      if (hit) shown++;
    }
    for (const t of groups) {
      let el = t.nextElementSibling;
      let any = false;
      while (el && !el.classList.contains('group-title')) {
        if (el.classList.contains('guide') && !el.hidden) any = true;
        el = el.nextElementSibling;
      }
      t.hidden = !any;
    }
    none.hidden = shown > 0;
  });
  const links = new Map([...document.querySelectorAll('.side-nav a')].map((a) => [a.getAttribute('href').slice(1), a]));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('active');
      links.get(e.target.id)?.classList.add('active');
    }
  }, { rootMargin: '-80px 0px -70% 0px' });
  guides.forEach((g) => io.observe(g));
})();
