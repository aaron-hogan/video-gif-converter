#!/usr/bin/env node

const { program } = require('commander');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const gifsicle = require('gifsicle');
const v8 = require('v8');
const crypto = require('crypto');

// Cache configuration
const CACHE_DIR = path.join(os.homedir(), '.vgif-cache');
const CACHE_MAX_SIZE_MB = 2048; // 2GB default cache size limit
const CACHE_MAX_AGE_DAYS = 7; // 1 week max cache age
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

// Check if FFmpeg is installed
try {
  require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
} catch (e) {
  console.error('Error: FFmpeg is not installed or not in your PATH');
  console.error('Please install FFmpeg: https://ffmpeg.org/download.html');
  console.error('For macOS: brew install ffmpeg');
  console.error('For Ubuntu/Debian: sudo apt install ffmpeg');
  process.exit(1);
}

// Check if gifsicle is available (either via npm package or system installation)
let gifsicleAvailable = false;
let gifsicleExePath = null;

try {
  // First try to get the gifsicle binary path from the npm package
  gifsicleExePath = require('gifsicle');
  gifsicleAvailable = true;
} catch (e) {
  // Then try to check if gifsicle is available in system path
  try {
    require('child_process').execSync('gifsicle --version', { stdio: 'ignore' });
    gifsicleExePath = 'gifsicle';
    gifsicleAvailable = true;
  } catch (err) {
    console.warn('Warning: Gifsicle not found. Advanced compression will be disabled.');
    console.warn('To enable better compression, install gifsicle:');
    console.warn(' - macOS: brew install gifsicle');
    console.warn(' - Ubuntu/Debian: sudo apt install gifsicle');
    console.warn(' - npm: npm install gifsicle');
  }
}

program
  .name('vgif')
  .description('CLI to convert YouTube videos or local video files to looping GIFs')
  .version('1.1.0')
  .option('-u, --url <url>', 'YouTube video URL')
  .option('-i, --input <filepath>', 'Local video file path')
  .option('-s, --start <seconds>', 'Start time in seconds', '0')
  .option('-d, --duration <seconds>', 'Duration in seconds', '5')
  .option('-o, --output <filename>', 'Output filename (defaults to input filename with .gif extension)')
  .option('-w, --width <pixels>', 'Width of the GIF in pixels', '480')
  .option('-f, --fps <fps>', 'Frames per second', '30')
  .option('-l, --loops <count>', 'Number of loops (0 = infinite)', '0')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-m, --max-size <mb>', 'Maximum output file size in MB (constrains quality automatically)', '50')
  .option('-c, --crossfade <seconds>', 'Apply crossfade effect for looping, duration in seconds', '0')
  .option('-p, --speed <factor>', 'Playback speed (0.5 = half speed, 2.0 = double speed)', '1.0')
  .option('--colors <number>', 'Maximum number of colors in the palette (2-256, fewer colors = smaller files)', '256')
  .option('--lossy <level>', 'Lossy compression level (1-100, higher = smaller files but lower quality)', '80') 
  .option('--dither <type>', 'Dithering method (none, floyd_steinberg, bayer, sierra2_4a)', 'sierra2_4a')
  .option('--memory-limit <mb>', 'Maximum memory usage in MB (0 = no limit)', '2048')
  .option('--threads <count>', 'Number of FFmpeg threads to use (0 = auto)', '0')
  .option('--no-cache', 'Disable caching for YouTube downloads')
  .option('--cache-dir <path>', 'Directory to store downloaded video cache', CACHE_DIR)
  .option('--cache-size <mb>', 'Maximum cache size in MB', String(CACHE_MAX_SIZE_MB))
  .option('--quality <value>', 'Video quality to download (lowest, low, medium, high, highest)', 'auto')
  .parse(process.argv);

const options = program.opts();

// Convert numeric options to appropriate types
options.crossfade = parseFloat(options.crossfade);
options.speed = parseFloat(options.speed);
options.colors = parseInt(options.colors);
options.lossy = parseInt(options.lossy);
options.memoryLimit = parseInt(options.memoryLimit);
options.threads = parseInt(options.threads);
options.cacheSize = parseInt(options.cacheSize);

// Validate speed option
if (isNaN(options.speed) || options.speed <= 0) {
  console.error('Error: Speed must be a positive number');
  process.exit(1);
}

if (options.speed < 0.25 || options.speed > 4.0) {
  console.warn('Warning: Speed values outside the range of 0.25-4.0 may produce unexpected results');
}

// Validate colors option
if (isNaN(options.colors) || options.colors < 2 || options.colors > 256) {
  console.error('Error: Colors must be a number between 2 and 256');
  process.exit(1);
}

// Validate lossy option
if (isNaN(options.lossy) || options.lossy < 0 || options.lossy > 100) {
  console.error('Error: Lossy compression level must be a number between 0 and 100');
  process.exit(1);
}

// Validate dither option
const validDithers = ['none', 'floyd_steinberg', 'bayer', 'sierra2_4a'];
if (!validDithers.includes(options.dither)) {
  console.error(`Error: Dither must be one of: ${validDithers.join(', ')}`);
  process.exit(1);
}

// Validate memory limit
if (isNaN(options.memoryLimit) || options.memoryLimit < 0) {
  console.error('Error: Memory limit must be a non-negative number');
  process.exit(1);
}

// Validate threads
if (isNaN(options.threads) || options.threads < 0) {
  console.error('Error: Thread count must be a non-negative number');
  process.exit(1);
}

// Validate cache size
if (isNaN(options.cacheSize) || options.cacheSize < 0) {
  console.error('Error: Cache size must be a non-negative number');
  process.exit(1);
}

// Validate quality option
const validQualities = ['auto', 'lowest', 'low', 'medium', 'high', 'highest'];
if (!validQualities.includes(options.quality)) {
  console.error(`Error: Quality must be one of: ${validQualities.join(', ')}`);
  process.exit(1);
}

/**
 * Get the current memory usage
 * @returns {Object} Memory usage statistics in MB
 */
function getMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  const v8HeapStats = v8.getHeapStatistics();
  
  return {
    rss: Math.round(memoryUsage.rss / (1024 * 1024)), // Resident Set Size in MB
    heapTotal: Math.round(memoryUsage.heapTotal / (1024 * 1024)), // Total size of the allocated heap
    heapUsed: Math.round(memoryUsage.heapUsed / (1024 * 1024)), // Actual memory used during execution
    external: Math.round(memoryUsage.external / (1024 * 1024)), // Memory used by C++ objects bound to JavaScript
    heapSizeLimit: Math.round(v8HeapStats.heap_size_limit / (1024 * 1024)), // V8 heap size limit
    totalSystemMemory: Math.round(os.totalmem() / (1024 * 1024)), // Total system memory in MB
    freeSystemMemory: Math.round(os.freemem() / (1024 * 1024)), // Free system memory in MB
  };
}

/**
 * Check if memory usage exceeds the limit
 * @returns {boolean} True if memory limit is exceeded, false otherwise
 */
function isMemoryLimitExceeded() {
  if (options.memoryLimit <= 0) {
    return false; // No limit set
  }
  
  const memUsage = getMemoryUsage();
  return memUsage.rss > options.memoryLimit;
}

/**
 * Log memory usage if verbose mode is enabled
 */
function logMemoryUsage() {
  if (!options.verbose) return;
  
  const memUsage = getMemoryUsage();
  console.log('Memory usage:');
  console.log(`  Process RSS: ${memUsage.rss}MB`);
  console.log(`  Heap used: ${memUsage.heapUsed}MB / ${memUsage.heapTotal}MB`);
  console.log(`  System memory: ${memUsage.freeSystemMemory}MB free of ${memUsage.totalSystemMemory}MB`);
  
  if (options.memoryLimit > 0) {
    console.log(`  Memory limit: ${options.memoryLimit}MB (${Math.round(memUsage.rss / options.memoryLimit * 100)}% used)`);
  }
}

/**
 * Create cache directory if it doesn't exist
 */
