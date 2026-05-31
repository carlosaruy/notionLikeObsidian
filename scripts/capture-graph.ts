/**
 * Playwright script to capture screenshots of the Notion graph at different zoom levels.
 * 
 * Useful for debugging label overlapping when zooming into large graphs (1000+ nodes).
 * 
 * Usage:
 *   1. Make sure `npm run dev` is running on http://localhost:5173 with your .env token loaded.
 *   2. Load your large database in the app first (so the graph is visible).
 *   3. Run: npx tsx scripts/capture-graph.ts
 * 
 * It will take several screenshots with increasing zoom.
 */

import { chromium } from 'playwright';

async function captureGraph() {
  const browser = await chromium.launch({ 
    headless: false,   // Set to true if you don't want to see the browser
    slowMo: 50 
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }
  });

  const page = await context.newPage();

  console.log('Opening app...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });

  // Give time for the graph to render (especially important with 1000+ nodes)
  await page.waitForTimeout(2500);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Screenshot 1: Full overview
  await page.screenshot({ 
    path: `scripts/screenshots/graph-overview-${timestamp}.png`,
    fullPage: true 
  });
  console.log('Saved overview screenshot');

  // Try to find the canvas (the graph)
  const canvas = page.locator('canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 10000 });

  // Get bounding box of the canvas for precise mouse interactions
  const box = await canvas.boundingBox();
  if (!box) {
    console.error('Could not find graph canvas');
    await browser.close();
    return;
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  // Zoom in steps and take screenshots
  const zoomSteps = [1.5, 2.2, 3.0, 4.0, 5.5];

  for (const zoom of zoomSteps) {
    // Go back to center
    await page.mouse.move(centerX, centerY);
    
    // Zoom in by scrolling (this is how the graph zooms)
    const scrollAmount = Math.round((zoom - 1) * 800);
    await page.mouse.wheel(0, scrollAmount);

    // Wait for the force simulation + label rendering to settle
    await page.waitForTimeout(1200);

    await page.screenshot({
      path: `scripts/screenshots/graph-zoom-${zoom.toFixed(1)}x-${timestamp}.png`,
      fullPage: true
    });

    console.log(`Saved screenshot at ${zoom}x zoom`);
  }

  console.log('\n✅ Screenshots saved in scripts/screenshots/');
  console.log('You can now review them to evaluate label overlapping at different zoom levels.');

  // Keep browser open for a bit so user can see
  await page.waitForTimeout(3000);
  await browser.close();
}

captureGraph().catch(console.error);