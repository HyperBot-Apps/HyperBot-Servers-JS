const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Simple console logger
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Single browser instance for simplicity
let browser = null;
let page = null;

// Initialize browser
async function initBrowser() {
  try {
    logger.info('Initializing browser...');
    
    const executablePath = await chrome.executablePath;
    
    browser = await puppeteer.launch({
      args: chrome.args,
      executablePath,
      headless: chrome.headless,
    });
    
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
    
    // Open grabnwatch page
    logger.info('Opening GrabnWatch website...');
    await page.goto('https://grabnwatch.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for Cloudflare to complete
    logger.info('Waiting for Cloudflare checks to complete...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Verify the form is accessible
    await page.waitForSelector('#video_url', { visible: true, timeout: 15000 });
    
    logger.info('GrabnWatch page loaded and ready for input');
    return true;
  } catch (error) {
    logger.error(`Failed to initialize browser: ${error.message}`);
    return false;
  }
}

// Process a video URL to get download links
async function processUrl(videoUrl) {
  try {
    logger.info(`Processing URL: ${videoUrl}`);
    
    // Make sure we're on the right page
    if (page.url() !== 'https://grabnwatch.com/') {
      logger.info('Navigating back to GrabnWatch homepage');
      await page.goto('https://grabnwatch.com/', { waitUntil: 'domcontentloaded' });
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Clear previous input if any
    await page.evaluate(() => document.getElementById('video_url').value = '');
    
    // Enter URL
    await page.type('#video_url', videoUrl);
    logger.info('URL entered into form');
    
    // Set random i_group if needed
    try {
      await page.evaluate(() => {
        const iGroup = document.getElementById('i_group');
        if (iGroup && !iGroup.value) {
          const randomVal = Math.random().toString(36).substring(2, 10);
          iGroup.value = randomVal;
        }
      });
    } catch (error) {
      // i_group field is optional, continue if not found
    }
    
    // Submit form
    await page.click('#submitBtn');
    logger.info('Form submitted, waiting for results...');
    
    // Wait for loading to disappear or timeout after 30 seconds
    try {
      await page.waitForFunction(
        () => !document.getElementById('loading') || 
              document.getElementById('loading').style.display === 'none',
        { timeout: 30000 }
      );
    } catch (error) {
      logger.warn(`Loading indicator didn't disappear: ${error.message}`);
    }
    
    // Wait additional time for results to load
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Get video title
    let videoTitle = await page.evaluate(() => {
      // Try various selectors that might contain the title
      const selectors = ['p.h5', 'h1', 'h2', '.video-title', '.title'];
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent.trim();
          if (text) return text;
        }
      }
      
      // If no title found, use page title
      if (document.title) {
        return document.title.replace('GrabnWatch', '').replace('-', '').trim();
      }
      
      return 'Video';
    });
    
    logger.info(`Video title: ${videoTitle}`);
    
    // Extract download links
    const downloadOptions = await page.evaluate(() => {
      const baseUrl = 'https://grabnwatch.com';
      const options = [];
      
      // Helper function
      const processLinks = (selector, defaultLabel) => {
        const links = document.querySelectorAll(selector);
        links.forEach(link => {
          let url = link.href;
          if (url.startsWith('/')) {
            url = `${baseUrl}${url}`;
          }
          
          const label = link.textContent.trim() || defaultLabel;
          
          // Only add if not already in the list
          if (!options.some(opt => opt.url === url)) {
            options.push({ url, label });
          }
        });
      };
      
      // Check for different types of download links
      processLinks('a[href^="/w/"]', 'Download');
      
      // Use XPath for text content search instead of jQuery-style :contains
      document.querySelectorAll('a').forEach(link => {
        if (link.textContent.toLowerCase().includes('original')) {
          let url = link.href;
          if (url.startsWith('/')) {
            url = `${baseUrl}${url}`;
          }
          const label = link.textContent.trim() || 'Original';
          if (!options.some(opt => opt.url === url)) {
            options.push({ url, label });
          }
        }
      });
      
      processLinks('a[href^="/r/"]', 'Download');
      processLinks('a[href*="/download/"], a[href*=".mp4"], a[href*=".m3u8"]', 'Alternative');
      
      return options;
    });
    
    if (downloadOptions && downloadOptions.length > 0) {
      logger.info(`Found ${downloadOptions.length} download options`);
      return { downloadOptions, videoTitle };
    } else {
      logger.error('No download links found');
      return { downloadOptions: null, videoTitle: null };
    }
    
  } catch (error) {
    logger.error(`Error processing URL: ${error.message}`);
    return { downloadOptions: null, videoTitle: null };
  }
}

// API endpoints
app.get('/', (req, res) => {
  res.json({
    status: "online",
    message: "Simple GrabnWatch API is running",
    usage: "Send POST request to /api/process with JSON body containing 'url' field"
  });
});

app.post('/api/process', async (req, res) => {
  try {
    const { url: videoUrl } = req.body;
    
    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({
        status: "error",
        message: "Missing or invalid 'url' field in request body"
      });
    }
    
    logger.info(`API request received for URL: ${videoUrl}`);
    
    // Make sure browser is initialized
    if (!browser || !page) {
      logger.info('Browser not initialized yet, initializing now...');
      const initialized = await initBrowser();
      if (!initialized) {
        return res.status(500).json({
          status: "error",
          message: "Failed to initialize browser"
        });
      }
    }
    
    // Process the URL
    const { downloadOptions, videoTitle } = await processUrl(videoUrl);
    
    if (downloadOptions && downloadOptions.length > 0) {
      return res.json({
        status: "success",
        original_url: videoUrl,
        title: videoTitle,
        download_options: downloadOptions
      });
    } else {
      return res.status(500).json({
        status: "error",
        message: "Failed to generate download links",
        original_url: videoUrl
      });
    }
    
  } catch (error) {
    logger.error(`Error processing request: ${error.message}`);
    return res.status(500).json({
      status: "error",
      message: `Server error: ${error.message}`
    });
  }
});

// Graceful shutdown
async function shutdownServer() {
  if (browser) {
    logger.info('Closing browser...');
    await browser.close();
  }
  logger.info('Server shutdown complete');
}

// Register shutdown handlers
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await shutdownServer();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await shutdownServer();
  process.exit(0);
});

// Start the server
const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', async () => {
  console.log(`Simple GrabnWatch API Server running at http://0.0.0.0:${port}/`);
  await initBrowser();
});
