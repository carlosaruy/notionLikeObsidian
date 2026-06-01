/**
 * Build a "fresh-ish" Graph Ready SQLite after the user's manual cleanups in Notion.
 *
 * What this does on top of the previous TematicaFixed DB:
 * - Fixes the title of the 3a1 node (removes leading dash so prefix extraction works).
 * - Removes the "curso http tcm academy" node entirely (and all edges pointing to/from it).
 * - Aggressively cleans tematica: only the exact 10 canonical themes are allowed.
 *   Any other numeric prefix (16, 17, 22, 560, etc.) is set to NULL.
 * - Recomputes basic stats.
 *
 * This gives us a cleaner base to start exploring the theme galaxies visualization
 * while we figure out the proper long-term refresh strategy.
 */

import initSqlJs from 'sql.js';
import fs from 'fs';

const INPUT_FILE = 'D:\\grokcli\\SleepBox_Graph_Ready_TematicaFixed_2026-06-01T13-00-45.sqlite';
const OUTPUT_FILE = `D:\\grokcli\\SleepBox_Graph_Ready_Cleaned_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.sqlite`;

const CANONICAL_THEMES = [
  "1 Aprendizaje en general",
  "2 Linux",
  "3 Pentesting",
  "4 Sociedad anonima",
  "5 Active directory",
  "6 análisis de comportamiento",
  "7 apuntes de juegos",
  "8 roadmaps",
  "9 administracion ubuntu",
  "10 Docencia"
];

const canonicalSet = new Set(CANONICAL_THEMES);

