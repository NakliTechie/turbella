// Builds the microsite (turbella.naklitechie.com) into site/dist: the product
// page, its images and promo video from marketing/, and the guide with links
// back to the page. Cloudflare Workers Builds runs this, then `wrangler deploy`
// serves site/dist (wrangler.jsonc). Node built-ins only.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'site', 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'guide'), { recursive: true });

cpSync(join(root, 'site', 'index.html'), join(dist, 'index.html'));
cpSync(join(root, 'site', '_headers'), join(dist, '_headers'));
for (const f of ['windows.jpg', 'hero.png', 'strip.png', 'social.png', 'promo.mp4', 'promo-poster.jpg']) {
  cpSync(join(root, 'marketing', f), join(dist, f));
}
cpSync(join(root, 'guide', 'screenshots'), join(dist, 'guide', 'screenshots'), {
  recursive: true, filter: (src) => !src.endsWith('.json'),
});
execFileSync(process.execPath, [join(root, 'guide', 'build.mjs'), '--site', join(dist, 'guide')], { stdio: 'inherit' });
console.log(`site/dist ready`);
