# notionLikeObsidian - Plan de Construcción

## Objetivo Principal (Opción A)

Crear una **herramienta local y privada** para visualizar como grafo la información de un workspace de Notion grande.

El usuario quiere algo tipo "Obsidian Local Graph" pero para Notion: poder ir a una página y ver sus relaciones (subpáginas, menciones, links) de forma visual e interactiva, sin subir datos a ningún SaaS.

## Principios de Diseño

- 100% local / self-hosted
- Privacidad total (el token de Notion nunca sale de la máquina del usuario, salvo llamadas directas a la API de Notion)
- Enfocado en **Local Graph** primero (como en Obsidian), no en grafo global gigante
- Simple de instalar y usar
- Rápido incluso con workspaces grandes (cache agresivo + traversal controlado)
- Bonito y usable (estilo Obsidian)

## Stack Tecnológico Recomendado

### Frontend (Principal)
- **Vite + React 19 + TypeScript**
- **Tailwind CSS**
- **react-force-graph** (2D por defecto, con opción futura a 3D)
  - Usa d3-force por debajo + Canvas/WebGL → muy buen performance y look "orgánico"
  - Fácil de personalizar (colores por tipo de nodo, labels, click handlers, etc.)

### Capa de Datos / Notion
- **Backend ligero** (Node.js + Express o Hono) como proxy
  - Razones: evitar problemas de CORS, guardar el token de forma más segura (no solo localStorage), rate limiting amigable
- Opcional durante desarrollo: aprovechar las herramientas MCP de Notion que ya están conectadas en esta sesión para prototipar extracción de datos muy rápido.

### Almacenamiento Local
- Cache en archivos JSON o SQLite (mejor para queries)
- Posibilidad de IndexedDB en el frontend para modo "sin backend"

### Otras librerías útiles
- lucide-react (iconos)
- sonner o react-hot-toast (notificaciones)
- zustand (estado ligero)
- date-fns o similar

## Fases de Desarrollo

### Fase 0: Setup y Fundación (Hecho / En progreso)
- [x] Repositorio creado y clonado
- [x] Proyecto Vite + React + TS inicializado
- [ ] Tailwind configurado
- [ ] Estructura de carpetas limpia
- [ ] PLAN.md + README actualizado
- [ ] Configuración básica de ESLint + Prettier (si aplica)

### Fase 1: Conexión a Notion + Extracción de Datos MVP (Prioridad Alta)
- Formulario simple para pegar **Internal Integration Token** (secret_...)
- Guardado local seguro del token (preferiblemente en backend)
- Fetch básico de una página por ID/URL
- Extracción inicial de relaciones:
  - Subpáginas (child_page blocks)
  - Menciones de otras páginas dentro del contenido
- Modelo de datos simple:
  ```ts
  interface GraphNode {
    id: string;
    label: string;
    type: 'page' | 'database' | ...;
    notionUrl?: string;
  }
  interface GraphLink {
    source: string;
    target: string;
    type: 'child' | 'mention' | 'relation' | ...;
  }
  ```
- Cache básico de resultados

**Entregable**: Poder pegar un token + page ID y obtener un JSON con nodos y links de esa página + 1 nivel de profundidad.

### Fase 2: Visualización Básica del Grafo
- Integrar `react-force-graph`
- Renderizar el grafo con los datos de Fase 1
- Interacciones mínimas:
  - Click en nodo → abrir página en Notion (o mostrar info)
  - Hover para resaltar conexiones
  - Zoom / Pan
  - Botón "Recalcular layout"
- Estilo visual decente (colores, tamaños según tipo o cantidad de conexiones)

**Entregable**: Una página web local que muestra un grafo interactivo decente de una página de Notion.

### Fase 3: Local Graph Real + Controles (El corazón del producto)
- Selector de página (input URL + búsqueda simple vía Notion API)
- Controles de profundidad (1 hop, 2 hops, etc.)
- Filtros:
  - Solo subpáginas
  - Solo menciones
  - Ocultar ciertos tipos de nodos
- Búsqueda / highlight de nodos
- Panel lateral con información del nodo seleccionado
- Posibilidad de "Expandir nodo" (cargar más relaciones de ese nodo)

### Fase 4: Pulido y Experiencia de Usuario
- Cache persistente inteligente (no volver a pedir lo mismo)
- Manejo elegante de rate limits de Notion
- Dark mode (imprescindible)
- Exportar grafo (PNG, JSON, Mermaid)
- Historial de páginas visualizadas recientemente
- Mejor tipado y manejo de errores
- Performance en workspaces grandes (virtualización si hace falta, o clustering simple)

### Fase 5 (Opcional / Futuro)
- Soporte para relaciones de bases de datos
- Detección de backlinks (más costoso)
- Modo 3D (react-force-graph tiene muy buena versión)
- Export a Obsidian vault (markdown files + wikilinks)
- Tauri / Electron para tener una app desktop nativa
- Soporte multi-workspace

## Decisiones Técnicas Importantes

### ¿Por qué react-force-graph?
- Es la librería que mejor balance tiene hoy para "grafo estilo Obsidian".
- Muy usada en proyectos similares de knowledge graphs.
- Buena documentación y comunidad.
- Soporta Canvas (performance) y tiene versión 3D lista.

