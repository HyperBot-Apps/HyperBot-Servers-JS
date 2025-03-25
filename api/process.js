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
    
    const executablePath = await chrome.executablePath;
    
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

// Serverless handler function
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Handle GET request (status check)
  if (req.method === 'GET') {
    return res.status(200).json({
      status: "online",
      message: "GrabnWatch API is running",
      usage: "Send POST request with JSON body containing 'url' field"
    });
  }
  
  // Handle POST request
  if (req.method === 'POST') {
    let browser = null;
    try {
      // Parse request body
      const body = req.body;
      const videoUrl = body?.url;
      
      if (!videoUrl || typeof videoUrl !== 'string') {
        return res.status(400).json({
          status: "error",
          message: "Missing or invalid 'url' field in request body"
        });
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
        return res.status(200).json({
          status: "success",
          original_url: videoUrl,
          title: videoTitle,
          download_options: downloadOptions
        });
      } else {
        return res.status(404).json({
          status: "error",
          message: "Failed to generate download links",
          original_url: videoUrl
        });
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
      
      return res.status(500).json({
        status: "error",
        message: `Server error: ${error.message}`
      });
    }
  }
  
  // Method not allowed
  return res.status(405).json({ 
    status: "error",
    message: "Method not allowed" 
  });
};
