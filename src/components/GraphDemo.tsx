import { useState, useRef, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { buildGraphFromPage, fetchDirectRelations } from '../lib/notion';

export default function GraphDemo() {
  const [graphData, setGraphData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const fgRef = useRef<any>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [loadDepth, setLoadDepth] = useState(3); // New: adjustable depth when loading a page/DB

  // Live visualization tuning controls
  const [visualSettings, setVisualSettings] = useState({
    labelSeparation: 8,           // base vertical separation (higher = more space above node)
    fontSizeBase: 10,             // base font size before zoom scaling (bajado para grafos densos)
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

  // Configurar fuerzas del grafo (incluyendo el nuevo control de Node Charge)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !currentData?.nodes) return;

    const nodeCount = currentData.nodes.length;

    // Usar el valor del slider cuando esté disponible, con fallback adaptativo
    const baseCharge = visualSettings.nodeCharge ?? (nodeCount > 300 ? -140 : -70);
    fg.d3Force('charge')?.strength(baseCharge);

    // Link distance también un poco más generoso en grafos grandes
    const linkDistance = nodeCount > 300 ? 55 : 32;
    fg.d3Force('link')?.distance(linkDistance);

    fg.d3ReheatSimulation?.();
  }, [currentData, visualSettings.nodeCharge]);

  const handleLoadReal = async () => {
    if (!pageInput.trim()) {
      setError('Please paste a Notion page URL or ID');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Extract ID from URL if needed
      const idMatch = pageInput.match(/[0-9a-f]{32}/i) || pageInput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const entityId = idMatch ? idMatch[0].replace(/-/g, '') : pageInput.trim();

      const result = await buildGraphFromPage(entityId, loadDepth, { shallowDatabase: true });

      // Convert to format expected by ForceGraph2D
      const formatted = {
        nodes: result.nodes.map(n => ({ ...n, val: n.type === 'database' ? 8 : 4 })),
        links: result.links.map(l => ({ ...l })),
      };

      setGraphData(formatted);
      setSelectedNode(null);

      if (result.isLargeDatabase) {
        // We can show a non-blocking warning later
        console.info('Large database detected — loaded in shallow mode');
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

  const handleNodeClick = async (node: any) => {
    setSelectedNode(node);

    // If already expanded, just select it
    if (expandedNodes.has(node.id)) {
      return;
    }

    // Mark as expanded immediately for UI feedback
    setExpandedNodes(prev => new Set(prev).add(node.id));

    try {
      const { nodes: newNodes, links: newLinks } = await fetchDirectRelations(node.id);

      if (newNodes.length === 0 && newLinks.length === 0) {
        return; // Nothing new to add
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

      // Reheat the simulation so new nodes get positioned nicely
      setTimeout(() => {
        fgRef.current?.d3ReheatSimulation?.();
      }, 50);

    } catch (err) {
      console.error('Failed to expand node', node.id, err);
      // Remove from expanded set if it failed
      setExpandedNodes(prev => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  };

  // Pin node in place when user finishes dragging it
  const handleNodeDragEnd = (node: any) => {
    // Fix the node position so force simulation doesn't move it anymore
    node.fx = node.x;
    node.fy = node.y;

    // Force a refresh so the UI reflects the pinned state if needed
    if (fgRef.current?.refresh) {
      fgRef.current.refresh();
    }
  };

  const unpinAllNodes = () => {
    if (!graphData) return;

    graphData.nodes.forEach((node: any) => {
      delete node.fx;
      delete node.fy;
    });

    // Reheat simulation so nodes can move again
    setGraphData({ ...graphData }); // trigger re-render
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
  };

  return (
    <div className="flex h-[calc(100vh-120px)] gap-4 p-4">
      {/* Graph Area */}
      <div className="flex-1 graph-container flex flex-col">
        <div className="p-3 border-b border-[#2a2d36] flex items-center gap-3 bg-[#16181f]">
          <input
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            placeholder="Paste Notion page URL or ID (e.g. 123e4567-e89b-12d3-a456-426614174000)"
            className="input flex-1"
            onKeyDown={(e) => e.key === 'Enter' && handleLoadReal()}
          />
          <button 
            onClick={handleLoadReal} 
            disabled={isLoading}
            className="btn"
          >
            {isLoading ? 'Loading...' : 'Load Real Graph'}
          </button>

          {/* Depth control - user request */}
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
              Back to Demo
            </button>
          )}
        </div>

        {error && (
          <div className="bg-red-900/30 text-red-400 p-3 text-sm border-b border-red-900">
            {error}
          </div>
        )}

        <div className="flex-1">
          <ForceGraph2D
            ref={fgRef}
            graphData={currentData}
            nodeColor={(node: any) => {
              if (node.group) {
                // Colorear consistentemente por el grupo (Temática)
                const hash = node.group.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0);
                const hue = (hash * 37) % 360; // mejor distribución
                return `hsl(${hue}, 65%, 58%)`;
              }
              return node.type === 'database' ? '#10b981' : '#3b82f6';
            }}
            nodeRelSize={currentData.nodes.length > 400 ? 3.5 : 5.5}
            linkColor={(link: any) => {
              const rel = link.relationType || link.type;
              if (rel?.startsWith('explicit')) return '#f59e0b';      // Orange for explicit
              if (rel === 'mention') return '#8b5cf6';                // Purple for implicit mentions
              if (rel === 'child_page' || rel === 'child') return '#3b82f6'; // Blue
              return '#6b7280';                                       // Gray default
            }}
            linkWidth={(link: any) => {
              const rel = link.relationType || link.type;
              if (rel?.startsWith('explicit')) return currentData.nodes.length > 400 ? 1.2 : 1.8;
              return currentData.nodes.length > 400 ? 0.7 : 1.2;
            }}
            onNodeClick={handleNodeClick}
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
              const radius = (isDatabase ? 8 : 5) * nodeScale;
              const label = node.label || '';
              const fontSize = Math.max(8, visualSettings.fontSizeBase / globalScale);
              const isExpanded = expandedNodes.has(node.id);

              // Draw node circle
              ctx.beginPath();
              ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
              ctx.fillStyle = isDatabase ? '#10b981' : '#3b82f6';
              ctx.fill();

              // Draw white ring for selected/hovered
              if (selectedNode?.id === node.id || hoveredNode?.id === node.id) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5 / globalScale;
                ctx.stroke();
              }

              // Small + indicator for unexpanded nodes (except the root database)
              if (!isExpanded && !isDatabase) {
                ctx.fillStyle = '#fbbf24';
                ctx.beginPath();
                ctx.arc(node.x + radius * 0.7, node.y - radius * 0.7, 2.5 / globalScale, 0, 2 * Math.PI);
                ctx.fill();
              }

              // Show label only on hover or when zoomed in enough
              const effectiveThreshold = currentData.nodes.length > 400 
                ? Math.max(visualSettings.zoomThreshold, 1.5) 
                : visualSettings.zoomThreshold;

              const showLabel = 
                hoveredNode?.id === node.id || 
                globalScale > effectiveThreshold;

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
      </div>

      {/* Sidebar */}
      <div className="w-80 sidebar p-4 rounded-lg flex flex-col">
        <h3 className="font-semibold text-lg mb-2">Notion Graph</h3>
        <div className="text-xs text-[#6b7280] mb-4 flex items-center justify-between">
          <span>
            {graphData ? 'Real data from your Notion' : 'Demo mode — click "Load Real Graph" after setting up your token'}
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
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#3b82f6]" /> Page</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#10b981]" /> Database</div>
            <div className="flex items-center gap-2 text-[#6b7280]"><div className="w-6 h-px bg-[#4b5563]" /> Child / Mention</div>
          </div>
          <div className="mt-3 text-[10px] text-[#6b7280]">
            Labels appear on hover or when zoomed in.<br />
            Yellow dot = Click to expand relations.
          </div>

          <div className="mt-2 text-[10px]">
            <div className="text-[#6b7280] mb-1">Link types:</div>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-orange-500" /> Explicit (Sleep Box)</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-purple-500" /> Implicit (mentions)</div>
              <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 bg-blue-500" /> Child / Containment</div>
            </div>
          </div>

          {currentData?.nodes?.some((n: any) => n.group) && (
            <div className="mt-2 text-[10px] text-[#6b7280]">
              Nodes are colored by their "Temáticas" group from the database.
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