function initializeCache() {
  if (!options.cache) {
    if (options.verbose) {
      console.log('Cache disabled with --no-cache flag');
    }
    return false;
  }
  
  try {
    // Ensure cache directory exists
    if (!fs.existsSync(options.cacheDir)) {
      fs.mkdirSync(options.cacheDir, { recursive: true });
      if (options.verbose) {
        console.log(`Created cache directory: ${options.cacheDir}`);
      }
    }
    
    // Create segments directory
    const segmentsDir = path.join(options.cacheDir, 'segments');
    if (!fs.existsSync(segmentsDir)) {
      fs.mkdirSync(segmentsDir, { recursive: true });
    }
    
    // Create info directory
    const infoDir = path.join(options.cacheDir, 'info');
    if (!fs.existsSync(infoDir)) {
      fs.mkdirSync(infoDir, { recursive: true });
    }
    
    // Clean cache if it exceeds size limit
    cleanupCache();
    return true;
  } catch (err) {
    console.warn(`Warning: Could not initialize cache: ${err.message}`);
    console.warn('Continuing without caching');
    return false;
  }
}

/**
 * Get cache key from URL and time range
 * @param {string} videoId - YouTube video ID
 * @param {number} start - Start time in seconds
 * @param {number} duration - Duration in seconds
 * @returns {string} - Cache key
 */
function getCacheKey(videoId, start, duration) {
  const hash = crypto.createHash('md5').update(`${videoId}|${start}|${duration}`).digest('hex');
  return hash;
}

/**
 * Check if a segment is cached
 * @param {string} videoId - YouTube video ID
 * @param {number} start - Start time in seconds
 * @param {number} duration - Duration in seconds
 * @returns {string|null} - Path to cached segment or null if not cached
 */
function getCachedSegment(videoId, start, duration) {
  if (!options.cache) return null;
  
  const cacheKey = getCacheKey(videoId, start, duration);
  const cachedSegmentPath = path.join(options.cacheDir, 'segments', `${cacheKey}.mp4`);
  
  if (fs.existsSync(cachedSegmentPath)) {
    const stats = fs.statSync(cachedSegmentPath);
    const fileAgeDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
    
    // Check if the file is not too old and not empty
    if (fileAgeDays <= CACHE_MAX_AGE_DAYS && stats.size > 0) {
      if (options.verbose) {
        console.log(`Using cached segment: ${cachedSegmentPath}`);
      }
      return cachedSegmentPath;
    }
    
    // Remove stale cache entry
    try {
      fs.unlinkSync(cachedSegmentPath);
    } catch (err) {
      console.warn(`Warning: Could not remove stale cache entry: ${err.message}`);
    }
  }
  
  return null;
}

/**
 * Save segment to cache
 * @param {string} videoId - YouTube video ID
 * @param {number} start - Start time in seconds
 * @param {number} duration - Duration in seconds
 * @param {string} segmentPath - Path to segment file
 * @returns {string} - Path to cached segment
 */
function saveCachedSegment(videoId, start, duration, segmentPath) {
  if (!options.cache) return segmentPath;
  
  try {
    const cacheKey = getCacheKey(videoId, start, duration);
    const cachedSegmentPath = path.join(options.cacheDir, 'segments', `${cacheKey}.mp4`);
    
    // Copy segment to cache
    fs.copyFileSync(segmentPath, cachedSegmentPath);
    
    if (options.verbose) {
      console.log(`Saved segment to cache: ${cachedSegmentPath}`);
    }
    
    return cachedSegmentPath;
  } catch (err) {
    console.warn(`Warning: Could not save segment to cache: ${err.message}`);
    return segmentPath;
  }
}

/**
 * Get cached video info
 * @param {string} videoId - YouTube video ID
 * @returns {object|null} - Cached video info or null if not cached
 */
function getCachedVideoInfo(videoId) {
  if (!options.cache) return null;
  
  const cacheInfoPath = path.join(options.cacheDir, 'info', `${videoId}.json`);
  
  if (fs.existsSync(cacheInfoPath)) {
    const stats = fs.statSync(cacheInfoPath);
    const fileAgeDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
    
    // Check if the file is not too old
    if (fileAgeDays <= CACHE_MAX_AGE_DAYS) {
      try {
        const infoData = fs.readFileSync(cacheInfoPath, 'utf8');
        const info = JSON.parse(infoData);
        if (options.verbose) {
          console.log(`Using cached video info for: ${videoId}`);
        }
        return info;
      } catch (err) {
        console.warn(`Warning: Could not read cached video info: ${err.message}`);
      }
    }
    
    // Remove stale cache entry
    try {
      fs.unlinkSync(cacheInfoPath);
    } catch (err) {
      console.warn(`Warning: Could not remove stale cache info: ${err.message}`);
    }
  }
  
  return null;
}

/**
 * Save video info to cache
 * @param {string} videoId - YouTube video ID
 * @param {object} info - Video info object
 */
function saveCachedVideoInfo(videoId, info) {
  if (!options.cache) return;
  
  try {
    const cacheInfoPath = path.join(options.cacheDir, 'info', `${videoId}.json`);
    fs.writeFileSync(cacheInfoPath, JSON.stringify(info, null, 2));
    
    if (options.verbose) {
      console.log(`Saved video info to cache: ${cacheInfoPath}`);
    }
  } catch (err) {
    console.warn(`Warning: Could not save video info to cache: ${err.message}`);
  }
}

/**
 * Clean up cache based on size and age limits
 */
function cleanupCache() {
  if (!options.cache) return;
  
  try {
    // Get all cache files
    const segmentsDir = path.join(options.cacheDir, 'segments');
    const infoDir = path.join(options.cacheDir, 'info');
    
    // Get all cache files with stats
    const cacheFiles = [];
    
    // Add segment files
    if (fs.existsSync(segmentsDir)) {
      fs.readdirSync(segmentsDir).forEach(file => {
        const filePath = path.join(segmentsDir, file);
        const stats = fs.statSync(filePath);
        cacheFiles.push({
          path: filePath,
          size: stats.size,
          mtime: stats.mtime.getTime()
        });
      });
    }
    
    // Add info files
    if (fs.existsSync(infoDir)) {
      fs.readdirSync(infoDir).forEach(file => {
        const filePath = path.join(infoDir, file);
        const stats = fs.statSync(filePath);
        cacheFiles.push({
          path: filePath,
          size: stats.size,
          mtime: stats.mtime.getTime()
        });
      });
    }
    
    // First remove files that are too old
    const now = Date.now();
    const maxAge = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    
    const filesToRemove = cacheFiles.filter(file => {
      return (now - file.mtime) > maxAge;
    });
    
    // Remove old files
    filesToRemove.forEach(file => {
      try {
        fs.unlinkSync(file.path);
        if (options.verbose) {
          console.log(`Removed stale cache file: ${file.path}`);
        }
      } catch (err) {
        console.warn(`Warning: Could not remove cache file: ${err.message}`);
      }
    });
    
    // Then check total cache size and remove oldest files if needed
    const remainingFiles = cacheFiles.filter(file => !filesToRemove.includes(file))
      .sort((a, b) => a.mtime - b.mtime); // Sort by age, oldest first
    
    let totalSize = remainingFiles.reduce((sum, file) => sum + file.size, 0);
    const maxSize = options.cacheSize * 1024 * 1024; // Convert MB to bytes
    
    // Remove oldest files if cache exceeds size limit
    while (totalSize > maxSize && remainingFiles.length > 0) {
      const oldestFile = remainingFiles.shift();
      
      try {
        fs.unlinkSync(oldestFile.path);
        totalSize -= oldestFile.size;
        
        if (options.verbose) {
          console.log(`Removed old cache file to save space: ${oldestFile.path}`);
        }
      } catch (err) {
        console.warn(`Warning: Could not remove cache file: ${err.message}`);
      }
    }
    
    if (options.verbose) {
      const currentSizeMB = Math.round(totalSize / (1024 * 1024));
      console.log(`Cache size after cleanup: ${currentSizeMB}MB / ${options.cacheSize}MB`);
    }
  } catch (err) {
    console.warn(`Warning: Error during cache cleanup: ${err.message}`);
  }
}

