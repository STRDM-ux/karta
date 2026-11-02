// Rork deploys functions/ on its own, so the ads package is copied in (functions/lib/ads is generated).
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
const src = 'packages/ads/src', dst = 'functions/lib/ads';
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
for (const f of readdirSync(dst)) {
  const p = `${dst}/${f}`;
  // workers bundler resolves extensionless imports; keep the files identical otherwise
  writeFileSync(p, `// Generated from packages/ads/src by scripts/sync-ads.mjs. Edit there, then run npm run sync-ads.\n` + readFileSync(p, 'utf8').replace(/from '\.\/([\w-]+)\.js'/g, "from './$1'"));
}
console.log(`synced ${readdirSync(dst).length} files to ${dst}`);
