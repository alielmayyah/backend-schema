// Builds player-backends-schema.html: template.html + the three schema JSON files
// + player-backends-migration.html embedded as the "Migration" tab.
const fs = require('fs');
const path = require('path');
const here = f => path.join(__dirname, f);

const strip = d => ({ models: d.models.map(m => ({ ...m, fields: m.fields.filter(f => f.name !== '__v') })) });
const data = {
  bob: strip(require(here('bobplayer.json'))),
  cr: strip(require(here('cr-unified.json'))),
  ibo: strip(require(here('iboplayer.json'))),
};

const { coverage } = require('./checks');
const allowGaps = process.argv.includes('--allow-gaps');

// ---------- migration page → scoped fragment ----------
const mig = fs.readFileSync(here('player-backends-migration.html'), 'utf8');

const between = (s, a, b, fromEnd = false) => {
  const i = fromEnd ? s.lastIndexOf(a) : s.indexOf(a);
  const j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`markers ${a} … ${b} not found in migration page`);
  return s.slice(i + a.length, j);
};
let migCss = between(mig, '<style>', '</style>');
let migBody = mig.slice(mig.indexOf('</style>') + 8, mig.lastIndexOf('<script>'));
let migJs = between(mig, '<script>', '</script>', true);

// body: drop the page's own .wrap container, keep what is inside it
migBody = migBody.trim();
if (!migBody.startsWith('<div class="wrap">') || !migBody.endsWith('</div>')) throw new Error('unexpected migration page layout');
migBody = migBody.slice('<div class="wrap">'.length, -'</div>'.length);

// ids: prefix with m- so they cannot collide with the schema page (both use id="q", for example)
const ids = [...migBody.matchAll(/\sid="([A-Za-z][\w-]*)"/g)].map(m => m[1]);
for (const id of new Set(ids)) {
  migBody = migBody.split(`id="${id}"`).join(`id="m-${id}"`);
  migJs = migJs.split(`getElementById('${id}')`).join(`getElementById('m-${id}')`);
  migJs = migJs.replace(new RegExp(`(['"\`])#${id}\\b`, 'g'), `$1#m-${id}`);
}
migJs = migJs.split(`'row-'`).join(`'m-row-'`).split('id="row-').join('id="m-row-');