/**
 * Execute an async function with retry logic
 * @param {Function} fn - Async function to execute
 * @param {number} [maxRetries=3] - Maximum number of retry attempts
 * @param {number} [delay=1000] - Delay between retries in milliseconds
 * @param {Function} [onRetry] - Function to call on retry
 * @returns {Promise<any>} - Result of the function
 */
async function withRetry(fn, maxRetries = DEFAULT_RETRY_ATTEMPTS, delay = DEFAULT_RETRY_DELAY_MS, onRetry = null) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      
      // Don't retry on final attempt
      if (attempt <= maxRetries) {
        const retryDelay = delay * Math.pow(1.5, attempt - 1); // Exponential backoff
        
        if (onRetry) {
          onRetry(err, attempt, maxRetries);
        } else if (options.verbose) {
          console.warn(`Attempt ${attempt}/${maxRetries + 1} failed: ${err.message}`);
          console.warn(`Retrying in ${Math.round(retryDelay / 1000)} seconds...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Extract YouTube video ID from URL
 * @param {string} url - YouTube URL
 * @returns {string|null} - Video ID or null if unable to extract
 */
function extractVideoId(url) {
  try {
    // Try to parse as URL
    const parsedUrl = new URL(url);
    
    // YouTube standard URL (youtube.com/watch?v=VIDEO_ID)
    if (parsedUrl.hostname.includes('youtube.com')) {
      // Check for standard watch URL
      if (parsedUrl.searchParams.has('v')) {
        return parsedUrl.searchParams.get('v');
      }
      
      // Check for shorts URL (youtube.com/shorts/VIDEO_ID)
      if (parsedUrl.pathname.includes('/shorts/')) {
        const shortsMatch = parsedUrl.pathname.match(/\/shorts\/([^\/\?]+)/);
        if (shortsMatch && shortsMatch[1]) {
          return shortsMatch[1];
        }
      }
    }
    
    // YouTube shortened URL (youtu.be/VIDEO_ID)
    if (parsedUrl.hostname === 'youtu.be') {
      return parsedUrl.pathname.substring(1);
    }
    
    // If parsing fails, try regex as fallback
  } catch (e) {
    // URL parsing failed, use regex fallback
  }
  
  // Regex fallback for various YouTube URL formats including shorts
  const regex = /(?:youtube\.com\/(?:shorts\/|[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

/**
 * Convert seconds to YouTube time format (3m0s)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time string
 */
function formatYouTubeTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

/**
 * Add timestamp to YouTube URL to start at a specific time
 * @param {string} url - YouTube URL
 * @param {number} seconds - Start time in seconds
 * @returns {string} - URL with timestamp
 */
function addTimestampToUrl(url, seconds) {
  try {
    // Parse the URL
    const parsedUrl = new URL(url);
    
    // Set the timestamp parameter
    parsedUrl.searchParams.set('t', formatYouTubeTime(seconds));
    
    return parsedUrl.toString();
  } catch (e) {
    // If URL parsing fails, append the timestamp directly
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}t=${formatYouTubeTime(seconds)}`;
  }
}

/**
 * Check if memory usage exceeds the limit
 * @returns {boolean} True if memory limit is exceeded, false otherwise
 */
function isMemoryLimitExceeded() {
  if (options.memoryLimit <= 0) {
    return false; // No limit set
  }
  
  const memUsage = getMemoryUsage();
  return memUsage.rss > options.memoryLimit;
}

/**
 * Log memory usage if verbose mode is enabled
 */
function logMemoryUsage() {
  if (!options.verbose) return;
  
  const memUsage = getMemoryUsage();
  console.log('Memory usage:');
  console.log(`  Process RSS: ${memUsage.rss}MB`);
  console.log(`  Heap used: ${memUsage.heapUsed}MB / ${memUsage.heapTotal}MB`);
  console.log(`  System memory: ${memUsage.freeSystemMemory}MB free of ${memUsage.totalSystemMemory}MB`);
  
  if (options.memoryLimit > 0) {
    console.log(`  Memory limit: ${options.memoryLimit}MB (${Math.round(memUsage.rss / options.memoryLimit * 100)}% used)`);
  }
}

/**
 * Download a segment of a YouTube video based on start time and duration
 * This implementation downloads the entire video and then extracts the segment
 * @param {string} videoId - YouTube video ID
 * @param {object} videoInfo - Video info from ytdl.getInfo
 * @param {number} startTime - Start time in seconds
 * @param {number} duration - Duration in seconds
 * @param {string} outputPath - Output path for the segment
 * @param {string} quality - Quality level to download
 * @returns {Promise<string>} - Path to the downloaded segment
 */
async function downloadVideoSegment(videoId, videoInfo, startTime, duration, outputPath, quality = 'auto') {
  return new Promise(async (resolve, reject) => {
    try {
      // Check if segment is already cached
      const cachedSegmentPath = getCachedSegment(videoId, startTime, duration);
      if (cachedSegmentPath) {
        // If we found a cached segment, copy it to the output path
        fs.copyFileSync(cachedSegmentPath, outputPath);
        return resolve(outputPath);
      }
      
      // Output appropriate message for seeking vs. starting at 0
      if (startTime > 0) {
        console.log(`Downloading segment from ${startTime}s to ${startTime + duration}s...`);
      } else {
        console.log(`Downloading segment of ${duration}s duration...`);
      }
      
      // Select format based on quality preference
      let formats = videoInfo.formats.filter(format => format.hasVideo);
      
      // Prefer MP4 format when available for better compatibility
      const mp4Formats = formats.filter(format => 
        format.container === 'mp4' || 
        format.mimeType?.includes('mp4') ||
        format.mimeType?.includes('h264')
      );
      
      // Use MP4 formats if available, otherwise use all available formats
      const compatibleFormats = mp4Formats.length > 0 ? mp4Formats : formats;
      
      if (options.verbose && mp4Formats.length > 0) {
        console.log('Found MP4/H.264 formats for better compatibility');
      }
      
      let selectedFormat;
      
      // If auto quality, use target width to determine best format
      if (quality === 'auto') {
        // Target width from options plus a buffer (1.5x to ensure quality)
        const targetWidth = Math.min(1920, parseInt(options.width) * 1.5);
        
        // Sort by width and find first format with width >= target
        compatibleFormats.sort((a, b) => a.width - b.width);
        
        // Find first format with width >= target or use highest available
        selectedFormat = compatibleFormats.find(f => f.width >= targetWidth) || compatibleFormats[compatibleFormats.length - 1];
        
        if (options.verbose) {
          console.log(`Auto-selected format: ${selectedFormat.qualityLabel || 'unknown'} (${selectedFormat.width}x${selectedFormat.height})`);
        }
      }
      // Handle specific quality requests
      else {
        compatibleFormats.sort((a, b) => a.width - b.width);
        
        // Quality selection based on the user's preference
        const formatCount = compatibleFormats.length;
        
        switch (quality) {
          case 'lowest':
            selectedFormat = compatibleFormats[0];
            break;
          case 'low':
            selectedFormat = compatibleFormats[Math.floor(formatCount * 0.25)] || compatibleFormats[0];
            break;
          case 'medium':
            selectedFormat = compatibleFormats[Math.floor(formatCount * 0.5)] || compatibleFormats[0];
            break;
          case 'high':
            selectedFormat = compatibleFormats[Math.floor(formatCount * 0.75)] || compatibleFormats[compatibleFormats.length - 1];
            break;
          case 'highest':
            selectedFormat = compatibleFormats[formatCount - 1];
            break;
          default:
            selectedFormat = compatibleFormats[Math.floor(formatCount * 0.5)] || compatibleFormats[0];
        }
        
        if (options.verbose) {
          console.log(`Selected ${quality} quality format: ${selectedFormat.qualityLabel || 'unknown'} (${selectedFormat.width}x${selectedFormat.height})`);
        }
      }
      
      // Generate temporary file paths
      const tempFullVideoPath = `${outputPath}.full.mp4`;
      
      // Download the full video or a larger segment
      console.log(`Downloading full or partial video...`);
      
      // Create a video stream
      const videoStream = ytdl.downloadFromInfo(videoInfo, { format: selectedFormat });
      const writeStream = fs.createWriteStream(tempFullVideoPath);
      
      videoStream.pipe(writeStream);
      
      videoStream.on('error', (streamErr) => {
        console.error('Error downloading video stream:', streamErr.message);
        
        // Provide more helpful error messages for common issues
        if (streamErr.message.includes('403')) {
          console.error('\nAccess denied (403 Forbidden) when downloading this video.');
          console.error('This can happen due to:');
          console.error('  - Age-restricted videos');
          console.error('  - Geo-restricted videos');
          console.error('  - Videos with copyright strikes');
          console.error('  - Recent changes in YouTube\'s access policies');
          console.error('\nTry downloading the video manually and use the -i option instead:');
          console.error(`  yt-dlp "${options.url}" -o video.mp4`);
          console.error(`  vgif -i video.mp4 -s ${options.start} -d ${options.duration} -c ${options.crossfade} -w ${options.width}`);
        }
        
        reject(streamErr);
      });
      
      writeStream.on('finish', () => {
        console.log('Video download complete. Extracting segment...');
        
        // Use FFmpeg to extract the segment from the full video
        const threadOpt = options.threads > 0 ? 
          ['-threads', String(options.threads)] : 
          (options.threads === 0 ? ['-threads', String(os.cpus().length)] : []);
        
        ffmpeg(tempFullVideoPath)
          .seekInput(startTime)
          .duration(duration)
          .outputOptions([
            // Copy streams without re-encoding if possible
            '-c:v', 'copy',
            '-c:a', 'copy',
            ...threadOpt
          ])
          .output(outputPath)
          .on('start', (commandLine) => {
            if (options.verbose) {
              console.log('FFmpeg extract command:', commandLine);
            }
          })
          .on('end', () => {
            console.log('Segment extraction complete');
            
            // Clean up temp files
            try {
              fs.unlinkSync(tempFullVideoPath);
            } catch (e) {
              // Ignore cleanup errors
            }
            
            // Verify output file
            if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
              console.error('Error: Extracted segment is empty or missing');
              
              // Try one more time with transcoding instead of copy
              console.log('Retrying extraction with transcoding...');
              
              ffmpeg(tempFullVideoPath)
                .seekInput(startTime)
                .duration(duration)
                .outputOptions([
                  '-c:v', 'h264',
                  '-crf', '23',
                  '-preset', 'fast',
                  ...threadOpt
                ])
                .output(outputPath)
                .on('end', () => {
                  console.log('Transcoded segment extraction complete');
                  
                  try {
                    if (fs.existsSync(tempFullVideoPath)) {
                      fs.unlinkSync(tempFullVideoPath);
                    }
                  } catch (e) {
                    // Ignore cleanup errors
                  }
                  
                  // Save to cache
                  if (options.cache) {
                    saveCachedSegment(videoId, startTime, duration, outputPath);
                  }
                  
                  resolve(outputPath);
                })
                .on('error', (transErr) => {
                  console.error('Transcoded extraction failed:', transErr.message);
                  reject(transErr);
                })
                .run();
            } else {
              // Save to cache
              if (options.cache) {
                saveCachedSegment(videoId, startTime, duration, outputPath);
              }
              
              resolve(outputPath);
            }
          })
          .on('error', (extractErr) => {
            console.error('Error extracting segment:', extractErr.message);
            
            // Try one more time with transcoding instead of copy
            console.log('Retrying extraction with transcoding...');
            
            ffmpeg(tempFullVideoPath)
              .seekInput(startTime)
              .duration(duration)
              .outputOptions([
                '-c:v', 'h264',
                '-crf', '23',
                '-preset', 'fast',
                ...threadOpt
              ])
              .output(outputPath)
              .on('end', () => {
                console.log('Transcoded segment extraction complete');
                
                try {
                  if (fs.existsSync(tempFullVideoPath)) {
                    fs.unlinkSync(tempFullVideoPath);
                  }
                } catch (e) {
                  // Ignore cleanup errors
                }
                
                // Save to cache
                if (options.cache) {
                  saveCachedSegment(videoId, startTime, duration, outputPath);
                }
                
                resolve(outputPath);
              })
              .on('error', (transErr) => {
                console.error('Transcoded extraction failed:', transErr.message);
                reject(transErr);
              })
              .run();
          })
          .run();
      });
      
      writeStream.on('error', (fileErr) => {
        console.error('Error writing video file:', fileErr.message);
        reject(fileErr);
      });
      
    } catch (err) {
      console.error('Error in downloadVideoSegment:', err.message);
      reject(err);
    }
  });
}

