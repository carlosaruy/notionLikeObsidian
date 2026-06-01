/**
 * Real SQLite-backed cache using sql.js (runs in the browser via WebAssembly).
 *
 * Goal for now (as per user request):
 * - Move theme-related caching out of pure in-memory.
 * - Allow the user to inspect the actual database file.
 * - Persist across sessions using IndexedDB (store the .sqlite bytes).
 *
 * Tables (initial):
 *   themes
 *     - name TEXT PRIMARY KEY
 *     - last_seen INTEGER
 *
 *   meta
 *     - key TEXT PRIMARY KEY
 *     - value TEXT
 *
 * This is intentionally minimal and focused on the current debugging need
 * (high-level Temáticas list + detecting new themes).
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

// const DB_NAME = 'notionlikeobsidian-cache'; // kept for future IndexedDB full persistence
// const STORE_NAME = 'databases';
// const DB_KEY = 'main';

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (SQL) return SQL;

  // sql.js needs the wasm file. Vite will handle it if we configure it.
  // For now we rely on the default location (usually /sql-wasm.wasm or served by the package).
  SQL = await initSqlJs({
    locateFile: (_file: string) => `/sql-wasm.wasm`, // we copied it to public/
  });
  return SQL;
}

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
  // For now we start fresh each session.
  // The "Export" button is the main debugging tool.
  return Promise.resolve(null);
}

// Persistence via IndexedDB is optional for now.
// The important part for debugging is the "Export Cache DB" button,
// which lets the user download the .sqlite file and inspect the themes table.
async function saveToIndexedDB(_data: Uint8Array): Promise<void> {
  // TODO: implement real IndexedDB persistence when we need cross-session durability.
  return Promise.resolve();
}

export async function initDatabase(): Promise<Database> {
  if (db) return db;

  const SQL = await getSqlJs();
  const saved = await loadFromIndexedDB();

  if (saved) {
    db = new SQL.Database(saved);
  } else {
    db = new SQL.Database();
  }

  // Ensure schema exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS themes (
      name TEXT PRIMARY KEY,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tarjetas (
      id TEXT PRIMARY KEY,
      title TEXT,
      inferred_theme TEXT,
      theme_prefix TEXT,
      assignment_source TEXT,
      last_seen INTEGER
    );
  `);

  return db;
}

export async function persistDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export();
  await saveToIndexedDB(data);
}

/** Export the current database as a downloadable .sqlite file (for the user to inspect) */
export function exportDatabase(): void {
  if (!db) return;
  const data = db.export();
  const blob = new Blob([data as BlobPart], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notionlikeobsidian-cache.sqlite';
  a.click();
  URL.revokeObjectURL(url);
}

// ======================
// High-level theme cache API (matches what we need for debugging)
// ======================

export async function getKnownHighLevelThemes(): Promise<string[]> {
  const database = await initDatabase();
  const stmt = database.prepare('SELECT name FROM themes ORDER BY name');
  const results: string[] = [];

  while (stmt.step()) {
    results.push(stmt.get()[0] as string);
  }
  stmt.free();

  return results;
}

export async function saveHighLevelThemes(themes: string[], syncedAt: number): Promise<void> {
  const database = await initDatabase();

  const insert = database.prepare(`
    INSERT OR REPLACE INTO themes (name, last_seen) VALUES (?, ?)
  `);

  for (const theme of themes) {
    insert.run([theme, syncedAt]);
  }
  insert.free();

  // Update meta
  const metaStmt = database.prepare(`
    INSERT OR REPLACE INTO meta (key, value) VALUES ('last_themes_sync', ?)
  `);
  metaStmt.run([syncedAt.toString()]);
  metaStmt.free();

  await persistDatabase();
}

export async function getLastThemesSync(): Promise<number | null> {
  const database = await initDatabase();
  const stmt = database.prepare("SELECT value FROM meta WHERE key = 'last_themes_sync'");
  let result: number | null = null;

  if (stmt.step()) {
    const val = stmt.get()[0];
    result = val ? parseInt(val as string, 10) : null;
  }
  stmt.free();

  return result;
}

// Convenience: clear everything (useful during heavy debugging)
export async function clearAll(): Promise<void> {
  const database = await initDatabase();
  database.exec('DELETE FROM themes; DELETE FROM meta; DELETE FROM tarjetas;');
  await persistDatabase();
}

// ======================
// Node Positions Persistence (for manual pinning in SleepBox graphs)
// ======================

/**
 * Saves or updates the pinned position of a node.
 * This is intended to be called from GraphDemo on drag end.
 */
export async function saveNodePosition(nodeId: string, x: number, y: number): Promise<void> {
  const database = await initDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO node_positions (node_id, x, y, pinned_at, is_pinned)
    VALUES (?, ?, ?, ?, 1)
  `);
  stmt.run([nodeId, x, y, Date.now()]);
  stmt.free();
  await persistDatabase();
}

/**
 * Loads all saved positions as a Map<nodeId, {x, y}>
 */
export async function loadAllNodePositions(): Promise<Map<string, {x: number, y: number}>> {
  const database = await initDatabase();
  const stmt = database.prepare('SELECT node_id, x, y FROM node_positions WHERE is_pinned = 1');
  const positions = new Map<string, {x: number, y: number}>();

  while (stmt.step()) {
    const [id, x, y] = stmt.get() as [string, number, number];
    positions.set(id, { x, y });
  }
  stmt.free();

  return positions;
}

/**
 * Applies saved positions to an array of nodes (sets fx/fy so force simulation respects them).
 */
export async function applySavedPositionsToNodes(nodes: any[]): Promise<void> {
  const positions = await loadAllNodePositions();
  if (positions.size === 0) return;

  let applied = 0;
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos) {
      node.fx = pos.x;
      node.fy = pos.y;
      applied++;
    }
  }
  console.log(`[sqliteCache] Applied ${applied} saved pinned positions to nodes`);
}

/** Removes a single pinned position */
export async function unpinNode(nodeId: string): Promise<void> {
  const database = await initDatabase();
  const stmt = database.prepare('DELETE FROM node_positions WHERE node_id = ?');
  stmt.run([nodeId]);
  stmt.free();
  await persistDatabase();
}

/** Removes all pinned positions */
export async function unpinAllNodes(): Promise<void> {
  const database = await initDatabase();
  database.exec('DELETE FROM node_positions;');
  await persistDatabase();
}

// ======================
// Extended debug tables (nodes + theme assignments)
// ======================

/** Save a Tarjeta and its inferred theme assignment for debugging */
export async function saveTarjetaAssignment(
  id: string,
  title: string,
  inferredTheme: string | null,
  themePrefix: string | null,
  source: string,
  timestamp: number
): Promise<void> {
  const database = await initDatabase();

  const stmt = database.prepare(`
    INSERT OR REPLACE INTO tarjetas 
    (id, title, inferred_theme, theme_prefix, assignment_source, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run([id, title, inferredTheme, themePrefix, source, timestamp]);
  stmt.free();
}

/** Get all stored Tarjeta assignments (for inspection) */
export async function getAllTarjetaAssignments(): Promise<any[]> {
  const database = await initDatabase();
  const stmt = database.prepare(`
    SELECT id, title, inferred_theme, theme_prefix, assignment_source 
    FROM tarjetas 
    ORDER BY inferred_theme, title
  `);
  const out: any[] = [];
  while (stmt.step()) {
    const row = stmt.get();
    out.push({
      id: row[0],
      title: row[1],
      inferred_theme: row[2],
      theme_prefix: row[3],
      assignment_source: row[4],
    });
  }
  stmt.free();
  return out;
}

/** Bulk save many assignments (more efficient) */
export async function saveManyTarjetaAssignments(
  assignments: Array<{
    id: string;
    title: string;
    inferredTheme: string | null;
    themePrefix: string | null;
    source: string;
  }>,
  timestamp: number
): Promise<void> {
  const database = await initDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO tarjetas 
    (id, title, inferred_theme, theme_prefix, assignment_source, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const a of assignments) {
    stmt.run([a.id, a.title, a.inferredTheme, a.themePrefix, a.source, timestamp]);
  }
  stmt.free();
}

// ======================
// SleepBox Main DB Loader & Position Persistence (big unified SQLite files)
// This allows "visualización del cache": load the exported SleepBox_Graph_Ready_*.sqlite
// directly in the browser, keep layout (pinned positions) inside the same file.
// ======================

export async function loadSleepBoxDatabaseFromFile(file: File): Promise<{ db: Database; fileName: string }> {
  const SQL = await getSqlJs();
  const buffer = await file.arrayBuffer();
  const db = new SQL.Database(new Uint8Array(buffer));
  return { db, fileName: file.name };
}

/**
 * Builds react-force-graph compatible data from a SleepBox unified DB.
 * Creates virtual theme hub nodes from the `tematica` column.
 * Spreads the theme hubs initially so galaxies are visibly separate.
 */
export function buildGraphFromSleepBoxDb(db: Database) {
  // Nodes
  let nodesRes: any;
  try {
    nodesRes = db.exec('SELECT id, title, is_core_tarjeta, tematica, node_type FROM nodes');
  } catch (e) {
    nodesRes = db.exec('SELECT id, title, tematica FROM nodes');
  }
  const rawNodes = nodesRes?.[0]?.values || [];

  const graphNodes: any[] = [];
  const themeMap = new Map<string, any[]>();

  rawNodes.forEach((row: any[]) => {
    const [id, title, isCoreRaw, tematica, nodeType] = row;
    const isCore = !!isCoreRaw;
    const node: any = {
      id,
      label: title || 'Untitled',
      type: nodeType || (isCore ? 'tarjeta' : 'page'),
      isCoreTarjeta: isCore,
      tematica: tematica || null,
      val: isCore ? 5 : 3.5,
    };
    graphNodes.push(node);

    if (tematica && typeof tematica === 'string') {
      if (!themeMap.has(tematica)) themeMap.set(tematica, []);
      themeMap.get(tematica)!.push(node);
    }
  });

  // Virtual theme hubs + initial spread positions for visual separation
  const virtualThemeNodes: any[] = [];
  const virtualThemeLinks: any[] = [];
  const themeNames = Array.from(themeMap.keys());

  themeNames.forEach((themeName, i) => {
    const themeId = `theme-${themeName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')}`;
    const cards = themeMap.get(themeName)!;

    const hub: any = {
      id: themeId,
      label: themeName,
      type: 'theme',
      isVirtualTheme: true,
      val: Math.max(9, Math.min(20, Math.sqrt(cards.length) + 5)),
    };

    // Spread hubs in a large circle so they act as distinct galaxy centers from the start
    const angle = (i / Math.max(themeNames.length, 1)) * Math.PI * 2;
    const spreadRadius = 1400;
    hub.x = Math.cos(angle) * spreadRadius;
    hub.y = Math.sin(angle) * spreadRadius;

    virtualThemeNodes.push(hub);

    cards.forEach((card: any) => {
      virtualThemeLinks.push({
        source: themeId,
        target: card.id,
        relationType: 'in_theme',
        isVirtual: true,
      });
    });
  });

  // Edges from the DB
  let edgesRes: any;
  try {
    edgesRes = db.exec('SELECT source_id, target_id, edge_type, source_column FROM edges');
  } catch (e) {
    edgesRes = db.exec('SELECT source_id, target_id, edge_type FROM edges');
  }
  const rawEdges = edgesRes?.[0]?.values || [];

  const graphLinks = rawEdges.map((r: any[]) => ({
    source: r[0],
    target: r[1],
    relationType: r[2] || 'edge',
    sourceColumn: r[3] || null,
  }));

  const allNodes = [...graphNodes, ...virtualThemeNodes];
  const allLinks = [...graphLinks, ...virtualThemeLinks];

  return {
    nodes: allNodes,
    links: allLinks,
    themeCount: themeNames.length,
    totalNodes: graphNodes.length,
  };
}

/** Apply fx/fy from the node_positions table inside the loaded SleepBox DB */
export function applyPositionsFromSleepBoxDb(db: Database, nodes: any[]): number {
  try {
    const posRes = db.exec('SELECT node_id, x, y FROM node_positions WHERE is_pinned = 1 OR is_pinned IS NULL');
    if (!posRes?.[0]) return 0;

    const posMap = new Map<string, {x: number, y: number}>();
    posRes[0].values.forEach((r: any[]) => posMap.set(r[0], { x: r[1], y: r[2] }));

    let applied = 0;
    nodes.forEach((n) => {
      const p = posMap.get(n.id);
      if (p) {
        n.fx = p.x;
        n.fy = p.y;
        applied++;
      }
    });
    console.log(`[SleepBoxDB] Applied ${applied} pinned positions from the main DB`);
    return applied;
  } catch (e) {
    console.warn('[SleepBoxDB] No node_positions table or error reading positions', e);
    return 0;
  }
}

/** Persist a pin position directly into the loaded SleepBox DB (so it travels with the file) */
export function savePositionToSleepBoxDb(db: Database, nodeId: string, x: number, y: number) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_positions (
        node_id TEXT PRIMARY KEY,
        x REAL NOT NULL,
        y REAL NOT NULL,
        pinned_at INTEGER,
        is_pinned BOOLEAN DEFAULT 1
      )
    `);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO node_positions (node_id, x, y, pinned_at, is_pinned)
      VALUES (?, ?, ?, ?, 1)
    `);
    stmt.run([nodeId, x, y, Date.now()]);
    stmt.free();
  } catch (e) {
    console.error('Failed to write position into SleepBox DB', e);
  }
}

export function unpinNodeInSleepBoxDb(db: Database, nodeId: string) {
  try {
    const stmt = db.prepare('DELETE FROM node_positions WHERE node_id = ?');
    stmt.run([nodeId]);
    stmt.free();
  } catch (e) {}
}

export function unpinAllInSleepBoxDb(db: Database) {
  try {
    db.exec('DELETE FROM node_positions;');
  } catch (e) {}
}

/** Export the (possibly updated with new pins) DB as a downloadable file */
export function exportSleepBoxDb(db: Database, baseName: string = 'SleepBox_Graph_Ready') {
  const data = db.export();
  const blob = new Blob([data as BlobPart], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().slice(0,19).replace(/[:.]/g, '-');
  a.download = `${baseName}_with_layout_${ts}.sqlite`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}