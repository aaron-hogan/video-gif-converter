#!/usr/bin/env node

const { program } = require('commander');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const gifsicle = require('gifsicle');

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
  .version('1.0.0')
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
  .parse(process.argv);

const options = program.opts();

// Convert numeric options to appropriate types
options.crossfade = parseFloat(options.crossfade);
options.speed = parseFloat(options.speed);
options.colors = parseInt(options.colors);
options.lossy = parseInt(options.lossy);

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

// Function to check if crossfade is enabled
function isCrossfadeEnabled() {
  return options.crossfade > 0;
}

// Function to check if hardware acceleration is available
async function detectHardwareAcceleration() {
  return new Promise((resolve) => {
    // Default hardware acceleration options
    const hwAccel = {
      available: false,
      type: null,
      filters: [],
      options: []
    };
    
    try {
      // Check for platform-specific hardware acceleration
      const platform = os.platform();
      if (platform === 'darwin') {
        // macOS - check for videotoolbox
        require('child_process').exec('ffmpeg -hwaccels', (error, stdout) => {
          if (!error && stdout.includes('videotoolbox')) {
            hwAccel.available = true;
            hwAccel.type = 'videotoolbox';
            hwAccel.options = ['-hwaccel', 'videotoolbox'];
            if (options.verbose) {
              console.log('Detected macOS VideoToolbox hardware acceleration');
            }
          }
          resolve(hwAccel);
        });
      } else if (platform === 'win32') {
        // Windows - check for multiple options
        require('child_process').exec('ffmpeg -hwaccels', (error, stdout) => {
          if (!error) {
            if (stdout.includes('dxva2')) {
              hwAccel.available = true;
              hwAccel.type = 'dxva2';
              hwAccel.options = ['-hwaccel', 'dxva2'];
              if (options.verbose) {
                console.log('Detected Windows DXVA2 hardware acceleration');
              }
            } else if (stdout.includes('cuda') || stdout.includes('nvenc')) {
              hwAccel.available = true;
              hwAccel.type = 'cuda';
              hwAccel.options = ['-hwaccel', 'cuda'];
              if (options.verbose) {
                console.log('Detected NVIDIA CUDA hardware acceleration');
              }
            } else if (stdout.includes('qsv')) {
              hwAccel.available = true;
              hwAccel.type = 'qsv';
              hwAccel.options = ['-hwaccel', 'qsv'];
              if (options.verbose) {
                console.log('Detected Intel QuickSync hardware acceleration');
              }
            } else if (stdout.includes('d3d11va')) {
              hwAccel.available = true;
              hwAccel.type = 'd3d11va';
              hwAccel.options = ['-hwaccel', 'd3d11va'];
              if (options.verbose) {
                console.log('Detected D3D11VA hardware acceleration');
              }
            }
          }
          resolve(hwAccel);
        });
      } else if (platform === 'linux') {
        // Linux - check for multiple options
        require('child_process').exec('ffmpeg -hwaccels', (error, stdout) => {
          if (!error) {
            if (stdout.includes('vaapi')) {
              hwAccel.available = true;
              hwAccel.type = 'vaapi';
              hwAccel.options = ['-hwaccel', 'vaapi', '-vaapi_device', '/dev/dri/renderD128'];
              if (options.verbose) {
                console.log('Detected Linux VAAPI hardware acceleration');
              }
            } else if (stdout.includes('cuda') || stdout.includes('nvenc')) {
              hwAccel.available = true;
              hwAccel.type = 'cuda';
              hwAccel.options = ['-hwaccel', 'cuda'];
              if (options.verbose) {
                console.log('Detected NVIDIA CUDA hardware acceleration');
              }
            }
          }
          resolve(hwAccel);
        });
      } else {
        // Unknown platform or no acceleration
        resolve(hwAccel);
      }
    } catch (err) {
      // If detection fails, just proceed without hardware acceleration
      if (options.verbose) {
        console.warn('Hardware acceleration detection failed:', err.message);
      }
      resolve(hwAccel);
    }
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
 * Function to create a crossfade effect for perfectly looping GIFs.
 * 
 * This implementation follows these principles:
 * 1. The base clip starts at (start_time + crossfade_duration) and plays for (total_duration - crossfade_duration)
 * 2. The crossfade clip contains the first (crossfade_duration) seconds of video from start_time
 * 3. When the base clip ends, it transitions smoothly into the crossfade clip
 * 4. This creates a seamless loop where the end blends perfectly into the beginning
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
    
    // Generate palette for better quality
    const palettePath = path.join(tempDir, 'palette.png');
    
    // Create a temporary video with crossfade
    const tempVideoPath = path.join(tempDir, 'crossfade_video.mp4');
    
    // Track this temp file for cleanup if needed
    if (typeof trackTempFile === 'function') {
      trackTempFile(tempVideoPath);
    }
    
    // Parse durations and calculate timing
    const totalDuration = parseFloat(options.duration);
    const crossfadeDuration = options.crossfade;
    const startTime = parseFloat(options.start);
    const mainDuration = totalDuration - crossfadeDuration;
    
    // Offset where the base clip starts - after the crossfade duration
    const baseOffset = crossfadeDuration;
    
    return new Promise((resolve, reject) => {
      // Create a complex filter to generate a perfect crossfade
      let complexFilter = [
        // Main section (starts after crossfade duration)
        `[0:v]trim=start=${startTime + baseOffset}:duration=${mainDuration},setpts=PTS-STARTPTS[main]`,
        
        // End segment with fade out
        `[0:v]trim=start=${startTime + mainDuration + baseOffset}:duration=${crossfadeDuration},setpts=PTS-STARTPTS,format=yuva420p,fade=t=out:st=0:d=${crossfadeDuration}:alpha=1[fout]`,
        
        // Beginning segment with fade in (from the original start time)
        `[0:v]trim=start=${startTime}:duration=${crossfadeDuration},setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=0:d=${crossfadeDuration}:alpha=1[fin]`,
        
        // Overlay the fading segments to create transition
        `[fin][fout]overlay[crossfade]`,
        
        // Join the main part with the crossfade section
        `[main][crossfade]concat=n=2:v=1:a=0`
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
      
      ffmpeg(videoPath)
        .complexFilter(complexFilter)
        .output(tempVideoPath)
        .outputOptions(['-map', '0:a?']) // Include audio if present
        .on('start', (commandLine) => {
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
    
    // Apply speed effect using setpts filter
    // Note: setpts=1/speed*PTS makes the video faster when speed > 1.0 and slower when speed < 1.0
    ffmpeg(inputPath)
      .videoFilter(`setpts=1/${speed}*PTS`)
      .audioFilter(`atempo=${speed}`) // Adjust audio speed too if present
      .output(speedAdjustedPath)
      .on('start', (commandLine) => {
        if (options.verbose) {
          console.log('Speed preprocessing command:', commandLine);
        }
      })
      .on('end', () => {
        console.log('Speed preprocessing complete');
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
      
      if (!ytdl.validateURL(options.url)) {
        console.error('Error: Invalid YouTube URL');
        process.exit(1);
      }
      
      console.log('Fetching video information...');
      
      // Try to get video info with different options if needed
      let videoInfo;
      try {
        videoInfo = await ytdl.getInfo(options.url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } });
      } catch (error) {
        if (options.verbose) {
          console.error('Error details:', error);
        }
        console.error('Failed to fetch video information. YouTube may have changed their API or the video might be restricted.');
        process.exit(1);
      }
      
      console.log(`Processing: ${videoInfo.videoDetails.title}`);
      
      // Get available formats
      const formats = videoInfo.formats.filter(format => format.hasVideo && !format.hasAudio);
      
      if (formats.length === 0) {
        console.log('No video-only formats found, using format with both video and audio...');
      }
      
      // Select the best format
      const format = formats.length > 0 
        ? formats.sort((a, b) => b.width - a.width)[0] 
        : videoInfo.formats.filter(f => f.hasVideo).sort((a, b) => b.width - a.width)[0];
      
      if (!format) {
        console.error('Error: No suitable video format found');
        process.exit(1);
      }
      
      console.log('Downloading video...');
      
      if (options.verbose) {
        console.log(`Using format: ${format.qualityLabel || 'unknown'} (${format.width}x${format.height})`);
      }
      
      const videoStream = ytdl.downloadFromInfo(videoInfo, { format });
      const writeStream = fs.createWriteStream(videoPath);
      
      videoStream.pipe(writeStream);
      
      // Handle potential download errors
      videoStream.on('error', (err) => {
        console.error('Error downloading video:', err.message);
        process.exit(1);
      });
      
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', (err) => {
          console.error('Error writing video file:', err.message);
          reject(err);
        });
      });
      
      // Verify the file was downloaded
      if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
        console.error('Error: Downloaded video file is empty or does not exist');
        process.exit(1);
      }
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
        
        // Generate a palette for better quality
        const palettePath = path.join(tempDir, 'palette.png');
        
        // Optimized single-pass approach using complex filtergraph for palette generation and application
        let ffmpegCommand = ffmpeg(processedVideoPath)
          .setStartTime(options.start)
          .duration(options.duration);
          
        // Apply hardware acceleration if available
        if (hwAccel.available) {
          console.log(`Using ${hwAccel.type} hardware acceleration`);
          hwAccel.options.forEach(option => {
            ffmpegCommand.inputOption(option);
          });
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
            console.log(`Success! GIF saved to: ${path.resolve(outputPath)}`);
            resolve();
          })
          .on('error', (err) => {
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
                
                let fallbackFfmpeg = ffmpeg(processedVideoPath)
                  .setStartTime(options.start);
                
                // Standard approach
                  fallbackFfmpeg
                    .duration(options.duration)
                    .outputOptions([
                      '-vf', `fps=${options.fps},scale=${options.width}:-1:flags=lanczos`,
                      '-loop', options.loops
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
                    
                    let fallbackFfmpeg = ffmpeg(processedVideoPath)
                      .setStartTime(options.start);
                    
                    // Original fallback approach
                    fallbackFfmpeg
                      .duration(options.duration)
                      .outputOptions([
                        '-vf', `fps=${options.fps},scale=${options.width}:-1:flags=lanczos`,
                        '-loop', options.loops
                      ])
                      .format('gif')
                      .output(outputPath);
                    
                    fallbackFfmpeg.on('end', async () => {
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