// Function to check if crossfade is enabled
function isCrossfadeEnabled() {
  return options.crossfade > 0;
}

// Function to check if hardware acceleration is available
async function detectHardwareAcceleration() {
  return new Promise((resolve) => {
    // Always return no hardware acceleration for troubleshooting
    const hwAccel = {
      available: false,
      type: null,
      filters: [],
      options: []
    };
    
    console.log('Hardware acceleration disabled for troubleshooting');
    resolve(hwAccel);
  });
}

// Validate that either URL or input file is provided
if (!options.url && !options.input) {
  console.error('Error: You must provide either a YouTube URL (-u, --url) or a local video file path (-i, --input)');
  process.exit(1);
}

// Validate that both URL and input aren't provided at the same time
if (options.url && options.input) {
  console.error('Error: Please provide either a YouTube URL (-u, --url) OR a local file path (-i, --input), not both');
  process.exit(1);
}

/**
 * Function to create a crossfade effect for perfectly looping GIFs using a simplified approach
 * that should work regardless of how the video was downloaded or what position we're seeking to.
 *
 * @param {string} videoPath - Path to the source video
 * @param {string} tempDir - Temporary directory for processing files
 * @param {string} outputPath - Path where the final GIF will be saved
 * @param {object} hwAccel - Hardware acceleration object with detection results
 * @param {function} cleanupCallback - Optional callback function for cleaning up temp files
 * @returns {Promise} - Resolves when GIF is created
 */
