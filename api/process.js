const http = require('http');
const puppeteer = require('puppeteer-core');
const chrome = require('@sparticuz/chromium');

// Simple console logger
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Initialize browser
async function initBrowser() {
  try {
    logger.info('Initializing browser...');
    
    // Fix: Call executablePath as a function
    const executablePath = await chrome.executablePath();
    
    logger.info(`Executable path: ${executablePath}`);
    
    const browser = await puppeteer.launch({
      args: [...chrome.args, '--hide-scrollbars', '--disable-web-security'],
      executablePath,
      headless: chrome.headless,
    });
    
    const page = await browser.newPage();
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
    return { browser, page };
  } catch (error) {
    logger.error(`Failed to initialize browser: ${error.message}`);
    throw error;
  }
}

// Process a video URL to get download links
async function processUrl(page, videoUrl) {
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

// Handler function for HTTP requests
async function handleRequest(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Handle GET request (status check)
  if (req.method === 'GET' && req.url === '/') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: "online",
      message: "GrabnWatch API is running",
      usage: "Send POST request with JSON body containing 'url' field"
    }));
    return;
  }
  
  // Handle POST request
  if (req.method === 'POST' && req.url === '/') {
    let browser = null;
    try {
      // Parse request body
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      await new Promise((resolve) => {
        req.on('end', resolve);
      });
      
      let videoUrl;
      try {
        const parsedBody = JSON.parse(body);
        videoUrl = parsedBody?.url;
      } catch (e) {
        logger.error(`Failed to parse request body: ${e.message}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: "error",
          message: "Invalid JSON in request body"
        }));
        return;
      }
      
      if (!videoUrl || typeof videoUrl !== 'string') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: "error",
          message: "Missing or invalid 'url' field in request body"
        }));
        return;
      }
      
      logger.info(`API request received for URL: ${videoUrl}`);
      
      // Initialize browser for this request
      const { browser: browserInstance, page } = await initBrowser();
      browser = browserInstance;
      
      // Process the URL
      const { downloadOptions, videoTitle } = await processUrl(page, videoUrl);
      
      // Close browser
      if (browser) {
        await browser.close();
      }
      
      if (downloadOptions && downloadOptions.length > 0) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: "success",
          original_url: videoUrl,
          title: videoTitle,
          download_options: downloadOptions
        }));
      } else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          status: "error",
          message: "Failed to generate download links",
          original_url: videoUrl
        }));
      }
      
    } catch (error) {
      logger.error(`Error processing request: ${error.message}`);
      
      // Clean up browser if error occurs
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          logger.error(`Error closing browser: ${closeError.message}`);
        }
      }
      
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: "error",
        message: `Server error: ${error.message}`
      }));
    }
    return;
  }
  
  // Method not allowed or route not found
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ 
    status: "error",
    message: "Not found" 
  }));
}

// Get port from environment variable or use default
const port = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(handleRequest);

// Start server
server.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});
