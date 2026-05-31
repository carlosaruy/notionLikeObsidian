# notionLikeObsidian

**Local, private graph visualization for your Notion workspace.**

The goal is simple: open any Notion page and instantly see its relationships (sub-pages, mentions, links) as a beautiful, interactive force-directed graph — exactly like Obsidian's Local Graph, but for Notion.

## Current Status

- **Option A chosen**: 100% local & private tool (no SaaS, no data leaves your machine).
- Project scaffolded with Vite + React + TypeScript.
- Live interactive demo running with realistic mock data (click nodes, drag, zoom).
- Full phased construction plan in [PLAN.md](./PLAN.md).

## Quick Start

```bash
npm install
npm run dev
```

Open the app — you'll immediately see a working force-directed graph that simulates real Notion relationships.

## Philosophy

- Privacy first
- Excellent **Local Graph** experience (not another useless global mess)
- Pragmatic scope — deliver something genuinely useful quickly for large Notion workspaces
- Avoid becoming yet another abandoned "Notion graph" side project

## Tech Stack (current direction)

- `react-force-graph-2d` for visualization (force-directed, high performance Canvas)
- Small local Node proxy for Notion API calls (token safety + CORS)
- Aggressive local caching
- Tailwind + clean dark UI

See [PLAN.md](./PLAN.md) for the complete roadmap, data model, and phases.

## Development

This project is being built iteratively with a clear plan. The focus right now is:

1. Solid relationship extraction from Notion (subpages + mentions first)
2. Delightful local graph interaction
3. Performance with real-world large workspaces

---

**Status**: Early scaffolding + working visual demo. Real Notion connection coming in Fase 1.
