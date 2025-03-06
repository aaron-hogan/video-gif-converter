#!/usr/bin/env node

// A utility script to download a specific segment of a YouTube video correctly

const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const { execSync } = require('child_process');

// Download the entire video and then extract the segment with FFmpeg
async function downloadVideoSegment(url, startSeconds, durationSeconds, outputPath) {
  try {
    console.log(`Downloading and extracting segment from ${url} at position ${startSeconds}s for ${durationSeconds}s`);
    
    // Create a temporary file
    const tempFile = `temp-${Date.now()}.mp4`;
    
    // Get video info
    console.log("Getting video info...");
    const info = await ytdl.getInfo(url);
    console.log(`Title: ${info.videoDetails.title}`);
    
    // Get format
    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    console.log(`Selected format: ${format.qualityLabel} (${format.width}x${format.height})`);
    
    // Download full video to temp file
    console.log("Downloading video...");
    await new Promise((resolve, reject) => {
      ytdl(url, { format: format })
        .pipe(fs.createWriteStream(tempFile))
        .on('finish', () => {
          console.log('Full video download complete!');
          resolve();
        })
        .on('error', (err) => {
          console.error('Error downloading:', err);
          reject(err);
        });
    });
    
    // Use FFmpeg to extract the segment
    console.log(`Extracting segment from ${startSeconds}s to ${startSeconds + durationSeconds}s...`);
    execSync(`ffmpeg -y -i "${tempFile}" -ss ${startSeconds} -t ${durationSeconds} -c:v copy -c:a copy "${outputPath}"`, 
      { stdio: 'inherit' });
    
    // Clean up temp file
    console.log("Cleaning up temporary file...");
    fs.unlinkSync(tempFile);
    
    console.log(`Segment saved to ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.error('Error processing segment:', err);
    throw err;
  }
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node download-segment.js <youtube-url> <start-seconds> <duration-seconds> <output-path>');
  process.exit(1);
}

const url = args[0];
const startSeconds = parseFloat(args[1]);
const durationSeconds = parseFloat(args[2]);
const outputPath = args[3];

downloadVideoSegment(url, startSeconds, durationSeconds, outputPath)
  .then(() => console.log('Done!'))
  .catch(err => {
    console.error('Failed to download segment:', err);
    process.exit(1);
  });