async function main() {
  console.log('=== BUILDING CLEAN FRESH GRAPH BASE (post user edits) ===\n');
  console.log('Input :', INPUT_FILE);
  console.log('Output:', OUTPUT_FILE);

  const SQL = await initSqlJs({ locateFile: f => 'public/sql-wasm.wasm' });
  const db = new SQL.Database(fs.readFileSync(INPUT_FILE));

  // 1. Fix the 3a1 title (user corrected the leading dash in Notion)
  console.log('\n[1] Fixing 3a1 title (removing leading dash)...');
  const fix3a1 = db.exec(`SELECT id, title FROM nodes WHERE title LIKE '%3a1%'`);
  if (fix3a1[0] && fix3a1[0].values.length > 0) {
    const [id, oldTitle] = fix3a1[0].values[0];
    const newTitle = oldTitle.replace(/^-+\s*/, '').trim(); // remove leading dashes/spaces
    console.log(`   Old: "${oldTitle}"`);
    console.log(`   New: "${newTitle}"`);
    // We can't easily UPDATE with sql.js prepared in this simple way for all cases, so we'll rebuild
  }

  // 2. Identify the TCM course node(s) to remove
  console.log('\n[2] Identifying TCM course node to remove...');
  const tcmNodes = db.exec(`SELECT id, title FROM nodes WHERE LOWER(title) LIKE '%tcm%' OR LOWER(title) LIKE '%curso http%'`);
  const tcmIds = [];
  if (tcmNodes[0]) {
    tcmNodes[0].values.forEach(r => {
      console.log(`   Found: "${r[1]}" (${r[0]})`);
      tcmIds.push(r[0]);
    });
  }
  console.log(`   Total TCM-related nodes to remove: ${tcmIds.length}`);

  // 3. Collect all current nodes + edges, applying cleanups
  console.log('\n[3] Rebuilding nodes and edges with cleanups...');

  const nodesRes = db.exec('SELECT id, title, is_core_tarjeta, tematica, node_type FROM nodes');
  const edgesRes = db.exec('SELECT source_id, target_id, edge_type, source_column, discovery_level FROM edges');

  const nodes = nodesRes[0] ? nodesRes[0].values : [];
  const edges = edgesRes[0] ? edgesRes[0].values : [];

  // Build set of IDs to remove (TCM course + any that only existed because of it)
  const idsToRemove = new Set(tcmIds);

  // Also remove any nodes that are now orphaned only because of TCM removal? For now we keep everything else.

  let cleanedNodes = 0;
  let themeCleaned = 0;
  let titleFixed = 0;

  const outDb = new SQL.Database();

  outDb.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      title TEXT,
      is_core_tarjeta BOOLEAN DEFAULT 0,
      tematica TEXT,
      node_type TEXT DEFAULT 'page'
    );

    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_column TEXT,
      discovery_level INTEGER,
      UNIQUE(source_id, target_id, edge_type)
    );

    /*
      node_positions
      ----------------
      Permite al usuario pinear manualmente nodos en el grafo (react-force-graph fx/fy)
      y que esas posiciones persistan entre sesiones.

      - Se popula desde el frontend cuando el usuario arrastra y suelta un nodo.
      - Al cargar el grafo, el frontend lee esta tabla y aplica fx/fy antes de iniciar la simulación.
      - Esto es clave para que las "galaxias de temas" se puedan organizar manualmente
        (ej: poner los nodos más importantes de cada tema en posiciones estables).
    */
    CREATE TABLE node_positions (
      node_id     TEXT PRIMARY KEY,
      x           REAL NOT NULL,
      y           REAL NOT NULL,
      pinned_at   INTEGER,           -- unix timestamp (ms)
      is_pinned   BOOLEAN DEFAULT 1
    );
  `);

  const insNode = outDb.prepare(`INSERT OR IGNORE INTO nodes (id, title, is_core_tarjeta, tematica, node_type) VALUES (?, ?, ?, ?, ?)`);
  const insEdge = outDb.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, source_column, discovery_level) VALUES (?, ?, ?, ?, ?)`);

  // Process nodes
  for (const [id, title, isCore, oldTematica, nodeType] of nodes) {
    if (idsToRemove.has(id)) {
      cleanedNodes++;
      continue;
    }

    let newTitle = title;
    // Fix the specific 3a1 case
    if (title && title.includes('3a1') && title.startsWith('-')) {
      newTitle = title.replace(/^-+\s*/, '').trim();
      titleFixed++;
    }

    let newTematica = oldTematica;
    if (newTematica && !canonicalSet.has(newTematica)) {
      newTematica = null;
      themeCleaned++;
    }

    // Re-apply prefix rule for safety (in case title was fixed)
    if (!newTematica && newTitle) {
      const match = newTitle.match(/^(\d+)/);
      if (match) {
        const num = match[1];
        const theme = CANONICAL_THEMES.find(t => t.startsWith(num + ' '));
        if (theme) newTematica = theme;
      }
    }

    insNode.run([id, newTitle, isCore, newTematica, nodeType]);
  }
  insNode.free();

  // Process edges - skip any that touch removed IDs
  let edgeCount = 0;
  for (const [source, target, edgeType, sourceCol, level] of edges) {
    if (idsToRemove.has(source) || idsToRemove.has(target)) {
      continue;
    }
    insEdge.run([source, target, edgeType, sourceCol, level]);
    edgeCount++;
  }
  insEdge.free();

  console.log(`   Nodes removed (TCM course related): ${cleanedNodes}`);
  console.log(`   Titles fixed (3a1 leading dash): ${titleFixed}`);
  console.log(`   Bogus themes purged (non-canonical): ${themeCleaned}`);
  console.log(`   Edges kept: ${edgeCount}`);

  // Copy other useful tables if they exist in input (best effort)
  const extraTables = ['tarjetas', 'tarjeta_relations', 'linked_page_relations', 'block_links'];
  for (const tbl of extraTables) {
    try {
      const createStmt = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tbl}'`);
      if (createStmt[0] && createStmt[0].values[0]) {
        outDb.exec(createStmt[0].values[0][0]);
        const data = db.exec(`SELECT * FROM ${tbl}`);
        if (data[0]) {
          const cols = data[0].columns;
          const ph = cols.map(() => '?').join(',');
          const ins = outDb.prepare(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${ph})`);
          data[0].values.forEach(row => {
            // Skip rows that reference removed IDs where it makes sense
            if (tbl.includes('relation') || tbl === 'block_links') {
              // crude filter
              const str = JSON.stringify(row);
              if (tcmIds.some(id => str.includes(id))) return;
            }
            ins.run(row);
          });
          ins.free();
        }
      }
    } catch (e) {
      // ignore if table doesn't exist or copy fails
    }
  }

  const data = outDb.export();
  fs.writeFileSync(OUTPUT_FILE, Buffer.from(data));

  // Final verification
  const verify = new SQL.Database(fs.readFileSync(OUTPUT_FILE));
  const finalTotal = verify.exec('SELECT COUNT(*) FROM nodes')[0].values[0][0];
  const finalWithTheme = verify.exec('SELECT COUNT(*) FROM nodes WHERE tematica IS NOT NULL')[0].values[0][0];
  const finalCores = verify.exec('SELECT COUNT(*) FROM nodes WHERE is_core_tarjeta = 1')[0].values[0][0];
  const finalThemes = verify.exec('SELECT DISTINCT tematica FROM nodes WHERE tematica IS NOT NULL').values?.length || 0;

  console.log('\n=== FINAL CLEAN BASE STATS ===');
  console.log(`Total nodes: ${finalTotal}`);
  console.log(`Core tarjetas: ${finalCores}`);
  console.log(`Nodes with valid canonical theme: ${finalWithTheme}`);
  console.log(`Distinct canonical themes used: ${finalThemes}`);

  // Report on new layout persistence table
  try {
    const posCount = verify.exec('SELECT COUNT(*) FROM node_positions')[0].values[0][0];
    console.log(`Saved pinned positions: ${posCount} (tabla node_positions lista para uso en frontend)`);
  } catch (e) {
    console.log('Tabla node_positions creada (vacía por ahora)');
  }

  // Check the specific fixes
  const check3a1 = verify.exec(`SELECT title, tematica FROM nodes WHERE title LIKE '%3a1%'`);
  if (check3a1[0] && check3a1[0].values[0]) {
    console.log(`\n3a1 node now: "${check3a1[0].values[0][0]}" → ${check3a1[0].values[0][1]}`);
  }

  const checkTCM = verify.exec(`SELECT COUNT(*) FROM nodes WHERE LOWER(title) LIKE '%tcm%'`);
  console.log(`Remaining nodes with "tcm" in title: ${checkTCM[0].values[0][0]}`);

  verify.close();
  db.close();
  outDb.close();

  console.log(`\nNew clean file written: ${OUTPUT_FILE}`);
  console.log('\nThis should be much better for starting to explore the theme galaxy visualization.');
}

main().catch(console.error);
