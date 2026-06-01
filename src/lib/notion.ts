// Client for talking to Notion through our secure Vite dev proxy
// In development, calls go to /notion-api/... which the proxy forwards with the token from .env

import type { RelationType, RelationCategory } from './relationTypes';
import { normalizeExplicitRelationType, getRelationCategory, getSemanticLabel } from './relationTypes';

const API_BASE = '/notion-api/v1';

export interface NotionPage {
  id: string;
  title: string;
  url: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'page' | 'database';
  notionUrl?: string;
  layer?: 'borradores' | 'sleepbox' | 'other';
  group?: string;           // Nueva: categoría/temática principal a la que pertenece el nodo
  isCoreTarjeta?: boolean;  // Used by SleepBox Tabla loader (core row vs linked source)
}

/**
 * relationType examples:
 * - "explicit:tematica"
 * - "explicit:fuente_principal"
 * - "explicit:fuente_secundaria"
 * - "mention"
 * - "child_page"
 * - "source"
 */
export interface GraphLink {
  source: string;
  target: string;
  relationType: RelationType;           // Tipo canónico de relación (ver relationTypes.ts)
  sourceProperty?: string;              // Nombre original de la columna en Notion (cuando es explícita)
  category?: RelationCategory;          // membership | support | contradiction | generic
  semanticLabel?: string;               // Etiqueta lista para mostrar en UI
}

export async function fetchPage(pageId: string): Promise<any> {
  const cleanId = pageId.replace(/-/g, '');
  const res = await fetch(`${API_BASE}/pages/${cleanId}`, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    // Special case: the ID belongs to a database
    if (res.status === 400 && text.includes('is a database, not a page')) {
      const dbError = new Error('IS_DATABASE');
      (dbError as any).raw = text;
      throw dbError;
    }
    throw new Error(`Failed to fetch page: ${res.status} ${text}`);
  }

  return res.json();
}

export async function fetchDatabase(databaseId: string): Promise<any> {
  const cleanId = databaseId.replace(/-/g, '');
  const res = await fetch(`${API_BASE}/databases/${cleanId}`, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch database: ${res.status} ${text}`);
  }

  return res.json();
}

export async function queryDatabase(databaseId: string): Promise<any> {
  const cleanId = databaseId.replace(/-/g, '');
  const res = await fetch(`${API_BASE}/databases/${cleanId}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page_size: 100 }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to query database: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Fetches multiple pages in batches and returns a map of id -> title.
 * Useful to resolve titles of related pages when loading a database.
 */
async function fetchTitlesForIds(pageIds: string[], batchSize = 15): Promise<Map<string, string>> {
  const titleMap = new Map<string, string>();
  const uniqueIds = [...new Set(pageIds)];

  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const promises = batch.map(async (id) => {
      try {
        const page = await fetchPage(id);
        const title = extractTitle(page);
        if (title && title !== 'Untitled') {
          titleMap.set(id, title);
        }
      } catch (err) {
        // Ignore individual failures (page might be deleted or no access)
        console.warn(`Could not fetch title for page ${id}`);
      }
    });
    await Promise.all(promises);
    // Small delay between batches to be nice to Notion rate limits
    if (i + batchSize < uniqueIds.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return titleMap;
}

/**
 * Fetches the direct relations (child pages + mentions) of a single node.
 * This is used for "expand on click" functionality.
 */
export async function fetchDirectRelations(nodeId: string): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const newNodes: GraphNode[] = [];
  const newLinks: GraphLink[] = [];
  const cleanId = nodeId.replace(/-/g, '');

  try {
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      let url = `${API_BASE}/blocks/${cleanId}/children?page_size=100`;
      if (cursor) url += `&start_cursor=${cursor}`;

      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const text = await res.text();
        console.warn(`Failed to fetch children for expansion: ${res.status} ${text}`);
        break;
      }

      const data = await res.json();

      for (const block of data.results) {
        // Child pages
        if (block.type === 'child_page') {
          const childId = block.id;
          const childTitle = block.child_page?.title || 'Untitled';

          newNodes.push({
            id: childId,
            label: childTitle,
            type: 'page',
          });

          newLinks.push({
            source: nodeId,
            target: childId,
            relationType: 'child_page',
            semanticLabel: 'Página hija',
          });
        }

        // Mentions in rich text
        const richText = block[block.type]?.rich_text || [];
        for (const rt of richText) {
          if (rt.type === 'mention' && rt.mention?.type === 'page') {
            const mentionedId = rt.mention.page.id;
            const mentionedTitle = rt.plain_text || 'Untitled Page';

            newNodes.push({
              id: mentionedId,
              label: mentionedTitle,
              type: 'page',
            });

            newLinks.push({
              source: nodeId,
              target: mentionedId,
              relationType: 'mention',
              semanticLabel: 'Mención en contenido',
            });
          }
        }
      }

      hasMore = data.has_more;
      cursor = data.next_cursor;
    }
  } catch (err) {
    console.error('Error fetching direct relations for node', nodeId, err);
  }

  return { nodes: newNodes, links: newLinks };
}


