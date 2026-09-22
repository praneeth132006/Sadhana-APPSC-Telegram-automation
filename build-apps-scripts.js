#!/usr/bin/env node
// ============================================================================
// Apps Script builder (build-apps-scripts.js)
// ============================================================================
// Writes one ready-to-paste Apps Script per group into apps-script/.
//
// Each sheet gets its own file with its own subjects already filled in, so
// there is nothing to configure inside Apps Script — paste, deploy, done.
//
// The files are GENERATED, never edited by hand. google_apps_script.js stays
// the single source of truth, so a fix reaches all five by re-running this
// instead of being applied to four of them and forgotten on the fifth. Each
// generated file says so at the top.
//
//   node build-apps-scripts.js
// ============================================================================

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const groups = require('./src/groups');

const SOURCE = path.resolve(__dirname, 'google_apps_script.js');
const OUT_DIR = path.resolve(__dirname, 'apps-script');

/** Builds the subject config rows for one group, as Apps Script source. */
function subjectBlock(group) {
  const rows = group.subjects.map((name, i) => {
    const code = groups.subjectCode(group, name);
    // Thread ids start at 6 to match the original sheet. They are placeholders
    // until `node setup.js` creates the real Telegram topics and writes the
    // ids into Config, which setupSpreadsheet then preserves.
    return `  { subject: ${JSON.stringify(name)}, threadId: ${6 + i}, ` +
           `cron: '0 */3 * * *', count: 5, code: '${code}' }`;
  });
  return rows.join(',\n');
}

function build() {
  const source = fs.readFileSync(SOURCE, 'utf8');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = groups.listGroups();
  const written = [];

  all.forEach((group) => {
    let out = source;

    // Replace the default subject list with this group's, and drop the
    // property lookup: a per-sheet file has no need to be told its subjects.
    const start = out.indexOf('var SUBJECT_CONFIG_LIST_DEFAULT = [');
    const end = out.indexOf('];', start) + 2;
    if (start === -1) {
      throw new Error('Could not find SUBJECT_CONFIG_LIST_DEFAULT in google_apps_script.js');
    }

    const replacement =
      `var SUBJECT_CONFIG_LIST_DEFAULT = [\n${subjectBlock(group)}\n];`;
    out = out.slice(0, start) + replacement + out.slice(end);

    const header = [
      '// ==========================================================================',
      `// ${group.displayName}`,
      '// ==========================================================================',
      '// GENERATED FILE — DO NOT EDIT HERE.',
      '//',
      '// Built from google_apps_script.js by `node build-apps-scripts.js`.',
      '// Edit that file and re-run the builder; editing this copy means the fix',
      `// lives in one of ${all.length} sheets and is lost the next time it is rebuilt.`,
      '//',
      `// Group id : ${group.id}`,
      `// Subjects : ${group.subjects.length}`,
      `//            ${group.subjects.join(', ')}`,
      `// Built    : ${new Date().toISOString()}`,
      '// ==========================================================================',
      '',
      ''
    ].join('\n');

    const file = path.join(OUT_DIR, `${group.id}.gs.js`);
    fs.writeFileSync(file, header + out);
    written.push({ file, group });
  });

  console.log(`\nWrote ${written.length} scripts to apps-script/\n`);
  written.forEach(({ file, group }) => {
    console.log(`  ${path.basename(file).padEnd(22)} ${group.displayName}`);
    console.log(`  ${''.padEnd(22)} ${group.subjects.length} subjects`);
  });
  console.log('\nPaste each file into ITS OWN sheet. They are not interchangeable.\n');
}

try {
  build();
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
