/**
 * Advanced visual tuning experimentation script.
 * 
 * This script will try different combinations of the Visual Tuning controls
 * on your large graph and save screenshots for comparison.
 * 
 * Usage:
 *   1. Make sure `npm run dev` is running.
 *   2. Load your large database in the browser first.
 *   3. Run: npx tsx scripts/experiment-visual-tuning.ts
 */

import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOTS_DIR = 'scripts/screenshots/tuning-experiments';

// Define interesting combinations to test
const experiments = [
  {
    name: '01-current-default',
    settings: {
      labelSeparation: 8,
      fontSizeBase: 12,
      zoomThreshold: 2.0,
      bgOpacity: 0.92,
      useRadialLabels: true,
      showConnector: true,
    }
  },
  {
    name: '02-radial-high-separation',
    settings: {
      labelSeparation: 14,
      fontSizeBase: 12,
      zoomThreshold: 2.0,
      bgOpacity: 0.92,
      useRadialLabels: true,
      showConnector: true,
    }
  },
  {
    name: '03-radial-low-separation',
    settings: {
      labelSeparation: 5,
      fontSizeBase: 11,
      zoomThreshold: 2.2,
      bgOpacity: 0.88,
      useRadialLabels: true,
      showConnector: false,
    }
  },
  {
    name: '04-traditional-above-no-radial',
    settings: {
      labelSeparation: 10,
      fontSizeBase: 12,
      zoomThreshold: 2.0,
      bgOpacity: 0.92,
      useRadialLabels: false,
      showConnector: true,
    }
  },
  {
    name: '05-bigger-font-radial',
    settings: {
      labelSeparation: 9,
      fontSizeBase: 14,
      zoomThreshold: 2.3,
      bgOpacity: 0.90,
      useRadialLabels: true,
      showConnector: true,
    }
  },
  {
    name: '06-late-labels-radial',
    settings: {
      labelSeparation: 8,
      fontSizeBase: 11,
      zoomThreshold: 3.0,
      bgOpacity: 0.92,
      useRadialLabels: true,
      showConnector: true,
    }
  },
  {
    name: '07-minimal-labels',
    settings: {
      labelSeparation: 6,
      fontSizeBase: 10,
      zoomThreshold: 2.8,
      bgOpacity: 0.85,
      useRadialLabels: true,
      showConnector: false,
    }
  },
];

async function setSlider(page: Page, labelText: string, value: number) {
  const container = page.locator('div', { hasText: labelText }).first();
  const slider = container.locator('input[type="range"]');
  await slider.fill(value.toString());
  await page.waitForTimeout(250); // give React time to update
}

async function setCheckbox(page: Page, labelText: string, checked: boolean) {
  const label = page.locator('label', { hasText: labelText }).first();
  const checkbox = label.locator('input[type="checkbox"]');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== checked) {
    await label.click();
    await page.waitForTimeout(200);
  }
}

async function applySettings(page: Page, settings: any) {
  console.log(`   Applying settings: ${JSON.stringify(settings)}`);

  // These labels must match exactly what is rendered in the UI
  await setSlider(page, 'Label Separation', settings.labelSeparation);
  await setSlider(page, 'Font Size', settings.fontSizeBase);
  await setSlider(page, 'Zoom Threshold', settings.zoomThreshold);
  await setSlider(page, 'Background Opacity', settings.bgOpacity);

  await setCheckbox(page, 'Radial labels', settings.useRadialLabels);
  await setCheckbox(page, 'Show connector line', settings.showConnector);

  // Wait for the graph to re-render with new settings
  await page.waitForTimeout(800);
}

async function zoomToLevel(page: Page, targetZoom: number) {
  // This is a rough approximation. We scroll the mouse wheel while over the canvas.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Scroll to approximate zoom level (very rough)
  const currentScroll = await page.evaluate(() => window.scrollY);
  const scrollAmount = Math.round((targetZoom - 1) * 1200);
  await page.mouse.wheel(0, scrollAmount);
  await page.waitForTimeout(1200);
}

async function runExperiments() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();

  console.log('🌐 Opening app...');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  for (const experiment of experiments) {
    console.log(`\n=== Running: ${experiment.name} ===`);

    await applySettings(page, experiment.settings);

    // Take overview shot
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${timestamp}-${experiment.name}-overview.png`),
      fullPage: true,
    });

    // Zoom in to see labels
    await zoomToLevel(page, 3.2);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${timestamp}-${experiment.name}-zoomed.png`),
      fullPage: true,
    });

    // Zoom in even more (dense area)
    await zoomToLevel(page, 5.0);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${timestamp}-${experiment.name}-very-zoomed.png`),
      fullPage: true,
    });

    // Reset zoom roughly for next experiment
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(600);
  }

  console.log('\n✅ All experiments completed!');
  console.log(`Screenshots saved in: ${SCREENSHOTS_DIR}`);

  // Keep browser open for a moment
  await page.waitForTimeout(4000);
  await browser.close();
}

runExperiments().catch(console.error);