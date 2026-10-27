// Guide builder: caption and section data plus the captures in screenshots/
// become one self-contained guide/index.html (search, lightbox, phone layout).
// Node rather than the usual Python builder, because this repo allows Node 22
// built-ins only. Edit the data here and run guide/regenerate.sh; never edit
// index.html by hand.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// `--site <dir>`: write the microsite's copy into <dir> (site/build.mjs), whose
// back links lead to the product page instead of the app's own pages.
const siteOut = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : null;
const BACK = siteOut
  ? '<a href="../">← Turbella</a> · <a href="https://github.com/NakliTechie/turbella">GitHub</a>'
  : '<a href="../">← Timeline</a> · <a href="../viz">Visualiser</a>';

// slug -> [title, one-line description]
const CAPTIONS = {
  '01-timeline-empty': ['Waiting for an agent',
    'The timeline before any event arrives. Start a Claude Code session with the plugin installed, or load a transcript.'],
  '02-timeline-live': ['A session as it happens',
    'Each tick is a tool call, coloured by tool. Red spikes are failures; the loop marks show the same failure repeating. Amber is a permission wait, violet is thinking. The shaded stretch is silence since the last event, and the turbulence gauge by the title rises with it.'],
  '07-timeline-offline': ['When the daemon stops',
    'Live goes dark, the gauge greys out and the status turns amber. The page reconnects by itself when the daemon is back.'],
  '03-visualiser-session': ['The visualiser for one session',
    'The same events played as music to a MilkDrop picture: a tool call is a pluck, a failure a bass hit, thinking a slow swell. The panel shows the gauge and what the agent is doing, for how long.'],
  '04-visualiser-all': ['Every agent at once',
    'With no session chosen, the panel lists one line per agent session: who it is, what it is doing, and for how long. Failures show in red, permission waits in amber.'],
  '05-window-session': ['A floating window per session',
    '`turbella overlay` opens a small always-on-top window for each active agent session. It floats over terminals and desktop apps and never takes focus. The toolbar fades; the eye hides it until the pointer returns.'],
  '06-window-all': ['One window for all sessions',
    'The menu bar item switches to a single combined window that lists every agent, one line each.'],
};

const SECTIONS = [
  ['The timeline', 'The plain record at `/`: what happened, when, and how often it repeated. One lane per agent session.',
    ['01-timeline-empty', '02-timeline-live', '07-timeline-offline']],
  ['The visualiser', 'The default view at `/viz`. Nothing plays aloud; the events only drive the picture.',
    ['03-visualiser-session', '04-visualiser-all']],
  ['Floating windows (macOS)', 'The visualiser in small windows over your agents, from `turbella overlay`.',
    ['05-window-session', '06-window-all']],
];

