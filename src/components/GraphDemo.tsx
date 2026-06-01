import { useState, useRef, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { buildGraphFromPage, fetchDirectRelations } from '../lib/notion';
import { InMemoryPageCache } from '../lib/cache';
import { getOrRefreshHighLevelThemes, processTarjetasForThemes } from '../lib/themeInference';
import * as sqliteCache from '../lib/sqliteCache'; // real SQLite cache for debugging + SleepBox DB loader + positions in main DB

export default function GraphDemo() {
  const [graphData, setGraphData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageInput, setPageInput] = useState('c51020805fb849e7a9e41208cae7cdc1'); // Default: user's Tabla view
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [hoveredNode, setHoveredNode] = useState<any>(null);

  // Context menu state (right click on node)
  const [contextMenu, setContextMenu] = useState<{
    node: any;
    x: number;
    y: number;
  } | null>(null);

  // === New DB-first mode for SleepBox ===
  // Load the exported SleepBox_Graph_Ready_*.sqlite and keep everything (including pins) in it.
  const [isDbMode, setIsDbMode] = useState(false);
  const [dbFileName, setDbFileName] = useState<string | null>(null);
  const loadedDbRef = useRef<any>(null); // the sql.js Database instance for the big SleepBox file
  const [isLoadingDb, setIsLoadingDb] = useState(false);
  const fgRef = useRef<any>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [loadDepth, setLoadDepth] = useState(3);

  // Persistent cache for the session
  const cacheRef = useRef(new InMemoryPageCache());

  // Theme inference results (for debugging + UI)
  const [themeDebugInfo, setThemeDebugInfo] = useState<{
    highLevelThemes: string[];
    assignedCount: number;
    totalTarjetas: number;
    themeCounts: Record<string, number>;
  } | null>(null);

  // Live visualization tuning controls
  const [visualSettings, setVisualSettings] = useState({
    labelSeparation: 8,           // base vertical separation (higher = more space above node)
    fontSizeBase: 11,             // base font size (more direct control now)
    bgOpacity: 0.92,              // label background opacity
    zoomThreshold: 2.0,           // minimum globalScale to show labels
    showConnector: true,          // draw line from node to label
    largeGraphNodeScale: 0.7,     // node size multiplier when >400 nodes
    useRadialLabels: true,        // place labels outward from center (great for ring-style DBs)
    nodeCharge: -90,              // repulsion between nodes (more negative = more separation)
  });

  // Force canvas refresh when any visual setting changes.
  // Font size especially needs aggressive refresh because it's drawn inside nodeCanvasObject.
  useEffect(() => {
    const refresh = () => {
      if (fgRef.current?.refresh) {
        fgRef.current.refresh();
      }
    };

    refresh();
    // Some canvas updates need a second tick
    const t = setTimeout(refresh, 60);
    return () => clearTimeout(t);
  }, [visualSettings]);



  // Demo data shown until user loads real data
  const demoData = {
    nodes: [
      { id: 'root', label: 'My Life OS (Demo)', type: 'page', val: 8 },
      { id: 'projects', label: 'Projects', type: 'page', val: 5 },
      { id: 'p1', label: 'notionLikeObsidian', type: 'page', val: 3 },
      { id: 'db1', label: 'Tasks Database', type: 'database', val: 7 },
    ],
    links: [
      { source: 'root', target: 'projects', type: 'child' },
      { source: 'projects', target: 'p1', type: 'child' },
      { source: 'p1', target: 'db1', type: 'mention' },
      { source: 'root', target: 'db1', type: 'mention' },
    ],
  };

  const currentData = graphData || demoData;

  // Configurar fuerzas del grafo
  // Special handling for theme hubs: much stronger repulsion so the galaxies stay visibly separated.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !currentData?.nodes) return;

    const nodeCount = currentData.nodes.length;

    const baseCharge = visualSettings.nodeCharge ?? (nodeCount > 300 ? -140 : -70);

    // Per-node charge: theme hubs get very strong repulsion so they act as distinct centers
    fg.d3Force('charge')?.strength((node: any) => {
      if (node.isVirtualTheme) {
        return -900; // strong separation between the 10 temáticas
      }
      return baseCharge;
    });

    // Make virtual theme links longer so cards hang farther from the hub
    fg.d3Force('link')?.distance((link: any) => {
      if (link.isVirtual) return 180;
      return nodeCount > 300 ? 55 : 32;
    });

    fg.d3ReheatSimulation?.();
  }, [currentData, visualSettings.nodeCharge]);

  const handleLoadReal = async (forcedId?: string) => {
    const idToLoad = forcedId || pageInput;

    if (!idToLoad.trim()) {
      setError('Please paste a Notion page URL or ID');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Extract ID from URL if needed
      const idMatch = idToLoad.match(/[0-9a-f]{32}/i) || idToLoad.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const entityId = idMatch ? idMatch[0].replace(/-/g, '') : idToLoad.trim();

      const result = await buildGraphFromPage(entityId, loadDepth, { shallowDatabase: true });

      if (result.isLargeDatabase) {
        console.info('Large database detected — loaded in shallow mode');
      }

      // === Theme Inference (hybrid: sparse "Temáticas" + title prefixes) ===
      // This must happen BEFORE setting the graph data.
      let enrichedNodes = result.nodes;

      try {
        const cache = cacheRef.current;

        // Focus theme inference primarily on *core* Tarjetas (the actual rows of the Tabla database).
        // The other nodes are things linked via Fuentes/Anécdotas/etc. — they can inherit later.
        const coreTarjetaNodes = result.nodes.filter((n: any) => n.isCoreTarjeta === true);
        const otherRelatedNodes = result.nodes.filter((n: any) => n.label && !n.type?.includes('database') && !n.isCoreTarjeta);
        const titles = coreTarjetaNodes.map((n: any) => n.label);

        const { seenPrefixes } = processTarjetasForThemes(titles, []);

        const highLevelThemes = await getOrRefreshHighLevelThemes(
          entityId,
          cache,
          seenPrefixes
        );

        // Persist to real SQLite DB so the user can inspect the actual file
        try {
          await sqliteCache.saveHighLevelThemes(highLevelThemes, Date.now());
        } catch (e) {
          console.warn('Failed to persist themes to SQLite', e);
        }

        if (highLevelThemes.length > 0) {
          console.groupCollapsed('%c[Theme Inference] High-level Temáticas (from sparse property + cache)', 'color:#10b981; font-weight:bold');
          highLevelThemes.forEach(t => console.log(`  • ${t}`));
          console.groupEnd();
        }

        const { assignments } = processTarjetasForThemes(titles, highLevelThemes);

        let assignedCount = 0;

        // Create a new array with enriched nodes (don't mutate the original result)
        enrichedNodes = result.nodes.map((node: any) => {
          if (!node.isCoreTarjeta) {
            // Non-core nodes (linked sources, etc.) keep their data but don't get primary theme treatment here
            return { ...node, val: node.type === 'database' ? 8 : 4 };
          }

          // Find the corresponding assignment for this core Tarjeta
          const idx = coreTarjetaNodes.findIndex((t: any) => t.id === node.id);
          const assignment = idx >= 0 ? assignments[idx] : null;

          const enriched = { ...node, val: 4 };

          if (assignment?.theme) {
            enriched.inferredTheme = assignment.theme;
            enriched.themePrefix = assignment.prefix;
            assignedCount++;
          } else if (assignment?.prefix) {
            enriched.themePrefix = assignment.prefix;
            enriched.inferredTheme = `Unknown theme (${assignment.prefix})`;
          }

          return enriched;
        });

        console.log(
          `%c[Theme Inference] Attached theme to ${assignedCount}/${coreTarjetaNodes.length} core Tarjetas (hybrid: sparse values + title prefixes). ${otherRelatedNodes.length} related nodes loaded separately.`,
          'color:#8b5cf6'
        );

        // Build per-theme counts for the debug panel (only core Tarjetas)
        const themeCounts: Record<string, number> = {};
        enrichedNodes.forEach((n: any) => {
          if (n.isCoreTarjeta && n.inferredTheme && !n.inferredTheme.startsWith('Unknown')) {
            themeCounts[n.inferredTheme] = (themeCounts[n.inferredTheme] || 0) + 1;
          }
        });

        setThemeDebugInfo({
          highLevelThemes,
          assignedCount,
          totalTarjetas: coreTarjetaNodes.length,
          themeCounts,
        });

        // Persist per-Tarjeta assignments to SQLite for debugging/inspection (only core ones)
        try {
          const assignmentsForDb = coreTarjetaNodes.map((node: any, i: number) => {
            const a = assignments[i];
            return {
              id: node.id,
              title: node.label,
              inferredTheme: a?.theme ?? null,
              themePrefix: a?.prefix ?? null,
              source: a?.source ?? 'unknown',
            };
          });
          await sqliteCache.saveManyTarjetaAssignments(assignmentsForDb, Date.now());
        } catch (e) {
          console.warn('Failed to save Tarjeta assignments to SQLite', e);
        }
      } catch (e) {
        console.warn('[Theme Inference] Could not run theme assignment', e);
        // Fallback: still render the graph even if theme inference fails
        enrichedNodes = result.nodes.map(n => ({
          ...n,
          val: n.type === 'database' ? 8 : 4
        }));
      }

      // Now build and set the final graph data (with themes attached)
      let finalNodes = enrichedNodes;
      let finalLinks = result.links.map(l => ({ ...l }));

      // === Visual Galaxies: Create virtual "Theme" hub nodes ===
      // This is the key to seeing the "galaxias de conceptos" structure.
      try {
        const themeMap = new Map<string, any[]>();

        enrichedNodes.forEach((node: any) => {
          if (node.inferredTheme && !node.inferredTheme.startsWith('Unknown')) {
            if (!themeMap.has(node.inferredTheme)) {
              themeMap.set(node.inferredTheme, []);
            }
            themeMap.get(node.inferredTheme)!.push(node);
          }
        });

        if (themeMap.size > 0) {
          const virtualThemeNodes: any[] = [];
          const virtualThemeLinks: any[] = [];

          themeMap.forEach((cards, themeName) => {
            const themeId = `theme-${themeName.replace(/\s+/g, '-')}`;

            // Create a virtual hub node for the theme
            virtualThemeNodes.push({
              id: themeId,
              label: themeName,
              type: 'theme',
              val: Math.max(6, Math.min(14, Math.sqrt(cards.length) + 3)),
              isVirtualTheme: true,
            });

            // Connect every card of this theme to the hub (weak structural link)
            cards.forEach((card: any) => {
              virtualThemeLinks.push({
                source: themeId,
                target: card.id,
                relationType: 'in_theme',
                isVirtual: true,
              });
            });
          });

          finalNodes = [...enrichedNodes, ...virtualThemeNodes];
          finalLinks = [...finalLinks, ...virtualThemeLinks];

          console.log(`%c[Theme Inference] Created ${virtualThemeNodes.length} virtual theme hubs for galaxy view`, 'color:#f59e0b');
        }
      } catch (e) {
        console.warn('[Theme Inference] Failed to create virtual theme hubs', e);
      }

      const formatted = {
        nodes: finalNodes,
        links: finalLinks,
      };

      setGraphData(formatted);
      setSelectedNode(null);

      // In DB mode positions are already applied by applyPositionsFromSleepBoxDb right after buildGraph.
      // This old path is only for the small debug cache when not in DB mode.
      if (!loadedDbRef.current) {
        setTimeout(async () => {
          try {
            await sqliteCache.applySavedPositionsToNodes(finalNodes);
            if (fgRef.current?.refresh) fgRef.current.refresh();
          } catch (e) {
            console.warn('Failed to apply saved node positions', e);
          }
        }, 80);
      }
    } catch (err: any) {
      console.error(err);
      let friendlyMessage = err.message || 'Failed to load from Notion.';

      if (friendlyMessage.includes('is a database, not a page')) {
        friendlyMessage = 'This ID belongs to a Database. The tool now supports databases — try again.';
      } else if (friendlyMessage.includes('object_not_found') || friendlyMessage.includes('Could not find')) {
        friendlyMessage = 'The integration "conexión grafos" does not have access to this page/database. Go to the page in Notion → ... → Connections → share it with "conexión grafos".';
      }

      setError(friendlyMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // === Auto-load behavior changed for testing ===
  // By default we now prefer loading from the local SleepBox SQLite (cache visualization).
  // No more automatic Notion queries on every browser refresh while we tune the viz.
  // User drops the exported .sqlite once, and on subsequent refreshes we can restore from IndexedDB (future)
  // or they re-drop the file. "Refrescar" buttons will re-enable live Notion later.
  const hasAutoLoadedRef = useRef(false);

  // Disabled the old auto Notion load for DB-first workflow.
  // useEffect(() => { ... handleLoadReal ... }) commented out intentionally.

  // Load a SleepBox unified DB file (the one generated by build_clean_fresh_graph.js etc.)
  const handleLoadSleepBoxFile = async (file: File) => {
    setIsLoadingDb(true);
    setError(null);
    try {
      const { db, fileName } = await sqliteCache.loadSleepBoxDatabaseFromFile(file);

      const graph = sqliteCache.buildGraphFromSleepBoxDb(db);

      // Apply any previously pinned positions that live inside this same DB file
      const applied = sqliteCache.applyPositionsFromSleepBoxDb(db, graph.nodes);

      // Keep reference to the DB so we can write positions back into it
      loadedDbRef.current = db;
      setDbFileName(fileName);
      setIsDbMode(true);

      const formatted = {
        nodes: graph.nodes,
        links: graph.links,
      };

      setGraphData(formatted);
      setSelectedNode(null);
      setThemeDebugInfo(null); // old Notion theme debug not relevant in pure DB mode

      console.log(`%c[SleepBox DB] Loaded ${graph.totalNodes} nodes + ${graph.themeCount} theme galaxies from ${fileName}. Positions applied: ${applied}`, 'color:#22c55e');

      // Optional: store bytes for "auto load on refresh" (simple IndexedDB)
      try {
        const buf = await file.arrayBuffer();
        // Reuse the existing pattern - store under a dedicated key for big DB
        // (the existing saveToIndexedDB is stubbed, so we do a quick direct one here)
        const idb = await openSimpleIdb();
        const tx = idb.transaction(['sleepbox'], 'readwrite');
        tx.objectStore('sleepbox').put({ key: 'last-db', data: new Uint8Array(buf), name: fileName, ts: Date.now() });
      } catch (e) { /* non critical */ }

    } catch (err: any) {
      console.error(err);
      setError('Failed to load SleepBox SQLite: ' + (err.message || err));
    } finally {
      setIsLoadingDb(false);
    }
  };

  // Quick IndexedDB helper for auto-restore of last SleepBox DB on browser refresh
  async function openSimpleIdb() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sleepbox-viz-db', 1);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains('sleepbox')) idb.createObjectStore('sleepbox', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = reject;
    });
  }

  // Try to auto-restore last SleepBox DB on mount (so "al reiniciar el server" it loads from "the cache")
  useEffect(() => {
    if (hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;

    (async () => {
      try {
        const idb = await openSimpleIdb();
        const tx = idb.transaction(['sleepbox'], 'readonly');
        const getReq = tx.objectStore('sleepbox').get('last-db');
        getReq.onsuccess = async () => {
          const record = getReq.result;
          if (record?.data) {
            // Reconstruct a File-like for the loader
            const blob = new Blob([record.data]);
            const fakeFile = new File([blob], record.name || 'SleepBox_Last.sqlite', { type: 'application/x-sqlite3' });
            console.log('%c[SleepBox DB] Auto-restoring last DB from browser storage...', 'color:#eab308');
            await handleLoadSleepBoxFile(fakeFile);
          }
        };
      } catch (e) {
        // no previous DB or IndexedDB not available — user will drop the file manually
      }
    })();
  }, []);

  const handleNodeClick = async (node: any) => {
    setSelectedNode(node);

    // In pure DB / cache visualization mode we don't do live Notion expansion.
    // All data (nodes + edges) is already in the loaded SQLite.
    // This prevents the previous bug where touching a node would make the viz collapse or disappear.
    if (isDbMode || loadedDbRef.current) {
      // Still allow selecting and showing context menu via right click
      return;
    }

    // === Below is the old live expansion path (for when we re-enable Notion refreshes) ===
    if (expandedNodes.has(node.id)) {
      return;
    }

    setExpandedNodes(prev => new Set(prev).add(node.id));

    try {
      const { nodes: newNodes, links: newLinks } = await fetchDirectRelations(node.id);

      if (newNodes.length === 0 && newLinks.length === 0) {
        return;
      }

      setGraphData((prev: any) => {
        if (!prev) return prev;

        const existingIds = new Set(prev.nodes.map((n: any) => n.id));

        const mergedNodes = [
          ...prev.nodes,
          ...newNodes.filter((n: any) => !existingIds.has(n.id))
        ];

        const mergedLinks = [...prev.links, ...newLinks];

        return {
          nodes: mergedNodes,
          links: mergedLinks,
        };
      });

      setTimeout(() => {
        fgRef.current?.d3ReheatSimulation?.();
      }, 50);

    } catch (err) {
      console.error('Failed to expand node', node.id, err);
      setExpandedNodes(prev => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  };

  // Pin node in place when user finishes dragging it
  const handleNodeDragEnd = async (node: any) => {
    // Fix the node position so force simulation doesn't move it anymore
    node.fx = node.x;
    node.fy = node.y;

    // Persist into the main SleepBox DB if loaded (preferred, travels with your file)
    if (loadedDbRef.current) {
      sqliteCache.savePositionToSleepBoxDb(loadedDbRef.current, node.id, node.x, node.y);
    } else {
      try {
        await sqliteCache.saveNodePosition(node.id, node.x, node.y);
      } catch (e) {
        console.warn('Could not persist node position', e);
      }
    }

    // Force a refresh so the UI reflects the pinned state if needed
    if (fgRef.current?.refresh) {
      fgRef.current.refresh();
    }
  };

  const unpinAllNodes = async () => {
    if (!graphData) return;

    graphData.nodes.forEach((node: any) => {
      delete node.fx;
      delete node.fy;
    });

    if (loadedDbRef.current) {
      sqliteCache.unpinAllInSleepBoxDb(loadedDbRef.current);
    } else {
      try {
        await sqliteCache.unpinAllNodes();
      } catch (e) {
        console.warn('Could not clear persisted positions', e);
      }
    }

    // Reheat simulation so nodes can move again
    setGraphData({ ...graphData });
    setTimeout(() => {
      fgRef.current?.d3ReheatSimulation?.();
    }, 10);
  };

  const resetToDemo = () => {
    setGraphData(null);
    setSelectedNode(null);
    setPageInput('');
    setError(null);
    setLoadDepth(3); // reset depth too
    setContextMenu(null);
  };

  // === Context Menu Actions ===
  const closeContextMenu = () => setContextMenu(null);

  const openInNotion = (node: any) => {
    if (!node?.id) return;
    // Clean ID and build Notion URL (Notion handles the redirect)
    const cleanId = node.id.replace(/-/g, '');
    const url = `https://www.notion.so/${cleanId}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    closeContextMenu();
  };

  const pinNodeFromMenu = async (node: any) => {
    if (!node) return;
    node.fx = node.x;
    node.fy = node.y;

    // If we have a loaded main SleepBox DB, write the position into it (preferred)
    if (loadedDbRef.current) {
      sqliteCache.savePositionToSleepBoxDb(loadedDbRef.current, node.id, node.x, node.y);
    } else {
      try { await sqliteCache.saveNodePosition(node.id, node.x, node.y); } catch (e) {}
    }

    if (fgRef.current?.refresh) fgRef.current.refresh();
    closeContextMenu();
  };

  const unpinNodeFromMenu = async (node: any) => {
    if (!node) return;
    delete node.fx;
    delete node.fy;

    if (loadedDbRef.current) {
      sqliteCache.unpinNodeInSleepBoxDb(loadedDbRef.current, node.id);
    } else {
      try { await sqliteCache.unpinNode(node.id); } catch (e) {}
    }

    if (fgRef.current?.refresh) fgRef.current.refresh();
    closeContextMenu();
  };

  return (
    <div className="flex h-[calc(100vh-120px)] gap-4 p-4">
      {/* Graph Area */}
      <div className="flex-1 graph-container flex flex-col">
        <div className="p-3 border-b border-[#2a2d36] flex items-center gap-3 bg-[#16181f] flex-wrap">
          {/* DB-first controls for SleepBox - "visualización del cache" */}
          <label className="btn cursor-pointer">
            {isLoadingDb ? 'Loading DB...' : 'Load SleepBox SQLite file'}
            <input
              type="file"
              accept=".sqlite,application/x-sqlite3"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLoadSleepBoxFile(f);
                // allow selecting the same file again
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>

          {isDbMode && dbFileName && (
            <>
              <span className="text-xs px-2 py-1 bg-emerald-900/40 text-emerald-400 rounded">
                DB: {dbFileName}
              </span>
              <button
                onClick={() => {
                  if (loadedDbRef.current) {
                    sqliteCache.exportSleepBoxDb(loadedDbRef.current, dbFileName.replace(/\.sqlite$/, ''));
                  }
                }}
                className="btn-secondary px-3 py-1 text-xs"
                title="Download the current DB including any newly pinned node positions (saved inside the file)"
              >
                Export DB with layout
              </button>
              <button
                onClick={unpinAllNodes}
                className="btn-secondary px-3 py-1 text-xs"
              >
                Unpin all
              </button>
            </>
          )}

          {/* Old Notion controls kept for future "Refrescar" */}
          <div className="flex items-center gap-2 ml-2 border-l border-[#3a3f4a] pl-3">
            <input
              type="text"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              placeholder="Notion ID (for future refresh)"
              className="input w-64 text-xs"
            />
            <button
              onClick={() => handleLoadReal()}
              disabled={isLoading}
              className="btn-secondary text-xs px-2 py-1"
              title="Live Notion fetch (will be used for 'Refrescar todo' / 'Refrescar tema' later)"
            >
              {isLoading ? '...' : 'Refresh from Notion (future)'}
            </button>
          </div>

          {/* Depth (only for live Notion mode) */}
          <div className="flex items-center gap-1.5 text-xs text-[#6b7280]">
            <span>Depth</span>
            <input
              type="number"
              min={1}
              max={6}
              value={loadDepth}
              onChange={(e) => setLoadDepth(Math.max(1, Math.min(6, parseInt(e.target.value) || 3)))}
              className="input w-14 py-1 px-2 text-center"
            />
          </div>

          {graphData && (
            <button onClick={resetToDemo} className="btn-secondary px-3 py-1.5 text-xs">
              Reset
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-900/30 text-red-400 p-3 text-sm border-b border-red-900">
            {error}
          </div>
        )}

        <div className="flex-1" onClick={() => setContextMenu(null)}>
          <ForceGraph2D
            ref={fgRef}
            graphData={currentData}
            nodeColor={(node: any) => {
              if (node.isVirtualTheme) {
                return '#f59e0b'; // Amber/gold for theme hubs — stands out
              }

              const theme = node.inferredTheme || node.group;

              if (theme) {
                const hash = theme.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
                const hue = (hash * 37) % 360;
                return `hsl(${hue}, 68%, 55%)`;
              }
              return node.type === 'database' ? '#10b981' : '#3b82f6';
            }}
            nodeRelSize={currentData.nodes.length > 400 ? 3.5 : 5.5}
            linkColor={(link: any) => {
              const rel = link.relationType || link.type;
              const cat = link.category;

              if (link.isVirtual) {
                return 'rgba(245, 158, 11, 0.35)'; // Subtle gold for theme hub connections
              }

              // Contradicciones / tensión (Fuentes terciarias) → rojo intenso
              if (rel === 'explicit:fuentes_terciarias' || cat === 'contradiction') {
                return '#ef4444';
              }

              // Explicit support (primarias/secundarias) → naranja/ámbar cálido
              if (rel?.startsWith('explicit') || cat === 'support') {
                return '#f59e0b';
              }

              if (rel === 'mention') return '#8b5cf6';
              if (rel === 'child_page' || rel === 'child') return '#3b82f6';
              return '#6b7280';
            }}
            linkWidth={(link: any) => {
              if (link.isVirtual) {
                return currentData?.nodes?.length > 400 ? 0.6 : 1.0; // Thin for theme hub connections
              }

              const rel = link.relationType || link.type;
              const cat = link.category;

              if (rel === 'explicit:fuentes_terciarias' || cat === 'contradiction') {
                return currentData.nodes.length > 400 ? 1.4 : 2.0;
              }
              if (rel?.startsWith('explicit') || cat === 'support' || cat === 'membership') {
                return currentData.nodes.length > 400 ? 1.2 : 1.8;
              }
              return currentData.nodes.length > 400 ? 0.7 : 1.2;
            }}
            onNodeClick={handleNodeClick}
            onNodeRightClick={(node: any, event: any) => {
              // Show context menu
              setContextMenu({
                node,
                x: event.pageX || event.clientX,
                y: event.pageY || event.clientY,
              });
              setSelectedNode(node);
            }}
            onNodeDragEnd={handleNodeDragEnd}
            onNodeHover={setHoveredNode}
            cooldownTicks={currentData.nodes.length > 600 ? 50 : 100}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            enableNodeDrag={true}
            width={undefined}
            height={undefined}
            nodeCanvasObject={(node: any, ctx, globalScale) => {
              const isDatabase = node.type === 'database';
              const nodeScale = currentData.nodes.length > 400 ? visualSettings.largeGraphNodeScale : 1;

              // Make the root Sleep Box / DB node visually lighter when we have Temáticas grouping
              const isSleepBoxRoot = isDatabase && node.label?.includes('(DB)');
              const radius = (isDatabase ? (isSleepBoxRoot ? 5 : 9) : 5) * nodeScale;
              const label = node.label || '';
              // Much more direct font size control — the slider now has stronger effect
              const fontSize = Math.max(6, visualSettings.fontSizeBase * (0.8 + Math.min(globalScale, 4) * 0.12));
              const isExpanded = expandedNodes.has(node.id);

              // Draw node circle
              if (node.isVirtualTheme) {
                // Theme hubs: distinct look (rounded square-ish) + gold to clearly separate galaxies
                ctx.fillStyle = '#f59e0b';
                ctx.beginPath();
                const s = radius * 1.1;
                ctx.roundRect(node.x - s, node.y - s, s * 2, s * 2, 4 / globalScale);
                ctx.fill();
              } else {
                ctx.beginPath();
                ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                ctx.fillStyle = isDatabase ? '#10b981' : '#3b82f6';
                ctx.fill();
              }

              // Draw white ring for selected/hovered
              if (selectedNode?.id === node.id || hoveredNode?.id === node.id) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5 / globalScale;
                ctx.stroke();
              }

              // Small pin indicator for manually pinned nodes (fx/fy set)
              if (node.fx != null && node.fy != null) {
                ctx.fillStyle = '#f59e0b';
                ctx.beginPath();
                ctx.arc(node.x - radius * 0.75, node.y + radius * 0.75, 2.2 / globalScale, 0, 2 * Math.PI);
                ctx.fill();
              }

              // Small + indicator for unexpanded nodes (except the root database)
              if (!isExpanded && !isDatabase) {
                ctx.fillStyle = '#fbbf24';
                ctx.beginPath();
                ctx.arc(node.x + radius * 0.7, node.y - radius * 0.7, 2.5 / globalScale, 0, 2 * Math.PI);
                ctx.fill();
              }

              // Show label only on hover or when zoomed in enough
              const effectiveThreshold = currentData.nodes.length > 200 
                ? Math.max(visualSettings.zoomThreshold, 2.8)   // Much stricter for dense views like your Tabla
                : visualSettings.zoomThreshold;

              const showLabel = 
                hoveredNode?.id === node.id || 
                globalScale > effectiveThreshold ||
                (node.isVirtualTheme && globalScale > 0.8); // Always try to show theme hubs

              if (showLabel && label) {
                ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';

                const textWidth = ctx.measureText(label).width;
                const paddingX = 4;
                const paddingY = 2;

                let labelX = node.x;
                let labelY = node.y - radius - (visualSettings.labelSeparation / globalScale);

                // Radial label placement: push labels outward from the center of the graph
                // This works extremely well for the circular "database + many children" layout you have
                if (visualSettings.useRadialLabels && currentData.nodes.length > 50) {
                  // Find approximate center (the database node, or average of all nodes)
                  const centerNode = currentData.nodes.find((n: any) => n.type === 'database');
                  const cx = centerNode ? centerNode.x : 0;
                  const cy = centerNode ? centerNode.y : 0;

                  if (cx !== 0 || cy !== 0) {
                    const dx = node.x - cx;
                    const dy = node.y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

                    const radialOffset = (visualSettings.labelSeparation * 1.6) / globalScale;

                    labelX = node.x + (dx / dist) * radialOffset;
                    labelY = node.y + (dy / dist) * radialOffset;
                  }
                }

                // Background
                ctx.fillStyle = `rgba(15, 17, 23, ${visualSettings.bgOpacity})`;
                ctx.fillRect(
                  labelX - textWidth / 2 - paddingX, 
                  labelY - fontSize - paddingY, 
                  textWidth + paddingX * 2, 
                  fontSize + paddingY * 2
                );

                // Connector line
                if (visualSettings.showConnector) {
                  ctx.strokeStyle = 'rgba(156, 163, 175, 0.45)';
                  ctx.lineWidth = 0.7 / globalScale;
                  ctx.beginPath();
                  ctx.moveTo(node.x, node.y - radius);
                  ctx.lineTo(labelX, labelY - fontSize - paddingY + 1);
                  ctx.stroke();
                }

                // Label text
                ctx.fillStyle = '#e5e7eb';
                ctx.fillText(label, labelX, labelY - paddingY);
              }
            }}
          />
        </div>

        {/* Context Menu (right-click on node) */}
        {contextMenu && (
          <div
            className="fixed z-50 bg-[#1f222b] border border-[#3a3f4a] rounded-lg shadow-xl py-1 text-sm min-w-[180px]"
            style={{ left: contextMenu.x + 4, top: contextMenu.y + 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1.5 text-[#9ca3af] text-xs border-b border-[#3a3f4a] truncate">
              {contextMenu.node?.label || contextMenu.node?.id}
            </div>

            <button
              onClick={() => openInNotion(contextMenu.node)}
              className="w-full text-left px-3 py-1.5 hover:bg-[#2a2d36] flex items-center gap-2"
            >
              <span>→</span> <span>Abrir en Notion</span>
            </button>

            {contextMenu.node?.fx != null ? (
              <button
                onClick={() => unpinNodeFromMenu(contextMenu.node)}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2a2d36]"
              >
                Despinear este nodo
              </button>
            ) : (
              <button
                onClick={() => pinNodeFromMenu(contextMenu.node)}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2a2d36]"
              >
                Pinear en esta posición
              </button>
            )}

            <div className="border-t border-[#3a3f4a] my-1" />

            <button
              onClick={closeContextMenu}
              className="w-full text-left px-3 py-1.5 hover:bg-[#2a2d36] text-[#9ca3af]"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-80 sidebar p-4 rounded-lg flex flex-col">
        <h3 className="font-semibold text-lg mb-2">Notion Graph</h3>
        <div className="text-xs text-[#6b7280] mb-4 flex items-center justify-between">
          <span>
            {isDbMode 
              ? `Loaded from local DB (${dbFileName}) — pins saved inside the file` 
              : graphData 
                ? 'Real data (live or demo)' 
                : 'Drop your exported SleepBox_*.sqlite to start (DB-first mode for tuning)'}
          </span>
          {currentData?.nodes && (
            <span className="font-mono bg-[#0f1117] px-1.5 py-0.5 rounded text-[10px]">
              {currentData.nodes.length.toLocaleString()} nodes
            </span>
          )}
        </div>

        {currentData?.nodes?.length > 400 && (
          <div className="mb-4 text-[10px] bg-[#1f2937] text-amber-400 px-2 py-1.5 rounded">
            Large graph mode active — labels only on hover or high zoom for performance.
          </div>
        )}

        <div className="mb-6">
          <div className="text-xs uppercase tracking-widest text-[#6b7280] mb-2">Legend</div>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#3b82f6]" /> Page / Tarjeta</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#10b981]" /> Database</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#f59e0b]" /> Theme hub (galaxy center)</div>
            <div className="flex items-center gap-2 text-[#6b7280]"><div className="w-6 h-px bg-[#4b5563]" /> Child / Mention</div>
          </div>
          <div className="mt-3 text-[10px] text-[#6b7280]">
            Labels appear on hover or when zoomed in.<br />
            {isDbMode 
              ? 'DB mode: all data static. Right-click node for menu (Open in Notion, Pin).'
              : 'Yellow dot = Click to expand relations (live Notion).'}
          </div>

          <div className="mt-2 text-[10px]">
            <div className="text-[#6b7280] mb-1">Link types:</div>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-orange-500" /> Explicit - Apoyo (primarias/secundarias)</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-red-500" /> Contradicción (fuentes terciarias)</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-purple-500" /> Implicit (mentions)</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-blue-500" /> Child / Containment</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-amber-500" /> Theme galaxy (virtual hub)</div>
            </div>
            <div className="mt-1 text-[9px] text-[#6b7280]">
              Gold hubs = high-level Temas (created from sparse "Temáticas" + title prefixes).
            </div>
          </div>

          {(currentData?.nodes?.some((n: any) => n.inferredTheme) || currentData?.nodes?.some((n: any) => n.group)) && (
            <div className="mt-2 text-[10px] text-[#6b7280]">
              Nodes are colored by inferred high-level theme (title prefix + sparse "Temáticas" property).
            </div>
          )}

          {/* Theme Inference Debug Panel */}
          {themeDebugInfo && (
            <div className="mt-4 p-3 border border-[#2a2d36] rounded bg-[#0f1117] text-[11px]">
              <div className="font-medium text-[#9ca3af] mb-2">Theme Inference (debug)</div>

              <div className="text-[#6b7280] mb-1">
                Themes found: <span className="text-white font-mono">{themeDebugInfo.highLevelThemes.length}</span>
                &nbsp;•&nbsp;
                Assigned: <span className="text-white font-mono">{themeDebugInfo.assignedCount}/{themeDebugInfo.totalTarjetas}</span>
              </div>

              {Object.keys(themeDebugInfo.themeCounts).length > 0 && (
                <div className="mt-2 space-y-0.5 max-h-40 overflow-auto text-[10px]">
                  {Object.entries(themeDebugInfo.themeCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([theme, count]) => (
                      <div key={theme} className="flex justify-between">
                        <span className="truncate pr-2">{theme}</span>
                        <span className="font-mono text-[#9ca3af] shrink-0">{count}</span>
                      </div>
                    ))}
                </div>
              )}

              {themeDebugInfo.highLevelThemes.length === 0 && (
                <div className="text-amber-400 mt-1">No themes discovered from sparse "Temáticas" property.</div>
              )}

              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => sqliteCache.exportDatabase()}
                  className="text-[10px] px-2 py-0.5 border border-[#3a3d46] rounded hover:bg-[#1f2937]"
                >
                  Export Cache DB (.sqlite)
                </button>
                <button
                  onClick={async () => {
                    await sqliteCache.clearAll();
                    alert('Cache DB cleared. Reload to start fresh.');
                  }}
                  className="text-[10px] px-2 py-0.5 border border-[#3a3d46] rounded hover:bg-[#1f2937] text-red-400"
                >
                  Clear Cache
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live Visualization Tuning Controls */}
        {graphData && (
          <div className="mb-4 border border-[#2a2d36] rounded p-3 bg-[#0f1117]">
            <div className="flex justify-between items-center mb-2">
              <div className="text-xs font-medium text-[#9ca3af]">Visual Tuning</div>
              <button
                onClick={() => setVisualSettings({
                  labelSeparation: 8,
                  fontSizeBase: 10,
                  bgOpacity: 0.92,
                  zoomThreshold: 2.0,
                  showConnector: true,
                  largeGraphNodeScale: 0.7,
                  useRadialLabels: true,
                  nodeCharge: -90,
                })}
                className="text-[10px] text-[#6b7280] hover:text-white"
              >
                Reset
              </button>
            </div>

            <div className="space-y-3 text-[10px]">
              <div>
                <div className="flex justify-between mb-0.5">
                  <span>Label Separation</span>
                  <span className="font-mono text-[#9ca3af]">{visualSettings.labelSeparation}</span>
                </div>
                <input
                  type="range" min="2" max="20" step="0.5"
                  value={visualSettings.labelSeparation}
                  onChange={(e) => setVisualSettings(s => ({ ...s, labelSeparation: parseFloat(e.target.value) }))}
                  className="w-full accent-[#3b82f6]"
                />
              </div>

              <div>
                <div className="flex justify-between mb-0.5">
                  <span>Font Size</span>
                  <span className="font-mono text-[#9ca3af]">{visualSettings.fontSizeBase}</span>
                </div>
                <input
                  type="range" min="8" max="18" step="0.5"
                  value={visualSettings.fontSizeBase}
                  onChange={(e) => setVisualSettings(s => ({ ...s, fontSizeBase: parseFloat(e.target.value) }))}
                  className="w-full accent-[#3b82f6]"
                />
              </div>

              <div>
                <div className="flex justify-between mb-0.5">
                  <span>Zoom Threshold</span>
                  <span className="font-mono text-[#9ca3af]">{visualSettings.zoomThreshold.toFixed(1)}</span>
                </div>
                <input
                  type="range" min="0.8" max="4" step="0.1"
                  value={visualSettings.zoomThreshold}
                  onChange={(e) => setVisualSettings(s => ({ ...s, zoomThreshold: parseFloat(e.target.value) }))}
                  className="w-full accent-[#3b82f6]"
                />
              </div>

              <div>
                <div className="flex justify-between mb-0.5">
                  <span>Background Opacity</span>
                  <span className="font-mono text-[#9ca3af]">{visualSettings.bgOpacity.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0.5" max="1" step="0.01"
                  value={visualSettings.bgOpacity}
                  onChange={(e) => setVisualSettings(s => ({ ...s, bgOpacity: parseFloat(e.target.value) }))}
                  className="w-full accent-[#3b82f6]"
                />
              </div>

              {/* New control for node separation / repulsion */}
              <div>
                <div className="flex justify-between mb-0.5">
                  <span>Node Separation (repulsion)</span>
                  <span className="font-mono text-[#9ca3af]">{visualSettings.nodeCharge}</span>
                </div>
                <input
                  type="range" min="-300" max="-20" step="5"
                  value={visualSettings.nodeCharge}
                  onChange={(e) => setVisualSettings(s => ({ ...s, nodeCharge: parseInt(e.target.value) }))}
                  className="w-full accent-[#3b82f6]"
                />
                <div className="text-[9px] text-[#6b7280] -mt-0.5">More negative = nodes push apart more</div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visualSettings.showConnector}
                  onChange={(e) => setVisualSettings(s => ({ ...s, showConnector: e.target.checked }))}
                  className="accent-[#3b82f6]"
                />
                <span>Show connector line</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visualSettings.useRadialLabels}
                  onChange={(e) => setVisualSettings(s => ({ ...s, useRadialLabels: e.target.checked }))}
                  className="accent-[#3b82f6]"
                />
                <span>Radial labels (outward from center) — great for this ring layout</span>
              </label>

              <button
                onClick={unpinAllNodes}
                className="mt-1 w-full text-left text-[10px] bg-[#1f2937] hover:bg-[#374151] px-2 py-1 rounded text-[#d1d5db]"
              >
                Unpin all nodes (release dragged positions)
              </button>
            </div>
          </div>
        )}

        <div className="text-xs text-[#6b7280] mb-4">
          1. Create <code className="bg-[#0f1117] px-1">.env</code> with your <code>NOTION_TOKEN</code><br />
          2. Restart dev server<br />
          3. Paste any page URL/ID above
        </div>

        {selectedNode ? (
          <div className="mt-auto p-4 bg-[#0f1117] rounded border border-[#2a2d36]">
            <div className="text-xs text-[#6b7280]">Selected</div>
            <div className="font-medium text-base break-words">{selectedNode.label}</div>
            <div className="text-xs capitalize text-[#6b7280]">{selectedNode.type}</div>
            {selectedNode.notionUrl && (
              <a href={selectedNode.notionUrl} target="_blank" className="text-[#3b82f6] text-xs hover:underline block mt-1">Open in Notion →</a>
            )}
            <button onClick={() => setSelectedNode(null)} className="mt-2 text-xs text-[#6b7280] hover:text-white">Clear</button>
          </div>
        ) : (
          <div className="mt-auto text-sm text-[#6b7280]">
            Click nodes to inspect. Drag to rearrange.
          </div>
        )}
      </div>
    </div>
  );
}