async function processCrossfade(videoPath, tempDir, outputPath, hwAccel = { available: false }, cleanupCallback = null) {
  try {
    console.log('Creating crossfade effect directly...');
    
    // Create a temporary video with crossfade
    const tempVideoPath = path.join(tempDir, 'crossfade_video.mp4');
    
    // Track this temp file for cleanup if needed
    if (typeof trackTempFile === 'function') {
      trackTempFile(tempVideoPath);
    }
    
    // Parse durations and calculate timing
    const totalDuration = parseFloat(options.duration);
    const crossfadeDuration = options.crossfade;
    
    // For simplicity's sake, we'll just extract the whole segment once and create the crossfade
    // using that segment, rather than trying to calculate offsets into the original video
    return new Promise((resolve, reject) => {
      // Create a filter that makes the end of the clip fade into the beginning
      // to create a perfect loop
      let complexFilter = [
        // Split the video into parts we'll need
        '[0:v]split=3[begin][middle][end]',
        
        // Extract the main portion from after the initial crossfade duration to before the end
        '[middle]trim=start=' + crossfadeDuration + ':end=' + (totalDuration - crossfadeDuration) + ',setpts=PTS-STARTPTS[main]',
        
        // Extract the beginning portion for the end transition
        '[begin]trim=start=0:end=' + crossfadeDuration + ',setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=' + crossfadeDuration + ':alpha=1[fadein]',
        
        // Extract the end portion with fade out
        '[end]trim=start=' + (totalDuration - crossfadeDuration) + ':end=' + totalDuration + ',setpts=PTS-STARTPTS,format=yuva420p,fade=t=out:st=0:d=' + crossfadeDuration + ':alpha=1[fadeout]',
        
        // Overlay the beginning (fadein) over the end (fadeout) to create the loop transition
        '[fadeout][fadein]overlay[transition]',
        
        // Concatenate the main part with the transition to create the final looping video
        '[main][transition]concat=n=2:v=1:a=0'
      ].join(';');
      
      /* 
      // DEBUG VERSION with visual timecodes - uncomment if needed for troubleshooting
      if (options.verbose) {
        complexFilter = [
          // Main section with RED timestamp
          `[0:v]trim=start=${startTime + baseOffset}:duration=${mainDuration},setpts=PTS-STARTPTS,drawtext=text='MAIN %{pts\\:hms}':x=10:y=10:fontsize=36:fontcolor=red:box=1:boxcolor=black@0.5[main]`,
          
          // End segment with fade out
          `[0:v]trim=start=${startTime + mainDuration + baseOffset}:duration=${crossfadeDuration},setpts=PTS-STARTPTS,format=yuva420p,fade=t=out:st=0:d=${crossfadeDuration}:alpha=1[fout]`,
          
          // Beginning segment with BLUE timestamp in top-right
          `[0:v]trim=start=${startTime}:duration=${crossfadeDuration},setpts=PTS-STARTPTS,drawtext=text='START %{pts\\:hms}':x=w-280:y=10:fontsize=36:fontcolor=blue:box=1:boxcolor=white@0.5,format=yuva420p,fade=t=in:st=0:d=${crossfadeDuration}:alpha=1[fin]`,
          
          // Overlay the fading segments
          `[fin][fout]overlay[crossfade]`,
          
          // Join the main part with the crossfade
          `[main][crossfade]concat=n=2:v=1:a=0`
        ].join(';');
      }
      */
      
      // Log memory usage before processing
      logMemoryUsage();
      
      // Check if memory limit is already exceeded
      if (isMemoryLimitExceeded()) {
        console.warn('Warning: Memory limit already exceeded before processing');
        if (options.memoryLimit > 0) {
          console.warn(`Current memory usage: ${getMemoryUsage().rss}MB, limit: ${options.memoryLimit}MB`);
        }
      }
      
      let command = ffmpeg(videoPath)
        .complexFilter(complexFilter)
        .output(tempVideoPath)
        .outputOptions(['-map', '0:a?']); // Include audio if present
        
      // Apply threading options if specified
      if (options.threads > 0) {
        command.outputOptions([
          `-threads ${options.threads}`
        ]);
        if (options.verbose) {
          console.log(`Using ${options.threads} FFmpeg threads for crossfade processing`);
        }
      } else if (options.threads === 0) {
        // Auto-threading mode - use CPU core count
        const cpuCount = os.cpus().length;
        command.outputOptions([
          `-threads ${cpuCount}`
        ]);
        if (options.verbose) {
          console.log(`Using auto-threading with ${cpuCount} CPU cores for crossfade processing`);
        }
      }
        
      command.on('start', (commandLine) => {
        if (options.verbose) {
          console.log('FFmpeg command:', commandLine);
        }
      })
        .on('end', () => {
          console.log('Crossfade video created successfully');
          
          // Now convert the video to GIF using high-quality two-pass approach
          console.log('Generating palette for high-quality GIF...');
          
          // Ensure output directory exists
          const outputDir = path.dirname(path.resolve(outputPath));
          if (!fs.existsSync(outputDir)) {
            console.log(`Creating output directory: ${outputDir}`);
            fs.mkdirSync(outputDir, { recursive: true });
          }
          
          // Check that we have write access to the output directory
          try {
            fs.accessSync(outputDir, fs.constants.W_OK);
          } catch (err) {
            console.error(`Error: No write permission to output directory: ${outputDir}`);
            throw err;
          }
          
          // Log memory usage before second pass
          logMemoryUsage();
          
          // Optimized single-pass approach for crossfade GIF
          console.log('Creating optimized GIF with single-pass filtergraph...');
          
          // Use a single complex filtergraph for palette generation and application
          let ffmpegCrossfade = ffmpeg(tempVideoPath);
          
          // Apply hardware acceleration if available
          if (hwAccel.available) {
            console.log(`Using ${hwAccel.type} hardware acceleration for crossfade`);
            hwAccel.options.forEach(option => {
              ffmpegCrossfade.inputOption(option);
            });
          }
          
          // Apply threading options
          if (options.threads > 0) {
            ffmpegCrossfade.outputOptions([
              `-threads ${options.threads}`
            ]);
            if (options.verbose) {
              console.log(`Using ${options.threads} FFmpeg threads for GIF creation`);
            }
          } else if (options.threads === 0) {
            // Auto-threading mode - use CPU core count
            const cpuCount = os.cpus().length;
            ffmpegCrossfade.outputOptions([
              `-threads ${cpuCount}`
            ]);
            if (options.verbose) {
              console.log(`Using auto-threading with ${cpuCount} CPU cores for GIF creation`);
            }
          }
          
          ffmpegCrossfade
            .complexFilter([
              // Set FPS and scale the video
              `fps=${options.fps},scale=${options.width}:-1:flags=lanczos,split[s0][s1]`,
              // Generate the palette from the scaled video
              `[s0]palettegen=stats_mode=diff:max_colors=${options.colors}[palette]`,
              // Apply the palette to the scaled video
              `[s1][palette]paletteuse=dither=${options.dither}`
            ])
            .outputOption('-loop', options.loops)
            .format('gif')
            .save(outputPath) // Use save() instead of output().run()
            .on('end', async () => {
              // Clean up the temporary crossfade video immediately
              if (cleanupCallback) {
                cleanupCallback(tempVideoPath);
              }
              
              // Apply post-processing with gifsicle for better compression
              try {
                await postProcessGif(outputPath, options);
              } catch (err) {
                console.error('Error during post-processing:', err.message);
              }
              console.log(`Success! GIF with crossfade saved to: ${path.resolve(outputPath)}`);
              resolve();
            })
            .on('error', (err) => {
              console.error('Error creating final GIF:', err.message);
              reject(err);
            });
        })
        .on('error', (err) => {
          console.error('Error creating crossfade video:', err.message);
          reject(err);
        })
        .run();
    });
  } catch (error) {
    console.error('Error in crossfade processing:', error.message);
    throw error;
  }
}

/**
 * Post-process a GIF file to optimize and compress it
 * @param {string} inputPath - Path to the input GIF
 * @param {object} options - Compression options
 * @param {number} options.colors - Number of colors (2-256)
 * @param {number} options.lossy - Lossy compression level (1-100)
 * @param {string} options.dither - Dithering method
 * @returns {Promise<void>} - Resolves when compression is complete
 */
async function postProcessGif(inputPath, options) {
  return new Promise((resolve, reject) => {
    // Skip if gifsicle is not available
    if (!gifsicleAvailable) {
      console.warn('Skipping optimization (gifsicle not available)');
      return resolve();
    }
    
    // Skip optimization if colors are 256 and lossy is 0
    if (options.colors === 256 && options.lossy === 0) {
      console.log('Skipping optimization (using maximum quality settings)');
      return resolve();
    }
    
    console.log('Optimizing GIF to reduce file size...');
    
    // Calculate original file size
    const originalSize = fs.statSync(inputPath).size / (1024 * 1024); // in MB
    
    // Build gifsicle arguments
    const args = [
      '--optimize=3', // Highest optimization level
      '--no-warnings',
      `--colors=${options.colors}`
    ];
    
    // Add lossy compression if enabled
    if (options.lossy > 0) {
      args.push(`--lossy=${options.lossy}`);
    }
    
    // Add dithering option
    if (options.dither === 'none') {
      args.push('--no-dither');
    } else if (options.dither === 'floyd_steinberg') {
      args.push('--dither=floyd-steinberg');
    } else if (options.dither === 'bayer') {
      args.push('--dither=ordered');
    } // sierra2_4a is used by default in gifsicle
    
    // Create a temporary path for the optimized GIF
    const tempPath = `${inputPath}.tmp`;
    args.push('--output', tempPath, inputPath);
    
    if (options.verbose) {
      console.log(`Gifsicle arguments: ${args.join(' ')}`);
    }
    
    // Use the gifsicle path we determined earlier
    let gifsicleExe = gifsicleExePath;
    
    // If the path is an object (from npm package), extract the actual path
    if (typeof gifsicleExe === 'object' && gifsicleExe !== null) {
      if (gifsicleExe.path) {
        gifsicleExe = gifsicleExe.path;
      } else if (gifsicleExe.bin) {
        gifsicleExe = gifsicleExe.bin;
      } else {
        // If we can't find the path in the object, use system gifsicle
        gifsicleExe = 'gifsicle';
      }
    }
    
    if (options.verbose) {
      console.log(`Using gifsicle: ${gifsicleExe}`);
    }
    
    execFile(gifsicleExe, args, (error) => {
      if (error) {
        console.error('Error optimizing GIF:', error.message);
        console.warn('Using original unoptimized GIF');
        return resolve();
      }
      
      // Replace the original file with the optimized one
      fs.unlinkSync(inputPath);
      fs.renameSync(tempPath, inputPath);
      
      // Calculate compression ratio
      const newSize = fs.statSync(inputPath).size / (1024 * 1024); // in MB
      const savingsPercent = ((originalSize - newSize) / originalSize) * 100;
      
      console.log(`GIF optimized: ${originalSize.toFixed(2)}MB → ${newSize.toFixed(2)}MB (${savingsPercent.toFixed(1)}% smaller)`);
      resolve();
    });
  });
}

