/**
 * Simple script to open a browser window pointing to the local app.
 * 
 * This keeps the browser open so you can manually:
 * - Load your large database
 * - Play with the Visual Tuning controls
 * - Zoom/pan to the exact view you want to analyze
 * 
 * When you're ready, tell me in the chat and I can take screenshots
 * using Playwright from here.
 */

import { chromium } from 'playwright';

async function openBrowser() {
  console.log('🚀 Opening browser...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 0,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: null, // Use full screen
  });

  const page = await context.newPage();

  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

  console.log('\n✅ Browser is open at http://localhost:5173');
  console.log('   - Load your big database');
  console.log('   - Tune the Visual Tuning panel as you want');
  console.log('   - Zoom / pan to the view you want to capture');
  console.log('\nWhen you are ready, write in the chat something like:');
  console.log('   "ya, sacale captura" or "take screenshot now"');
  console.log('\nI will keep this browser instance alive until you tell me otherwise.');

  // Keep the browser open indefinitely
  // We don't close it here
}

openBrowser().catch(console.error);