Alternativas consideradas:
- Cytoscape.js → más potente para análisis, pero curva de aprendizaje más alta y menos "orgánico".
- D3-force puro → máximo control, pero mucho más código manual.

### Estrategia de Extracción de Relaciones
Empezar simple pero sólido:
1. Solo child_page + menciones inline (Fase 1-2)
2. Recursivo controlado por profundidad (Fase 3)
3. Backlinks y database relations después

Inspiración buena: La lógica del `ElementProcessor` del viejo graph-mode era decente, pero la vamos a reimplementar limpia y enfocada en uso personal (sin tiers, sin Redis obligatorio).

## Riesgos y Mitigaciones

- **Rate limits de Notion**: Solución → cache agresivo + procesamiento por lotes + delays.
- **Workspaces muy grandes**: Enfocarnos fuertemente en Local Graph + profundidad limitada. El grafo global completo rara vez es usable.
- **Complejidad de bloques de Notion**: Empezar con los bloques más comunes (paragraph, heading, toggle, child_page, mention). Ir agregando más según necesidad.
- **UI/UX del grafo**: Es fácil hacer un grafo feo o que no se pueda navegar. Dedicar tiempo real a interacciones y filtros.

## Iteración Actual (Junio 2026): Persistencia de Layout + Menú de Nodos (SleepBox)

**Objetivo de esta iteración**  
Hacer que el grafo sea usable a largo plazo: el usuario puede pinear nodos manualmente y que esas posiciones se guarden en la misma base SQLite que usa para el contenido. Además, poder interactuar con los nodos de forma más rica (menú contextual).

### Requisitos del usuario
- Mostrar títulos de los nodos de forma clara.
- Poder pinear nodos (arrastrar y que queden fijos).
- **Persistencia real**: las posiciones pineadas deben guardarse en la base de datos SQLite → al levantar la app de nuevo, los nodos aparecen donde los dejó.
- Click en un nodo → mostrar menú.
- Opción principal del menú: **"Ir al nodo en Notion"** (abrir la página real).

### Plan de Implementación (en este orden)

**Paso 1 – Esquema de Datos (SQLite)**
- Agregar tabla `node_positions` al generador de la base limpia (`build_clean_fresh_graph.js`).
- Esquema recomendado:
  ```sql
  CREATE TABLE node_positions (
    node_id     TEXT PRIMARY KEY,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    pinned_at   INTEGER,           -- unix timestamp
    is_pinned   BOOLEAN DEFAULT 1
  );
  ```
- Esta tabla vive dentro del mismo archivo `SleepBox_Graph_Ready_Cleaned_....sqlite`.
- Actualizar documentación del esquema en este PLAN.md y en el script.

**Paso 2 – Carga y Guardado de Posiciones en el Frontend**
- Extender `src/lib/sqliteCache.ts` (o crear helpers específicos) para leer/escribir `node_positions`.
- En `GraphDemo.tsx`:
  - Al cargar el grafo desde SQLite, aplicar `fx`/`fy` a los nodos según lo guardado.
  - En `handleNodeDragEnd`: guardar automáticamente la posición en la tabla.
  - Agregar botón "Unpin este nodo" y mejorar "Unpin all".
- El pinning debe sobrevivir recargas de la página / reinicios de la app.

**Paso 3 – Menú Contextual + "Ir a Notion"**
- Implementar menú al hacer click (idealmente derecho, o izquierdo + botón secundario).
- Opciones mínimas:
  - **Abrir en Notion** (construir URL con el `id` del nodo).
  - Pin / Unpin este nodo.
  - Copiar título / ID.
- Usar `onNodeRightClick` de react-force-graph + un componente React posicionado (portal o div absoluto).

**Paso 4 – Pulido de Títulos y Experiencia**
- Mejorar el renderizado de labels (`nodeCanvasObject`) cuando hay nodos pineados (ej: icono de pin, mejor separación).
- Asegurar que los títulos se vean bien en grafos densos como el de las 55+ Tarjetas de SleepBox.
- Pequeños ajustes de UX (feedback visual al pinear, etc.).

**Entregable de la iteración**
Una versión del grafo donde:
- El usuario puede organizar manualmente las galaxias de temas pineando nodos importantes.
- Al recargar, el layout manual se mantiene.
- Puede navegar rápido a Notion desde cualquier nodo con un click.

---

## Próximos Pasos Inmediatos (Histórico - ya superado)

1. Terminar setup base (Tailwind, estructura de carpetas).
2. Crear componentes básicos de layout (Sidebar + Graph area).
3. Implementar un "Modo Demo" con datos mock para poder ver el grafo funcionando rápido.
4. Preparar el servicio de conexión a Notion (primero usando token manual).
5. (Opcional pero poderoso) Usar las herramientas MCP de Notion disponibles en esta conversación para prototipar la extracción de relaciones con datos reales del usuario sin exponer token todavía.

---

**Estado actual de la iteración (Jun 2026)**: En progreso. Enfocados en hacer el grafo "vivible" a través del tiempo mediante persistencia de layout manual + interacción directa con Notion.

**Siguiente acción**: Ejecutar los 4 pasos en orden.