/**
 * Preprocess video with speed adjustment if needed
 * @param {string} inputPath - Path to the input video
 * @param {string} tempDir - Temporary directory for processing
 * @param {number} speed - Speed factor (1.0 = normal, 0.5 = half speed, 2.0 = double speed)
 * @returns {Promise<string>} - Path to the processed video
 */
async function preprocessVideoSpeed(inputPath, tempDir, speed) {
  // If speed is 1.0 (normal), skip preprocessing
  if (speed === 1.0) {
    return inputPath;
  }

  return new Promise((resolve, reject) => {
    const speedAdjustedPath = path.join(tempDir, 'speed_adjusted.mp4');
    
    // Track this temp file for cleanup if needed
    if (typeof trackTempFile === 'function') {
      trackTempFile(speedAdjustedPath);
    }
    
    console.log(`Preprocessing video to ${speed}x speed...`);
    
    // Log memory usage if enabled
    logMemoryUsage();
    
    // Apply speed effect using setpts filter
    // Note: setpts=1/speed*PTS makes the video faster when speed > 1.0 and slower when speed < 1.0
    let command = ffmpeg(inputPath)
      .videoFilter(`setpts=1/${speed}*PTS`)
      .audioFilter(`atempo=${speed}`); // Adjust audio speed too if present
    
    // Apply threading options if specified
    if (options.threads > 0) {
      command.outputOptions([
        `-threads ${options.threads}`
      ]);
      if (options.verbose) {
        console.log(`Using ${options.threads} FFmpeg threads for speed preprocessing`);
      }
    } else if (options.threads === 0) {
      // Auto-threading mode - use CPU core count
      const cpuCount = os.cpus().length;
      command.outputOptions([
        `-threads ${cpuCount}`
      ]);
      if (options.verbose) {
        console.log(`Using auto-threading with ${cpuCount} CPU cores for speed preprocessing`);
      }
    }
    
    command.output(speedAdjustedPath)
      .on('start', (commandLine) => {
        if (options.verbose) {
          console.log('Speed preprocessing command:', commandLine);
        }
      })
      .on('end', () => {
        console.log('Speed preprocessing complete');
        // Log memory usage after processing if enabled
        logMemoryUsage();
        // Don't clean up the original file here - it will be handled after this function returns
        resolve(speedAdjustedPath);
      })
      .on('error', (err) => {
        console.error('Error preprocessing speed:', err.message);
        // If speed preprocessing fails, fall back to the original video
        console.warn('Falling back to original video speed');
        resolve(inputPath);
      })
      .run();
  });
}