// css: prefix every selector with #migration; drop tokens, resets and the page container
function scope(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    let depth = 1, k = open + 1;
    while (depth && k < css.length) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    const body = css.slice(open + 1, k - 1);
    i = k;
    if (selector.startsWith('@media')) {
      if (!selector.includes('prefers-color-scheme')) out += `${selector}{${scope(body)}}\n`;
    } else if (!/^(:root|\*|body|\.wrap)\b/.test(selector)) {
      out += selector.split(',').map(s => `#migration ${s.trim()}`).join(', ') + `{${body}}\n`;
    }
  }
  return out;
}
migCss = scope(migCss.replace(/\/\*[\s\S]*?\*\//g, '')) + `
/* tokens the migration tab adds to the schema page */
:root { --ok: #1f8a4c; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ok: #4fc98a; --bad: #f2867d; } }
:root[data-theme="dark"] { --ok: #4fc98a; --bad: #f2867d; }
/* undo schema-page element rules that would leak into the tab */
#migration { padding-top: 24px; }
#migration header { display: block; }
#migration h2 { display: block; }
#migration .chip { margin-left: 0; cursor: default; border-radius: 4px; }
#migration .scard { overflow-x: auto; }
`;

// ---------- New Unified tab: the proposed schema from the migration page ----------
const schemaSrc = (() => {
  const a = mig.indexOf('const SCHEMA = [');
  const b = mig.indexOf('\n];', a);
  if (a < 0 || b < 0) throw new Error('SCHEMA block not found in migration page');
  return mig.slice(a, b + 3);
})();
const SCHEMA = new Function(`${schemaSrc}\nreturn SCHEMA;`)();

// field path → collection it points to (ids the new schema stores)
const REFS = {
  devices: { 'license.activatedBy.id': 'resellers', 'license.subscriptionId': 'subscriptions' },
  playlists: { deviceId: 'devices' },
  transactions: { deviceId: 'devices', customerId: 'customers', resellerId: 'resellers' },
  customers: { walletAccountId: 'walletAccounts' },
  // deviceIds → devices is left out: devices.license.subscriptionId already draws that link,
  // and a second one in the other direction would loop back across the map
  subscriptions: { customerId: 'customers', planId: 'plans' },
  activationHistory: { deviceId: 'devices' },
  notifications: { resellerId: 'resellers' },
  authTokens: { customerId: 'customers' },
  tenantSecrets: { tenantId: 'tenants' },
  resellers: { parentId: 'resellers' },
  walletLedger: { accountId: 'walletAccounts' },
  activationCodes: { ownerId: 'resellers', 'usedBy.deviceId': 'devices' },
  couponRedemptions: { couponId: 'coupons', deviceId: 'devices' },
  deviceRegistry: { deviceId: 'devices', tenantId: 'tenants' },
  licenseTransfers: { 'from.deviceId': 'devices', 'to.deviceId': 'devices' },
  translations: { languageId: 'languages', keyId: 'translationKeys' },
};

function toFields(card) {
  const top = [];
  for (const [n, type, old, note] of card.f) {
    if (n.startsWith('.')) {
      const parent = top[top.length - 1];
      const name = n.slice(1);
      (parent.children = parent.children || []).push({ name, path: `${parent.path}.${name}`, type, old, note });
    } else {
      top.push({ name: n, path: n, type, old, note });
    }
  }
  const refs = REFS[card.n] || {};
  const mark = fs => fs.forEach(f => { if (refs[f.path]) f.ref = refs[f.path]; if (f.children) mark(f.children); });
  mark(top);
  return top;
}
const devicesCard = SCHEMA.find(c => c.n === 'devices');
const newModels = SCHEMA.map(card => {
  let fields = toFields(card);
  if (card.n === 'pendingDevices') {
    // "same fields as devices, except license and activatedAt"
    fields = toFields(devicesCard).filter(f => f.name !== 'license' && f.name !== 'activatedAt');
  }
  return { name: card.n, file: card.n, db: card.db, purpose: card.p, idx: card.idx, fields };
});
// old collection → new collections, from the migration page's MAP (used by the Compare tab)
const mapSrc = (() => {
  const a = mig.indexOf('const MAP = [');
  const b = mig.indexOf('\n];', a);
  if (a < 0 || b < 0) throw new Error('MAP block not found in migration page');
  return mig.slice(a, b + 3);
})();
const MAP = new Function(`${mapSrc}\nreturn MAP;`)();
const oldToNew = Object.fromEntries(MAP.map(([old, , targets, rule, status]) => [old, { targets, rule, status }]));
// old fields the migration drops or reshapes on purpose, with the reason (migration page's DROPPED)
const dropped = (() => {
  const a = mig.indexOf('const DROPPED = {');
  if (a < 0) return {};
  const b = mig.indexOf('\n};', a);
  return new Function(`${mig.slice(a, b + 3)}\nreturn DROPPED;`)();
})();
data.new = { models: newModels, map: oldToNew, dropped };

// ---------- coverage: every old field must have a new home or a recorded reason ----------
const gaps = coverage({ oldModels: { bob: data.bob.models, cr: data.cr.models, ibo: data.ibo.models }, map: oldToNew, newModels, dropped });
if (gaps.length) {
  console.error(`coverage: ${gaps.length} old field(s) have no new home and no reason in DROPPED:\n  ${gaps.join('\n  ')}`);
  if (!allowGaps) {
    console.error('Map them in the migration page\'s SCHEMA ("from" column) or add them to DROPPED. Use --allow-gaps to build anyway.');
    process.exit(1);
  }
} else console.log('coverage: every old field of every migrated collection is accounted for');

// js: own scope, so its helpers (esc, renderMap, …) don't clash with the schema page's
migJs = `(() => {\n${migJs}\n})();`;

const html = fs.readFileSync(here('template.html'), 'utf8')
  .replace('</style>', () => migCss + '</style>')
  .replace('/*MIGRATION_HTML*/', () => migBody)
  .replace('/*MIGRATION_JS*/', () => migJs.replace(/<\/script/gi, '<\\/script'))
  .replace('/*DATA*/', () => JSON.stringify(data).replace(/</g, '\\u003c'));
fs.writeFileSync(here('player-backends-schema.html'), html);
console.log('wrote', html.length, 'bytes; migration ids scoped:', [...new Set(ids)].join(', '));
