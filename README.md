# Video GIF Converter

A command-line tool to convert YouTube videos or local video files to looping GIFs.

[![GitHub repo](https://img.shields.io/badge/GitHub-Repository-blue?logo=github)](https://github.com/aaron-hogan/video-gif-converter)

## Prerequisites

- Node.js (12.x or higher)
- FFmpeg installed on your system

### FFmpeg Installation

For macOS:
```bash
brew install ffmpeg
```

For Ubuntu/Debian:
```bash
sudo apt update
sudo apt install ffmpeg
```

For Windows:
1. Download FFmpeg from the [official website](https://ffmpeg.org/download.html)
2. Extract the archive to a location on your computer (e.g., `C:\ffmpeg`)
3. Add the `bin` directory to your system PATH

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/video-gif-converter.git
cd video-gif-converter

# Install dependencies
npm install

# Make executable globally
npm link
```

## Usage

### From YouTube

```bash
vgif --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 
```

### From Local File

```bash
vgif --input "path/to/video.mp4"
```

### Options

- `-u, --url <url>` - YouTube video URL
- `-i, --input <filepath>` - Local video file path
- `-s, --start <seconds>` - Start time in seconds (default: 0)
- `-d, --duration <seconds>` - Duration in seconds (default: 5)
- `-o, --output <filename>` - Output filename (default: output.gif)
- `-w, --width <pixels>` - Width of the GIF in pixels (default: 480)
- `-f, --fps <fps>` - Frames per second (default: 15)
- `-l, --loops <count>` - Number of loops (0 = infinite) (default: 0)
- `-v, --verbose` - Enable verbose logging and show progress information
- `-m, --max-size <mb>` - Maximum output file size in MB (default: 50)
- `-c, --crossfade <seconds>` - Apply crossfade effect for seamless looping (default: 0)
- `-p, --speed <factor>` - Playback speed (0.5 = half speed, 2.0 = double speed) (default: 1.0)

Note: You must provide either a YouTube URL (-u) OR a local file path (-i), not both.

### Examples

```bash
# YouTube Examples
# ---------------

# Create a 10-second GIF starting from 30 seconds into the video
vgif -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -s 30 -d 10

# Create a high-quality GIF with custom dimensions and fps
vgif -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -w 720 -f 30 -o my-gif.gif

# Create a GIF that loops 3 times
vgif -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -l 3

# Local File Examples
# ------------------

# Create a GIF from a local video file
vgif -i "path/to/video.mp4" -o output.gif

# Create a GIF from a specific segment of a local video
vgif -i "path/to/movie.mp4" -s 120 -d 5 -w 480 -f 20 -o movie-scene.gif 

# Create a smaller file size GIF with lower FPS
vgif -i "path/to/video.mp4" -f 10 -w 320

# Enable verbose mode to see conversion progress
vgif -i "path/to/video.mp4" -v

# Create a GIF with seamless looping using crossfade effect
vgif -i "path/to/video.mp4" -d 10 -c 1.5

# Create a slow-motion GIF (half speed)
vgif -i "path/to/video.mp4" -p 0.5

# Create a time-lapse style GIF (double speed)
vgif -i "path/to/video.mp4" -p 2.0

# Combine speed control with crossfade for creative effects
vgif -i "path/to/video.mp4" -d 8 -p 0.75 -c 1.0
```

### Tips

1. **Video Selection**: Choose videos with clear motion and good contrast for best results
2. **Duration**: Shorter GIFs (2-8 seconds) tend to be more shareable and load faster
3. **File Size**: Reducing width (`-w`) and frame rate (`-f`) will create smaller files
4. **Loop Count**: Use `-l 0` for infinite loops or specify a number for limited loops
5. **Crossfade Effect**: For seamless looping, try a crossfade duration of 0.5-2 seconds (must be less than total duration)
6. **Speed Control**: Use `-p 0.5` for slow motion or `-p 2.0` for time-lapse effects

## License

ISC