export async function fetchBlockChildren(blockId: string, startCursor?: string): Promise<any> {
  const cleanId = blockId.replace(/-/g, '');
  let url = `${API_BASE}/blocks/${cleanId}/children?page_size=100`;
  if (startCursor) {
    url += `&start_cursor=${startCursor}`;
  }

  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch blocks: ${res.status} ${text}`);
  }

  return res.json();
}

// Very simplified graph builder for MVP
// Handles both regular pages and databases as root
export async function buildGraphFromPage(
  rootId: string, 
  maxDepth = 2,
  options: { shallowDatabase?: boolean } = {}
): Promise<{ nodes: GraphNode[]; links: GraphLink[]; isLargeDatabase?: boolean }> {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const visited = new Set<string>();

  let isDatabase = false;
  let rootEntity: any;

  try {
    rootEntity = await fetchPage(rootId);
  } catch (err: any) {
    if (err.message === 'IS_DATABASE') {
      isDatabase = true;
      rootEntity = await fetchDatabase(rootId);
    } else {
      throw err;
    }
  }



  // We will decide later (after querying the DB) whether to add the root as a
  // strong central node or use a lighter "DB" hub for Sleep Box style structures.
  // For now we always add it, but with a modified label when it's a Sleep Box DB.
  // The real "concept centering" improvement will come from stronger Temáticas clustering (see below).

  let isLargeDatabase = false;

  if (isDatabase) {
    try {
      const dbRows = await queryDatabase(rootId);
      const rows = dbRows.results || [];
      
      if (rows.length > 200) {
        isLargeDatabase = true;
      }

      // For large databases, only create nodes for the rows but skip deep recursion by default
      const shouldRecurse = !options.shallowDatabase;

      const dbTitle = rootEntity?.title?.[0]?.plain_text || rootEntity?.name || 'Database';
      const allPropNames = Object.keys(rows[0]?.properties || {});
      const isSleepBox = isSleepBoxDatabase(dbTitle, allPropNames);

      if (isSleepBox) {
        console.log(`[Sleep Box] Detectada base principal según convención del usuario: "${dbTitle}"`);
      }

      // Diagnóstico detallado de schema (muy útil para tu Sleep Box)
      if (rows.length > 0) {
        debugPrintSchemaAnalysis(dbTitle, rows[0].properties);
      }

      // Detectar si esta base tiene una columna de "Temáticas" (o similar)
      const tematicaPropName = Object.keys(rows[0]?.properties || {}).find(
        (name) => name.toLowerCase().includes('temática') || name.toLowerCase().includes('tematicas')
      );

      // Recopilar todos los IDs de páginas relacionadas de las columnas de relación
      const relatedPageIds = new Set<string>();

      for (const row of rows) {
        for (const propName in row.properties) {
          const prop = row.properties[propName];
          if (prop?.type === 'relation' && Array.isArray(prop.relation)) {
            prop.relation.forEach((r: any) => relatedPageIds.add(r.id));
          }
        }
      }

      // === Resolver títulos reales de las páginas relacionadas ===
      // Esto es clave para que el grafo tenga sentido conceptual desde el primer momento.
      console.log(`Resolviendo títulos de ${relatedPageIds.size} páginas relacionadas...`);
      const relatedTitles = await fetchTitlesForIds(Array.from(relatedPageIds));

      // Procesamos las filas con títulos reales ya resueltos
      for (const row of rows) {
        const rowTitle = extractTitle(row) || 'Untitled';

        // Agrupar por Temáticas
        let group: string | undefined;
        if (tematicaPropName) {
          const temProp = row.properties[tematicaPropName];
          if (temProp?.type === 'relation' && Array.isArray(temProp.relation) && temProp.relation.length > 0) {
            group = temProp.relation[0].id;
          }
        }

        if (!nodes.find(n => n.id === row.id)) {
          nodes.push({
            id: row.id,
            label: rowTitle,
            type: 'page',
            notionUrl: row.url,
            group,
            isCoreTarjeta: true,   // This row is an actual entry in the Tabla/Sleep Box, not a linked source
          });
        }

        // Crear relaciones explícitas con títulos reales
        for (const propName in row.properties) {
          const prop = row.properties[propName];
          if (prop?.type === 'relation' && Array.isArray(prop.relation)) {
            for (const related of prop.relation) {
              const targetId = related.id;
              const realTitle = relatedTitles.get(targetId);

              if (!nodes.find(n => n.id === targetId)) {
                nodes.push({
                  id: targetId,
                  label: realTitle || 'Untitled',
                  type: 'page',
                });
              }

              const normalizedType = normalizeExplicitRelationType(propName);
              const category = getRelationCategory(propName, normalizedType);
              const semanticLabel = getSemanticLabel(normalizedType, propName);

              links.push({
                source: row.id,
                target: targetId,
                relationType: normalizedType,
                sourceProperty: propName,
                category,
                semanticLabel,
              });
            }
          }
        }

        // Link de la fila a la base (genérico)
        links.push({
          source: rootEntity.id,
          target: row.id,
          relationType: 'explicit:database_row',
          category: 'membership',
          semanticLabel: 'Fila de Sleep Box',
        });

        if (shouldRecurse) {
          await traverseBlock(row.id, row.id, 0, maxDepth, nodes, links, visited);
        }
      }
    } catch (e) {
      console.warn('Could not query database rows', e);
    }
  } else {
    // Normal page: traverse its blocks
    await traverseBlock(rootEntity.id, rootEntity.id, 0, maxDepth, nodes, links, visited);
  }

  return { nodes, links, isLargeDatabase };
}

async function traverseBlock(
  blockId: string,
  parentId: string,
  depth: number,
  maxDepth: number,
  nodes: GraphNode[],
  links: GraphLink[],
  visited: Set<string>
) {
  if (depth > maxDepth || visited.has(blockId)) return;
  visited.add(blockId);

  try {
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const data = await fetchBlockChildren(blockId, cursor);
      
      for (const block of data.results) {
        // Child pages
        if (block.type === 'child_page') {
          const childId = block.id;
          const childTitle = block.child_page?.title || 'Untitled';

          if (!nodes.find(n => n.id === childId)) {
            nodes.push({
              id: childId,
              label: childTitle,
              type: 'page',
            });
          }

          links.push({
            source: parentId,
            target: childId,
            relationType: 'child_page',
            semanticLabel: 'Página hija',
          });

          // Recurse
          await traverseBlock(childId, childId, depth + 1, maxDepth, nodes, links, visited);
        }

        // Mentions inside rich text (paragraphs, headings, etc.)
        const richText = block[block.type]?.rich_text || [];
        for (const rt of richText) {
          if (rt.type === 'mention' && rt.mention?.type === 'page') {
            const mentionedId = rt.mention.page.id;
            const mentionedTitle = rt.plain_text || 'Untitled Page';

            if (!nodes.find(n => n.id === mentionedId)) {
              nodes.push({
                id: mentionedId,
                label: mentionedTitle,
                type: 'page',
              });
            }

            links.push({
              source: parentId,
              target: mentionedId,
              relationType: 'mention',
              semanticLabel: 'Mención en contenido',
            });
          }
        }

        // Continue recursion on blocks that have children
        if (block.has_children) {
          await traverseBlock(block.id, parentId, depth, maxDepth, nodes, links, visited);
        }
      }

      hasMore = data.has_more;
      cursor = data.next_cursor || undefined;
    }
  } catch (err) {
    console.error('Error traversing block', blockId, err);
  }
}

/**
 * Detecta si una base de datos parece ser la "Sleep Box" principal del usuario
 * según la convención que describió:
 * - Tiene una columna de relación llamada "Tarjetas" (o muy similar)
 * - O el título de la DB contiene "Sleep Box", "Temas", "Conceptual", etc.
 */
export function isSleepBoxDatabase(dbTitle: string, propertyNames: string[]): boolean {
  const titleLower = (dbTitle || '').toLowerCase();

  const looksLikeSleepBoxByTitle =
    titleLower.includes('sleep box') ||
    titleLower.includes('temas conceptual') ||
    titleLower.includes('mapa de conocimiento') ||
    titleLower.includes('caja de sueño'); // por si traduce

  const hasTarjetasColumn = propertyNames.some(name => {
    const n = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return n === 'tarjetas' || n === 'tarjeta' || n.includes('tarjeta');
  });

  return looksLikeSleepBoxByTitle || hasTarjetasColumn;
}

/**
 * Función de diagnóstico potente.
 * Llamala cuando cargues tu Sleep Box para ver exactamente cómo se interpreta cada columna.
 * 
 * Uso recomendado:
 * 1. npm run dev
 * 2. Pegá el ID de tu base en la UI
 * 3. Mirá la consola del navegador (F12) → vas a ver un bloque muy legible
 */
export function debugPrintSchemaAnalysis(
  dbTitle: string,
  properties: Record<string, any>
) {
  const propNames = Object.keys(properties);
  const isSleepBox = isSleepBoxDatabase(dbTitle, propNames);

  console.groupCollapsed(`%c[Sleep Box Schema Analysis] ${dbTitle}`, 'color:#f59e0b; font-weight:bold');

  console.log('¿Detectada como Sleep Box principal?', isSleepBox ? '✅ SÍ' : '❌ NO');
  console.log('Total de propiedades:', propNames.length);

  console.table(
    propNames.map((name) => {
      const prop = properties[name];
      const normalized = normalizeExplicitRelationType(name);
      const category = getRelationCategory(name, normalized);
      const label = getSemanticLabel(normalized, name);

      return {
        'Columna original': name,
        'Tipo Notion': prop?.type || '?',
        'RelationType': normalized,
        'Categoría': category,
        'Etiqueta semántica': label,
      };
    })
  );

  // Resumen por categoría
  const byCategory: Record<string, string[]> = {};
  propNames.forEach((name) => {
    const norm = normalizeExplicitRelationType(name);
    const cat = getRelationCategory(name, norm);
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(name);
  });

  console.log('%cResumen por categoría semántica:', 'font-weight:bold');
  Object.entries(byCategory).forEach(([cat, cols]) => {
    console.log(`  ${cat.toUpperCase().padEnd(14)} → ${cols.join(' | ')}`);
  });

  console.groupEnd();
}

function extractTitle(page: any): string {
  if (!page?.properties) return 'Untitled';

  // 1. Try to find any property with type === 'title' (most robust)
  for (const propName in page.properties) {
    const prop = page.properties[propName];
    if (prop?.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
      const titleText = prop.title.map((t: any) => t.plain_text || '').join('').trim();
      if (titleText) return titleText;
    }
  }

  // 2. Fallbacks for common names (backward compatibility)
  const titleProp = page.properties.title || page.properties.Name || page.properties.título;
  if (titleProp?.title?.[0]?.plain_text) {
    return titleProp.title[0].plain_text;
  }

  return 'Untitled';
}

/**
 * Extrae la lista actual de Temas de alto nivel desde la propiedad "Temáticas" (rich_text).
 * 
 * En el setup del usuario, esta propiedad está muy esparsa: solo unas pocas filas
 * tienen el nombre del tema cargado. Esas filas actúan como "definición" de los temas actuales.
 * 
 * Esta función es barata de llamar y es la que usaremos para refrescar la lista de temas
 * cuando detectemos un prefijo de temática nuevo en una tarjeta.
 */
export async function discoverHighLevelThemesFromSparseProperty(
  databaseId: string,
  tematicasPropertyName = 'Temáticas'
): Promise<string[]> {
  const cleanId = databaseId.replace(/-/g, '');
  const themes = new Set<string>();

  try {
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const body: any = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const res = await fetch(`${API_BASE}/databases/${cleanId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        console.warn('discoverHighLevelThemesFromSparseProperty: query failed', res.status);
        break;
      }

      const data = await res.json();

      for (const row of data.results || []) {
        const prop = row.properties?.[tematicasPropertyName];
        if (prop?.type === 'rich_text') {
          const value = prop.rich_text?.map((t: any) => t.plain_text || '').join('').trim();
          if (value) {
            themes.add(value);
          }
        }
      }

      hasMore = data.has_more;
      cursor = data.next_cursor;
    }
  } catch (err) {
    console.error('Error discovering high-level themes:', err);
  }

  return Array.from(themes).sort();
}

/**
 * Intenta extraer el tema de alto nivel a partir del prefijo del título de una Tarjeta.
 * Ejemplos: "1a Algo" → "1", "3e7d OSINT..." → "3", "2a1 foo" → "2"
 */
export function extractThemePrefixFromTitle(title: string): string | null {
  const match = title.match(/^(\d+[a-zA-Z0-9]*)/);
  if (!match) return null;

  // Normalizamos un poco: "1a", "1A", "1a1" → grupo principal "1"
  const raw = match[1];
  const mainNumber = raw.match(/^\d+/);
  return mainNumber ? mainNumber[0] : raw;
}
