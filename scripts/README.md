# Graph Visual Debugging Tools

This folder contains tools to help debug and tune the graph visualization (especially label overlapping on large graphs).

## capture-graph.ts

This Playwright script automatically takes screenshots of the graph at different zoom levels.

### How to use it

1. Make sure your app is running with your real Notion token:
   ```powershell
   npm run dev
   ```

2. In the browser, load the large database you want to analyze (the one with 1000+ rows).

3. Run the capture script:
   ```powershell
   npm run capture:graph
   ```

4. The script will:
   - Open a browser window
   - Take a full overview screenshot
   - Zoom in progressively
   - Save multiple screenshots in `scripts/screenshots/`

This is extremely useful for comparing different settings from the **Visual Tuning** panel without having to manually take screenshots every time.

### Tips

- You can modify the `zoomSteps` array in the script if you want more/less zoom levels.
- Run it with `headless: true` in the script if you don't want to see the browser window.
- The screenshots are timestamped so you don't overwrite previous captures.

This tool was created to help iterate faster on label placement, separation, font size, and radial label behavior for very dense graphs.
