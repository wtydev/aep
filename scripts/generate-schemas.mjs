#!/usr/bin/env node
/**
 * Generate the published JSON Schemas into schemas/.
 *
 * Usage:
 *   node scripts/generate-schemas.mjs          # write schemas
 *   node scripts/generate-schemas.mjs --check  # verify on-disk files match (CI)
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'schemas');

const { buildJsonSchemas } = await import(join(root, 'packages/schema/dist/index.js'));

const schemas = buildJsonSchemas();
const names = Object.keys(schemas).sort();

const serialize = (schema) => JSON.stringify(schema, null, 2) + '\n';
const wanted = new Map(names.map((name) => [`${name}.schema.json`, serialize(schemas[name])]));
wanted.set('index.json', JSON.stringify({ schemas: names }, null, 2) + '\n');

const check = process.argv.includes('--check');

if (!existsSync(outDir)) {
  if (check) {
    console.error(`schemas/: directory does not exist`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
}

const differing = [];
const onDisk = new Set(readdirSync(outDir).filter((f) => f.endsWith('.schema.json')));

for (const [file, content] of wanted) {
  const path = join(outDir, file);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) differing.push(file);
}
for (const file of onDisk) {
  if (!wanted.has(file)) differing.push(`${file} (stale)`);
}

if (check) {
  if (differing.length > 0) {
    console.error('schemas/ is out of date. Run `pnpm schemas` and commit the result.');
    for (const file of differing.sort()) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log(`schemas/ is up to date (${names.length} schemas)`);
  process.exit(0);
}

for (const [file, content] of wanted) writeFileSync(join(outDir, file), content);
for (const file of onDisk) {
  if (!wanted.has(file)) rmSync(join(outDir, file));
}
console.log(`wrote ${wanted.size} files to schemas/ (${names.length} schemas)`);
