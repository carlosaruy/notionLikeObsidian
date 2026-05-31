/**
 * Simple script to capture the current state of the graph.
 * 
 * Use this when you have manually set up a specific combination in the Visual Tuning panel.
 * 
 * Usage:
 *   npx tsx scripts/capture-current.ts
 * 
 * It will take screenshots at different zoom levels of whatever is currently visible.
 */

import { chromium } from 'playwright';
import * as path from 'path';

const SCREENSHOTS_DIR = 'scripts/screenshots';

async function captureCurrent() {
  console.log('🚀 Opening browser to capture current view...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();

  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log('Taking overview screenshot...');
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, `current-${timestamp}-01-overview.png`),
    fullPage: true,
  });

  // Zoom in steps
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();

  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const zoomLevels = [2.5, 3.8, 5.5];

    for (let i = 0; i < zoomLevels.length; i++) {
      const zoom = zoomLevels[i];
      const scrollAmount = Math.round(zoom * 900);
      
      await page.mouse.wheel(0, scrollAmount);
      await page.waitForTimeout(1400); // wait for rendering

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, `current-${timestamp}-0${i + 2}-zoom-${zoom}x.png`),
        fullPage: true,
      });
      console.log(`Captured at ~${zoom}x zoom`);
    }
  }

  console.log('\n✅ Screenshots saved in scripts/screenshots/');
  console.log('You can now change the Visual Tuning values and run this script again when ready.');

  await page.waitForTimeout(3000);
  await browser.close();
}

captureCurrent().catch(console.error);