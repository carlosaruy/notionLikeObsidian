// Client for talking to Notion through our secure Vite dev proxy
// In development, calls go to /notion-api/... which the proxy forwards with the token from .env

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
  relationType: string;           // New richer field (preferred)
  type?: 'child' | 'mention' | 'relation'; // Legacy - will be phased out
  sourceProperty?: string;        // Name of the Notion relation property (when explicit)
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
            type: 'child',
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
              type: 'mention',
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

  const rootTitle = isDatabase 
    ? (rootEntity.title?.[0]?.plain_text || 'Untitled Database')
    : extractTitle(rootEntity);

  const rootType = isDatabase ? 'database' : 'page';

  nodes.push({
    id: rootEntity.id,
    label: rootTitle,
    type: rootType,
    notionUrl: rootEntity.url,
  });

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

              links.push({
                source: row.id,
                target: targetId,
                relationType: `explicit:${propName.toLowerCase().replace(/\s+/g, '_')}`,
              });
            }
          }
        }

        // Link de la fila a la base
        links.push({
          source: rootEntity.id,
          target: row.id,
          relationType: 'explicit:database_row',
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
            type: 'child',
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
              type: 'mention',
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
