/* github pages serves a static file per path and 404s on anything else, so /portal and
   /auth/callback would break on a hard load or a magic-link landing. pages serves 404.html
   for unknown paths, so shipping the app as 404.html turns that into the spa fallback. */

import { copyFileSync } from 'node:fs';

copyFileSync('dist/index.html', 'dist/404.html');
console.log('  spa fallback: dist/404.html written');
