#!/usr/bin/env node

const { program } = require('commander');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

program
  .name('video-gif-converter')
  .description('CLI to convert YouTube videos or local video files to looping GIFs')
  .version('1.0.0')
  .option('-u, --url <url>', 'YouTube video URL')
  .option('-i, --input <filepath>', 'Local video file path')
  .option('-s, --start <seconds>', 'Start time in seconds', '0')
  .option('-d, --duration <seconds>', 'Duration in seconds', '5')
  .option('-o, --output <filename>', 'Output filename', 'output.gif')
  .option('-w, --width <pixels>', 'Width of the GIF in pixels', '480')
  .option('-f, --fps <fps>', 'Frames per second', '15')
  .option('-l, --loops <count>', 'Number of loops (0 = infinite)', '0')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-m, --max-size <mb>', 'Maximum output file size in MB (constrains quality automatically)', '50')
  .parse(process.argv);

const options = program.opts();

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

async function run() {
  let tempDir = null;
  let videoPath = null;
  let usingTempVideo = false;
  
  try {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-gif-'));
    const outputPath = options.output.endsWith('.gif') ? options.output : `${options.output}.gif`;
    
    // Handle YouTube video
    if (options.url) {
      videoPath = path.join(tempDir, 'video.mp4');
      usingTempVideo = true;
      
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
    
    // Check if file already exists and is writable
    if (fs.existsSync(outputPath)) {
      try {
        fs.accessSync(outputPath, fs.constants.W_OK);
        // Try to delete the existing file
        fs.unlinkSync(outputPath);
        console.log(`Removed existing file: ${outputPath}`);
      } catch (err) {
        console.error(`Error: Cannot overwrite existing file: ${outputPath}`);
        process.exit(1);
      }
    }
    
    await new Promise((resolve, reject) => {
      // Let's use a simpler approach first to see if it works
      console.log('Converting video to GIF (this may take a while)...');
      
      // Generate a palette for better quality
      const palettePath = path.join(tempDir, 'palette.png');
      
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
      
      console.log('Generating palette for high-quality GIF...');
      console.log(`Settings: ${options.duration}s duration, ${options.width}px width, ${options.fps} FPS`);
      
      // First pass - generate palette with tweaked settings for better performance
      let ffmpegCommand = ffmpeg(videoPath)
        .setStartTime(options.start)
        .duration(options.duration)
        .videoFilters([
          `fps=${options.fps}`,
          `scale=${options.width}:-1:flags=lanczos`,
          'split[s0][s1]',
          '[s0]palettegen=stats_mode=diff[p]',
          '[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle'
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
        .on('end', () => {
          console.log(`Success! GIF saved to: ${path.resolve(outputPath)}`);
          resolve();
        })
        .on('error', (err) => {
          console.error('Error during conversion:', err.message);
          
          // Try an alternative method with a two-pass approach
          console.log('Trying alternative two-pass method...');
          
          // First create palette
          let alternateFfmpeg = ffmpeg(videoPath)
            .setStartTime(options.start);
            
          alternateFfmpeg
            .duration(options.duration)
            .videoFilter(`fps=${options.fps},scale=${options.width}:-1:flags=lanczos,palettegen`)
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
              
              ffmpeg(videoPath)
                .setStartTime(options.start)
                .duration(options.duration)
                .outputOptions([
                  '-vf', `fps=${options.fps},scale=${options.width}:-1:flags=lanczos`,
                  '-loop', options.loops
                ])
                .format('gif')
                .output(outputPath)
                .on('start', (commandLine) => {
                  if (options.verbose) {
                    console.log('Fallback command:', commandLine);
                  }
                })
                .on('end', () => {
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
              let secondPassFfmpeg = ffmpeg(videoPath)
                .setStartTime(options.start);
                
              {
                // Standard two-pass approach without crossfade
                secondPassFfmpeg
                  .duration(options.duration)
                  .videoFilter([
                    `fps=${options.fps}`,
                    `scale=${options.width}:-1:flags=lanczos`,
                    `paletteuse=dither=sierra2_4a`
                  ])
                  .inputOptions([
                    '-i', palettePath
                  ])
                  .outputOption('-loop', options.loops)
                  .format('gif')
                  .output(outputPath);
              }
              
              secondPassFfmpeg.on('start', (commandLine) => {
                if (options.verbose) {
                  console.log('Second pass command:', commandLine);
                }
              })
                .on('end', () => {
                  console.log(`Success with two-pass method! GIF saved to: ${path.resolve(outputPath)}`);
                  resolve();
                })
                .on('error', (secondPassErr) => {
                  console.error('Error in second pass:', secondPassErr.message);
                  
                  // Fall back to the basic method
                  console.log('Using basic conversion as fallback...');
                  
                  let fallbackFfmpeg = ffmpeg(videoPath)
                    .setStartTime(options.start);
                  
                  {
                    // Original fallback without crossfade
                    fallbackFfmpeg
                      .duration(options.duration)
                      .outputOptions([
                        '-vf', `fps=${options.fps},scale=${options.width}:-1:flags=lanczos`,
                        '-loop', options.loops
                      ])
                      .format('gif')
                      .output(outputPath);
                  }
                  
                  fallbackFfmpeg.on('end', () => {
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
    
  } catch (error) {
    console.error('Error:', error.message);
    if (options.verbose) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    // Clean up temp directory and files if we created them
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        // Get all files in the temp directory
        const files = fs.readdirSync(tempDir);
        
        // Delete each file
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