async function run() {
  let tempDir = null;
  let videoPath = null;
  let processedVideoPath = null;
  let usingTempVideo = false;
  let tempFiles = [];
  
  // Initialize cache if enabled
  if (options.cache) {
    initializeCache();
  }
  
  // Detect hardware acceleration capabilities
  const hwAccel = await detectHardwareAcceleration();
  
  try {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-gif-'));
    
    // Create a function to clean up temp files immediately
    const cleanupTempFile = (filePath) => {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          
          // Remove from the tracked temp files array if present
          const index = tempFiles.indexOf(filePath);
          if (index > -1) {
            tempFiles.splice(index, 1);
          }
          
          if (options.verbose) {
            console.log(`Cleaned up temp file: ${filePath}`);
          }
        } catch (err) {
          console.warn(`Failed to clean up temp file ${filePath}: ${err.message}`);
        }
      }
    };
    
    // Create a function to track temp files for later cleanup
    const trackTempFile = (filePath) => {
      if (filePath && !tempFiles.includes(filePath)) {
        tempFiles.push(filePath);
      }
    };
    
    // Function to find a non-conflicting filename
    function getUniqueFilePath(basePath) {
      if (!fs.existsSync(basePath)) {
        return basePath;
      }
      
      const ext = path.extname(basePath);
      const baseWithoutExt = basePath.slice(0, -ext.length);
      
      let counter = 1;
      let newPath;
      
      do {
        newPath = `${baseWithoutExt}-${counter}${ext}`;
        counter++;
      } while (fs.existsSync(newPath));
      
      return newPath;
    }
    
    // Determine output path based on input if not specified
    let outputPath;
    if (options.output) {
      outputPath = options.output.endsWith('.gif') ? options.output : `${options.output}.gif`;
    } else if (options.input) {
      // Use input filename with .gif extension
      const inputBasename = path.basename(options.input, path.extname(options.input));
      const inputDir = path.dirname(options.input);
      outputPath = path.join(inputDir, `${inputBasename}.gif`);
    } else if (options.url) {
      // For YouTube URLs without specified output, use the video ID (slug)
      let videoId;
      try {
        // Extract the video ID from URL
        const url = new URL(options.url);
        if (url.hostname.includes('youtube.com')) {
          videoId = url.searchParams.get('v');
        } else if (url.hostname.includes('youtu.be')) {
          videoId = url.pathname.substring(1);
        }
      } catch (e) {
        // If URL parsing fails, fallback to regex
        const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
        const match = options.url.match(regex);
        videoId = match ? match[1] : null;
      }
      
      outputPath = videoId ? `youtube-${videoId}.gif` : `youtube-${Date.now()}.gif`;
    } else {
      outputPath = 'output.gif';
    }
    
    // Ensure we don't overwrite existing files
    outputPath = getUniqueFilePath(outputPath);
    
    // Handle YouTube video
    if (options.url) {
      videoPath = path.join(tempDir, 'video.mp4');
      usingTempVideo = true;
      trackTempFile(videoPath);
      
      console.log('Validating YouTube URL...');
      
      // Get video ID from URL
      const videoId = extractVideoId(options.url);
      
      if (!videoId) {
        console.error('Error: Invalid YouTube URL or could not extract video ID');
        process.exit(1);
      }
      
      if (options.verbose) {
        console.log(`Extracted video ID: ${videoId}`);
      }
      
      console.log('Fetching video information...');
      
      // Try to get video info from cache first
      let videoInfo = getCachedVideoInfo(videoId);
      
      // If not in cache, fetch it with retry logic
      if (!videoInfo) {
        try {
          videoInfo = await withRetry(
            async () => await ytdl.getInfo(options.url, { 
              requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } 
            }),
            DEFAULT_RETRY_ATTEMPTS,
            DEFAULT_RETRY_DELAY_MS,
            (err, attempt, max) => {
              console.warn(`Attempt ${attempt}/${max + 1} to fetch video info failed: ${err.message}`);
              console.warn(`Retrying in ${Math.round(DEFAULT_RETRY_DELAY_MS * Math.pow(1.5, attempt - 1) / 1000)} seconds...`);
            }
          );
          
          // Save to cache if successful
          if (videoInfo && options.cache) {
            saveCachedVideoInfo(videoId, videoInfo);
          }
        } catch (error) {
          if (options.verbose) {
            console.error('Error details:', error);
          }
          console.error('Failed to fetch video information after multiple attempts.');
          console.error('YouTube may have changed their API or the video might be restricted.');
          process.exit(1);
        }
      }
      
      console.log(`Processing: ${videoInfo.videoDetails.title}`);
      
      // Calculate download parameters
      const startTime = parseFloat(options.start);
      const duration = parseFloat(options.duration);
      
      // Note: We've found that the YouTube timestamp feature doesn't work reliably with ytdl-core
      // So we'll keep the original seeking logic for now
      if (options.verbose && startTime > 0) {
        console.log(`Using seek time of ${startTime}s for video processing`);
      }
      
      // Download only the segment we need instead of the full video
      try {
        videoPath = await downloadVideoSegment(
          videoId,
          videoInfo,
          parseFloat(options.start), // This will now be 0 if we're using a URL timestamp
          // Add a small buffer to ensure we have enough video
          duration + (isCrossfadeEnabled() ? options.crossfade : 0) + 0.5, 
          videoPath,
          options.quality
        );
      } catch (error) {
        console.error('Error downloading video segment:', error.message);
        
        if (error.message.includes('403') || error.message.includes('Forbidden')) {
          console.error('\nAccess denied when downloading this video. This is likely due to restrictions on the video.');
          console.error('Try an alternative approach:');
          console.error('1. Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation)');
          console.error(`2. Download the video: yt-dlp "${options.url}" -o video.mp4`);
          console.error(`3. Create the GIF: vgif -i video.mp4 -s ${options.start} -d ${options.duration} -c ${options.crossfade} -w ${options.width}`);
        } else if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
          console.error('\nToo many requests sent to YouTube. Please wait a while and try again.');
        }
        
        if (options.verbose) {
          console.error('Error details:', error);
        }
        process.exit(1);
      }
      
      // Verify the file was downloaded
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
        console.error('Error: Downloaded video file is empty or does not exist');
        process.exit(1);
      }
      
      console.log('Video segment ready for processing');
    } 
    // Handle local video file
    else if (options.input) {
      videoPath = options.input;
      
      // Verify the file exists
      if (!fs.existsSync(videoPath)) {
        console.error(`Error: Input file does not exist: ${videoPath}`);
        process.exit(1);
      }
      
      // Check if the file is readable
      try {
        fs.accessSync(videoPath, fs.constants.R_OK);
      } catch (err) {
        console.error(`Error: Cannot read input file: ${videoPath}`);
        process.exit(1);
      }
      
      console.log(`Processing local video: ${path.basename(videoPath)}`);
    }
    
    console.log('Converting to GIF...');
    
    // Make sure the output directory exists
    const outputDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outputDir)) {
      console.log(`Creating output directory: ${outputDir}`);
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Check if we have write access to the output directory
    try {
      fs.accessSync(outputDir, fs.constants.W_OK);
    } catch (err) {
      console.error(`Error: No write permission to output directory: ${outputDir}`);
      process.exit(1);
    }
    
    // Apply speed preprocessing if needed
    processedVideoPath = await preprocessVideoSpeed(videoPath, tempDir, options.speed);
    
    // Clean up original video file if it was a temp file and is different from processed path
    if (usingTempVideo && videoPath !== processedVideoPath) {
      cleanupTempFile(videoPath);
    }
    
    // From this point on, use processedVideoPath instead of videoPath
    
    // Calculate file size estimate and warn for large files
    const estimatedFrames = parseInt(options.fps) * parseInt(options.duration);
    const estimatedPixels = parseInt(options.width) * parseInt(options.width) * 0.56; // Estimate height based on width
    const estimatedSizeMB = (estimatedFrames * estimatedPixels * 3) / (8 * 1024 * 1024);
    
    const maxSizeMB = parseInt(options.maxSize);
    
    // Handle large file creation
    if (estimatedSizeMB > maxSizeMB) {
      console.warn(`Warning: The requested GIF may be very large (estimated ~${Math.round(estimatedSizeMB)}MB).`);
      console.warn(`Maximum size set to ${maxSizeMB}MB. Adjusting parameters automatically.`);
      
      // Calculate how much we need to reduce
      const reductionFactor = Math.sqrt(estimatedSizeMB / maxSizeMB);
      
      // Reduce by adjusting width and FPS
      const newWidth = Math.floor(parseInt(options.width) / reductionFactor);
      const newFps = Math.max(10, Math.floor(parseInt(options.fps) / (reductionFactor * 0.7)));
      
      console.warn(`Adjusting width from ${options.width}px to ${newWidth}px`);
      console.warn(`Adjusting FPS from ${options.fps} to ${newFps}`);
      
      options.width = newWidth.toString();
      options.fps = newFps.toString();
      
      console.warn(`New estimated size: ~${Math.round(maxSizeMB)}MB`);
      console.warn('Use -m option to change maximum size limit.');
    }
    
    // Check if crossfade is enabled
    if (isCrossfadeEnabled()) {
      const speedInfo = options.speed !== 1.0 ? `, ${options.speed}x speed` : '';
      console.log(`Creating GIF with crossfade effect of ${options.crossfade}s...`);
      console.log(`Settings: ${options.duration}s duration, ${options.width}px width, ${options.fps} FPS${speedInfo}`);
      
      // Validate that crossfade duration is not longer than total duration
      if (options.crossfade >= parseFloat(options.duration)) {
        console.error('Error: Crossfade duration must be less than total duration');
        console.error(`Current values: crossfade=${options.crossfade}s, duration=${options.duration}s`);
        console.error('Please use a shorter crossfade duration or longer total duration');
        process.exit(1);
      }
      
      // Process with crossfade effect - pass the hardware acceleration object and cleanup function
      await processCrossfade(processedVideoPath, tempDir, outputPath, hwAccel, cleanupTempFile);
    } else {
      // Standard processing without crossfade
      await new Promise(async (resolve, reject) => {
        const speedInfo = options.speed !== 1.0 ? ` at ${options.speed}x speed` : '';
        console.log(`Converting video to GIF${speedInfo} (this may take a while)...`);
        console.log(`Settings: ${options.duration}s duration, ${options.width}px width, ${options.fps} FPS`);
        
        // Log memory usage before processing
        logMemoryUsage();
        
        // Check if memory limit is already exceeded
        if (isMemoryLimitExceeded()) {
          console.warn('Warning: Memory limit already exceeded before processing');
          if (options.memoryLimit > 0) {
            console.warn(`Current memory usage: ${getMemoryUsage().rss}MB, limit: ${options.memoryLimit}MB`);
          }
        }
        
        // Generate a palette for better quality
        const palettePath = path.join(tempDir, 'palette.png');
        
        // Optimized single-pass approach using complex filtergraph for palette generation and application
        let ffmpegCommand = ffmpeg(processedVideoPath)
          .setStartTime(options.start)
          .duration(options.duration)
          .inputOption('-v', 'verbose'); // Add verbose debug output
          
        // Apply hardware acceleration if available
        if (hwAccel.available) {
          console.log(`Using ${hwAccel.type} hardware acceleration`);
          hwAccel.options.forEach(option => {
            ffmpegCommand.inputOption(option);
          });
        }
        
        // Add threading options
        if (options.threads > 0) {
          ffmpegCommand.outputOptions([
            `-threads ${options.threads}`
          ]);
          if (options.verbose) {
            console.log(`Using ${options.threads} FFmpeg threads for GIF creation`);
          }
        } else if (options.threads === 0) {
          // Auto-threading mode - use CPU core count
          const cpuCount = os.cpus().length;
          ffmpegCommand.outputOptions([
            `-threads ${cpuCount}`
          ]);
          if (options.verbose) {
            console.log(`Using auto-threading with ${cpuCount} CPU cores for GIF creation`);
          }
        }
          
        // Use a single complex filtergraph that generates a palette and applies it in one step
        // This eliminates the need for temporary palette files and multiple passes
        ffmpegCommand
          .complexFilter([
            // Set FPS and scale the video
            `fps=${options.fps},scale=${options.width}:-1:flags=lanczos,split[s0][s1]`,
            // Generate the palette from the scaled video
            `[s0]palettegen=stats_mode=diff:max_colors=${options.colors}[palette]`,
            // Apply the palette to the scaled video
            `[s1][palette]paletteuse=dither=${options.dither === 'bayer' ? 'bayer:bayer_scale=5' : options.dither}:diff_mode=rectangle`
          ])
          .outputOption('-loop', options.loops)
          .format('gif')
          .output(outputPath);
        
        ffmpegCommand.on('start', (commandLine) => {
          if (options.verbose) {
            console.log('FFmpeg command:', commandLine);
          }
        })
          .on('progress', (progress) => {
            if (options.verbose && progress.percent) {
              console.log(`Processing: ${Math.floor(progress.percent)}% done`);
            }
          })
          .on('end', async () => {
            // Log memory usage after processing
            logMemoryUsage();
            
            // Clean up the processed video file if it was temporary
            if (processedVideoPath !== videoPath) {
              cleanupTempFile(processedVideoPath);
            }
            
            // Apply post-processing with gifsicle for better compression
            try {
              await postProcessGif(outputPath, options);
            } catch (err) {
              console.error('Error during post-processing:', err.message);
            }
            
            // Log final memory usage
            if (options.verbose) {
              console.log('Final memory usage after GIF creation:');
              logMemoryUsage();
            }
            
            console.log(`Success! GIF saved to: ${path.resolve(outputPath)}`);
            resolve();
          })
          .on('error', (err) => {
            console.error('ERROR DETAILS:');
            console.error(err);
            console.error('Error during conversion:', err.message);
            
            // Try an alternative method with a two-pass approach
            console.log('Trying alternative two-pass method...');
            
            // First create palette
            let alternateFfmpeg = ffmpeg(processedVideoPath)
              .setStartTime(options.start);
              
            // For alternate approach, use a simpler palette generation
            alternateFfmpeg
              .duration(parseFloat(options.duration))
              .videoFilter(`fps=${options.fps},scale=${options.width}:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=${options.colors}`)
              .output(palettePath);
              
            alternateFfmpeg.on('start', (commandLine) => {
              if (options.verbose) {
                console.log('Palette command:', commandLine);
              }
            })
              .on('error', (paletteErr) => {
                console.error('Error generating palette:', paletteErr.message);
                
                // Final fallback - simpler method
                console.log('Using basic conversion as final fallback...');
                
                // Log memory usage before fallback
                logMemoryUsage();
                
                let fallbackFfmpeg = ffmpeg(processedVideoPath)
                  .setStartTime(options.start);
                
                // Add threading options to fallback method
                const threadOptions = [];
                if (options.threads > 0) {
                  threadOptions.push(`-threads ${options.threads}`);
                  if (options.verbose) {
                    console.log(`Using ${options.threads} FFmpeg threads for fallback conversion`);
                  }
                } else if (options.threads === 0) {
                  // Auto-threading mode - use CPU core count
                  const cpuCount = os.cpus().length;
                  threadOptions.push(`-threads ${cpuCount}`);
                  if (options.verbose) {
                    console.log(`Using auto-threading with ${cpuCount} CPU cores for fallback conversion`);
                  }
                }
                
                // Standard approach
                  fallbackFfmpeg
                    .duration(options.duration)
                    .outputOptions([
                      '-vf', `fps=${options.fps},scale=${options.width}:-1:flags=lanczos`,
                      '-loop', options.loops,
                      ...threadOptions
                    ])
                    .format('gif')
                    .output(outputPath);
                
                fallbackFfmpeg.on('start', (commandLine) => {
                  if (options.verbose) {
                    console.log('Fallback command:', commandLine);
                  }
                })
                  .on('end', async () => {
                    // Apply post-processing with gifsicle for better compression
                    try {
                      await postProcessGif(outputPath, options);
                    } catch (err) {
                      console.error('Error during post-processing:', err.message);
                    }
                    console.log(`Success with fallback method! GIF saved to: ${path.resolve(outputPath)}`);
                    resolve();
                  })
                  .on('error', (fallbackErr) => {
                    console.error('All conversion methods failed:', fallbackErr.message);
                    reject(fallbackErr);
                  })
                  .run();
              })
              .on('end', () => {
                // Second pass - use palette to create high-quality GIF
                let secondPassFfmpeg = ffmpeg(processedVideoPath)
                  .setStartTime(options.start);
                  
                // Standard two-pass approach
                  secondPassFfmpeg
                    .duration(options.duration)
                    .videoFilter([
                      `fps=${options.fps}`,
                      `scale=${options.width}:-1:flags=lanczos`,
                      `paletteuse=dither=${options.dither}:diff_mode=rectangle`
                    ])
                    .inputOptions([
                      '-i', palettePath
                    ])
                    .outputOption('-loop', options.loops)
                    .format('gif')
                    .output(outputPath);
                
                secondPassFfmpeg.on('start', (commandLine) => {
                  if (options.verbose) {
                    console.log('Second pass command:', commandLine);
                  }
                })
                  .on('end', async () => {
                    // Apply post-processing with gifsicle for better compression
                    try {
                      await postProcessGif(outputPath, options);
                    } catch (err) {
                      console.error('Error during post-processing:', err.message);
                    }
                    console.log(`Success with two-pass method! GIF saved to: ${path.resolve(outputPath)}`);
                    resolve();
                  })
                  .on('error', (secondPassErr) => {
                    console.error('Error in second pass:', secondPassErr.message);
                    
                    // Fall back to the basic method
                    console.log('Using basic conversion as fallback...');
                    
                    // Try a direct command approach as a last resort
                    console.log('Using direct FFmpeg command as final fallback...');
                    try {
                      // Use child_process.exec to run a direct ffmpeg command
                      const { execSync } = require('child_process');
                      const directCmd = `ffmpeg -y -ss ${options.start} -t ${options.duration} -i "${processedVideoPath}" -vf "fps=${options.fps},scale=${options.width}:-1:flags=lanczos" -loop ${options.loops} "${outputPath}"`;
                      console.log('Executing: ' + directCmd);
                      execSync(directCmd, { stdio: 'inherit' });
                      console.log('Direct FFmpeg command succeeded!');

                      // Try to run postProcessGif
                      (async () => {
                        try {
                          await postProcessGif(outputPath, options);
                        } catch (err) {
                          console.error('Error in post-processing:', err);
                        }
                        console.log(`Success with direct command! GIF saved to: ${path.resolve(outputPath)}`);
                        resolve();
                      })();
                      return;
                    } catch (directErr) {
                      console.error('Direct FFmpeg command failed:', directErr);
                      
                      // Try a more basic approach with one final attempt
                      console.log('Trying a different approach with palette...');
                      
                      try {
                        const { execSync } = require('child_process');
                        
                        // Use single-pass approach with split filter to generate palette and use it
                        // Put the seek before input for faster seeking
                        const singlePassCmd = `ffmpeg -y -ss ${options.start} -t ${options.duration} -i "${processedVideoPath}" -vf "fps=${options.fps},scale=${options.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop ${options.loops} "${outputPath}"`;
                        console.log('Creating GIF with single-pass approach: ' + singlePassCmd);
                        execSync(singlePassCmd, { stdio: 'inherit' });
                        console.log('Palette method succeeded!');
                        
                        // Apply post-processing
                        (async () => {
                          try {
                            await postProcessGif(outputPath, options);
                          } catch (err) {
                            console.error('Error in post-processing:', err);
                          }
                          console.log(`Success with palette method! GIF saved to: ${path.resolve(outputPath)}`);
                          resolve();
                        })();
                        return;
                      } catch (paletteErr) {
                        console.error('Palette method failed:', paletteErr);
                        console.warn('All conversion methods failed. Unable to create GIF.');
                        reject(new Error('All conversion methods failed'));
                      }
                    }
                  })
                  .run();
              })
              .run();
          })
          .run();
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    if (options.verbose) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    // Clean up any tracked temp files that weren't already cleaned up
    if (tempFiles.length > 0) {
      tempFiles.forEach(filePath => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if (options.verbose) {
              console.log(`Final cleanup of temp file: ${filePath}`);
            }
          }
        } catch (err) {
          console.warn(`Warning: Could not clean up temp file: ${filePath}`);
        }
      });
    }
    
    // Clean up temp directory and files if we created them
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        // Get all files in the temp directory
        const files = fs.readdirSync(tempDir);
        
        // Delete each file that might have been missed
        files.forEach(file => {
          const filePath = path.join(tempDir, file);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        });
        
        // Remove the directory
        fs.rmdirSync(tempDir);
        
        if (options.verbose) {
          console.log('Cleaned up temporary files');
        }
      } catch (err) {
        console.error('Warning: Could not clean up temp files', err.message);
      }
    }
  }
}

run();