// Colours from the timeline's own tokens, so the guide reads as part of Turbella.
const page = readFileSync(join(here, '..', 'web', 'turbella.html'), 'utf8');
const tokens = page.match(/:root\s*{([^}]*)}/)?.[1].trim() ?? '';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const fileFor = (slug) => ['png', 'jpg'].map((x) => `${slug}.${x}`).find((f) => existsSync(join(here, 'screenshots', f)));
const anchor = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const missing = [];
const sections = SECTIONS.map(([title, intro, slugs]) => {
  const cards = slugs.map((slug) => {
    const file = fileFor(slug);
    if (!file) { missing.push(slug); return ''; }
    const [t, d] = CAPTIONS[slug];
    const search = `${title} ${t} ${d} ${slug}`.toLowerCase();
    return `<figure class="card" data-search="${esc(search)}" data-title="${esc(t)}" data-section="${esc(title)}">
  <button class="shot" aria-label="Open ${esc(t)} full size"><img src="screenshots/${file}" alt="${esc(t)}" loading="lazy"></button>
  <figcaption><strong>${esc(t)}</strong><span>${md(d)}</span></figcaption>
</figure>`;
  }).join('\n');
  return `<section id="${anchor(title)}"><h2>${esc(title)}</h2><p class="intro">${md(intro)}</p>\n${cards}\n</section>`;
}).join('\n');
const toc = SECTIONS.map(([t]) => `<a href="#${anchor(t)}">${esc(t)}</a>`).join('');

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turbella · guide</title>
<style>
  :root { ${tokens} }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line);
    padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: 0.04em; }
  header nav { display: flex; gap: 14px; font-size: 13px; flex-wrap: wrap; }
  header nav a, .back a { color: var(--muted); text-decoration: none; }
  header nav a:hover, .back a:hover { color: var(--ink); }
  #q { margin-left: auto; font: inherit; font-size: 13px; padding: 6px 10px; width: 220px; max-width: 100%;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
  #q:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  main { max-width: 980px; margin: 0 auto; padding: 8px 16px 48px; }
  .back { font-size: 13px; margin: 12px 0 0; }
  h2 { font-size: 18px; margin: 32px 0 4px; }
  .intro { color: var(--muted); margin: 0 0 14px; }
  code { font: 13px ui-monospace, monospace; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .card { margin: 0 0 22px; }
  .shot { display: block; width: 100%; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    background: var(--panel); cursor: zoom-in; }
  .shot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .shot img { display: block; width: 100%; height: auto; }
  figcaption { display: flex; flex-direction: column; gap: 2px; padding: 8px 2px 0; }
  figcaption span { color: var(--muted); font-size: 14px; }
  .hidden { display: none; }
  #none { color: var(--muted); }
  #box { position: fixed; inset: 0; z-index: 5; background: rgba(20, 20, 18, 0.92); display: flex; flex-direction: column;
    align-items: center; justify-content: center; padding: 56px 16px 16px; touch-action: pan-y pinch-zoom; }
  #box[hidden] { display: none; }
  #box img { max-width: 100%; max-height: calc(100% - 64px); object-fit: contain; border-radius: 6px; }
  #box p { color: #f4f4f2; margin: 10px 0 0; text-align: center; font-size: 14px; max-width: 70ch; }
  #box .pos { color: rgba(244, 244, 242, 0.7); font-size: 12px; }
  #box button { position: absolute; min-width: 44px; min-height: 44px; border: 0; border-radius: 22px;
    background: rgba(244, 244, 242, 0.14); color: #f4f4f2; font-size: 22px; cursor: pointer; }
  #box button:focus-visible { outline: 2px solid #f4f4f2; }
  #close { top: 10px; right: 12px; } #prev { left: 12px; top: 50%; } #next { right: 12px; top: 50%; }
  @media (max-width: 600px) { #q { margin-left: 0; width: 100%; } }
</style>
<header>
  <h1>Turbella guide</h1>
  <nav>${toc}</nav>
  <input id="q" type="search" placeholder="Search  ( / )" aria-label="Search the guide">
</header>
<main>
  <p class="back">${BACK}</p>
  ${sections}
  <p id="none" hidden>No matches.</p>
</main>
<div id="box" hidden role="dialog" aria-modal="true" aria-label="Screenshot">
  <button id="close" aria-label="Close">×</button>
  <button id="prev" aria-label="Previous">‹</button>
  <button id="next" aria-label="Next">›</button>
  <img alt="">
  <p><span class="cap"></span><br><span class="pos"></span></p>
</div>
<script>
  const $ = (s) => document.querySelector(s);
  const cards = [...document.querySelectorAll('.card')];
  const q = $('#q');
  function filter() {
    const v = q.value.trim().toLowerCase();
    for (const c of cards) c.classList.toggle('hidden', !!v && !c.dataset.search.includes(v));
    for (const s of document.querySelectorAll('section')) s.classList.toggle('hidden', !s.querySelector('.card:not(.hidden)'));
    $('#none').hidden = cards.some((c) => !c.classList.contains('hidden'));
  }
  q.addEventListener('input', filter);
  // Lightbox: ←/→ step, ↑/↓ jump section, Esc closes; swipe on a phone.
  const box = $('#box'), img = box.querySelector('img');
  let at = -1, scrollY = 0;
  const visible = () => cards.filter((c) => !c.classList.contains('hidden'));
  function open(card) {
    const list = visible(); at = list.indexOf(card); if (at < 0) return;
    if (box.hidden) scrollY = window.scrollY;
    img.src = card.querySelector('img').src; img.alt = card.dataset.title;
    box.querySelector('.cap').textContent = card.querySelector('figcaption').innerText.replace('\\n', ' — ');
    box.querySelector('.pos').textContent = card.dataset.section + ' · ' + card.dataset.title + ' — ' + (at + 1) + '/' + list.length;
    box.hidden = false; $('#close').focus();
  }
  function close() { box.hidden = true; window.scrollTo(0, scrollY); }
  function step(d) { const l = visible(); if (l.length) open(l[(at + d + l.length) % l.length]); }
  function jump(d) {
    const l = visible(); const sec = l[at]?.dataset.section;
    const starts = l.filter((c, i) => i === 0 || l[i - 1].dataset.section !== c.dataset.section);
    const i = starts.findIndex((c) => c.dataset.section === sec);
    open(starts[Math.min(Math.max(i + d, 0), starts.length - 1)]);
  }
  cards.forEach((c) => c.querySelector('.shot').addEventListener('click', () => open(c)));
  $('#close').addEventListener('click', close);
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  let tx = 0, ty = 0;
  box.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }, { passive: true });
  box.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]; const dx = t.clientX - tx, dy = t.clientY - ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 80) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!box.hidden) {
      const k = { ArrowLeft: () => step(-1), ArrowRight: () => step(1), ArrowUp: () => jump(-1), ArrowDown: () => jump(1), Escape: close }[e.key];
      if (k) { e.preventDefault(); k(); }
      return;
    }
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    else if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; filter(); q.blur(); }
  });
</script>
</html>
`;

writeFileSync(join(siteOut ?? here, 'index.html'), html);
const shots = Object.keys(CAPTIONS).length - missing.length;
console.log(`guide/index.html: ${SECTIONS.length} sections, ${shots} screenshots` + (missing.length ? `; missing: ${missing.join(', ')}` : ''));
if (missing.length) process.exitCode = 1;
