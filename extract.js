// Usage: node extract.js <modelsDir> <outJson>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const mongoosePath = require.resolve('mongoose');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'mongoose') return mongoosePath;
  return origResolve.call(this, req, ...rest);
};
const mongoose = require('mongoose');

const captured = {};
const origModel = mongoose.model.bind(mongoose);
mongoose.model = function (name, schema, collection, ...rest) {
  if (schema) captured[name] = { schema, collection: collection || null };
  return origModel(name, schema, collection, ...rest);
};
mongoose.Connection.prototype.model = function (name, schema, collection) {
  if (schema) captured[name] = { schema, collection: collection || null };
  return {};
};

function fmtDefault(d) {
  if (d === undefined) return undefined;
  if (typeof d === 'function') return d === Date.now || d.name === 'now' ? 'Date.now()' : '(computed)';
  try { return JSON.stringify(d); } catch { return String(d); }
}

function describe(schema) {
  const fields = [];
  schema.eachPath((p, st) => {
    const o = st.options || {};
    const f = { name: p, type: st.instance };
    if (st.instance === 'Array') {
      const c = st.caster || (st.$embeddedSchemaType);
      if (st.schema) { f.type = 'Array<Object>'; f.children = describe(st.schema); }
      else if (c) {
        f.type = `Array<${c.instance || 'Mixed'}>`;
        const ref = (c.options && c.options.ref) || (Array.isArray(o.type) && o.type[0] && o.type[0].ref);
        if (ref) f.ref = typeof ref === 'string' ? ref : String(ref);
      }
    }
    if (st.schema && st.instance !== 'Array') { f.type = 'Object'; f.children = describe(st.schema); }
    if (o.ref) f.ref = typeof o.ref === 'string' ? o.ref : (o.ref.modelName || String(o.ref));
    if (o.required) f.required = true;
    if (o.unique) f.unique = true;
    if (o.index) f.index = true;
    if (o.enum) f.enum = Array.isArray(o.enum) ? o.enum : (o.enum.values || Object.values(o.enum));
    const d = fmtDefault(o.default);
    if (d !== undefined) f.default = d;
    fields.push(f);
  });
  return fields;
}

const dir = path.resolve(process.argv[2]);
const out = { models: [], errors: [] };
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
  const before = new Set(Object.keys(captured));
  let exp;
  try { exp = require(path.join(dir, file)); }
  catch (e) { out.errors.push({ file, error: e.message }); continue; }
  let names = Object.keys(captured).filter(n => !before.has(n));
  if (!names.length && exp) {
    const schema = exp.schema instanceof mongoose.Schema ? exp.schema : (exp instanceof mongoose.Schema ? exp : null);
    if (schema) {
      const name = file.replace(/\.model\.js$|\.js$/, '');
      captured[name] = { schema, collection: null };
      names = [name];
    }
  }
  if (!names.length) { out.errors.push({ file, error: 'no schema found' }); continue; }
  for (const name of names) {
    const { schema, collection } = captured[name];
    const opts = schema.options || {};
    out.models.push({
      name,
      file,
      collection: collection || opts.collection || null,
      timestamps: !!opts.timestamps,
      fields: describe(schema),
      indexes: schema.indexes().map(([k, o]) => ({ keys: k, unique: !!(o && o.unique) })),
    });
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
console.log(`${path.basename(path.dirname(dir))}: ${out.models.length} models, ${out.errors.length} errors`);
for (const e of out.errors) console.log('  ERR', e.file, e.error);
