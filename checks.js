// Coverage check used by build.js: old fields that have no home in the new schema
// and no recorded reason in the migration page's DROPPED list.

// old key names a new field's "from" text mentions: "deletion_at, pending_deletion" → both
function oldKeys(text) {
  return String(text || '').split(/,\s*|\s+\/\s+|\s+or\s+/)
    .map(s => s.trim().replace(/^\w+\./, '').replace(/\s*\(.*\)$/, ''))
    .filter(Boolean);
}

// every old field of every migrated collection must land in a target field or be listed in DROPPED
function coverage({ oldModels, map, newModels, dropped }) {
  const SYS = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
  const gaps = [];
  for (const [collection, { targets }] of Object.entries(map)) {
    if (!targets.length) continue; // collection not migrated at all
    const sources = new Set();
    for (const t of targets) {
      const walk = fs => fs.forEach(f => { oldKeys(f.old).forEach(k => sources.add(k)); if (f.children) walk(f.children); });
      const m = newModels.find(x => x.name === t);
      if (m) walk(m.fields);
    }
    const keys = new Map(); // old field → backends that have it
    for (const [backend, models] of Object.entries(oldModels)) {
      const m = models.find(x => x.file.replace(/\.model\.js$/, '') === collection);
      if (m) m.fields.forEach(f => { if (!SYS.has(f.name)) keys.set(f.name, [...(keys.get(f.name) || []), backend]); });
    }
    for (const [key, backends] of keys) {
      if (!sources.has(key) && !(dropped[collection] && dropped[collection][key])) gaps.push(`${collection}.${key} (${backends.join(', ')})`);
    }
  }
  return gaps;
}

module.exports = { coverage, oldKeys };
