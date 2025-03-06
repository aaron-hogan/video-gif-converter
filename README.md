# Video GIF Converter

A command-line tool to convert YouTube videos or local video files to looping GIFs.

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
video-gif-converter --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 
```

### From Local File

```bash
video-gif-converter --input "path/to/video.mp4"
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

Note: You must provide either a YouTube URL (-u) OR a local file path (-i), not both.

### Examples

```bash
# YouTube Examples
# ---------------

# Create a 10-second GIF starting from 30 seconds into the video
video-gif-converter -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -s 30 -d 10

# Create a high-quality GIF with custom dimensions and fps
video-gif-converter -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -w 720 -f 30 -o my-gif.gif

# Create a GIF that loops 3 times
video-gif-converter -u "https://www.youtube.com/watch?v=dQw4w9WgXcQ" -l 3

# Local File Examples
# ------------------

# Create a GIF from a local video file
video-gif-converter -i "path/to/video.mp4" -o output.gif

# Create a GIF from a specific segment of a local video
video-gif-converter -i "path/to/movie.mp4" -s 120 -d 5 -w 480 -f 20 -o movie-scene.gif 

# Create a smaller file size GIF with lower FPS
video-gif-converter -i "path/to/video.mp4" -f 10 -w 320

# Enable verbose mode to see conversion progress
video-gif-converter -i "path/to/video.mp4" -v
```

### Tips

1. **Video Selection**: Choose videos with clear motion and good contrast for best results
2. **Duration**: Shorter GIFs (2-8 seconds) tend to be more shareable and load faster
3. **File Size**: Reducing width (`-w`) and frame rate (`-f`) will create smaller files
4. **Loop Count**: Use `-l 0` for infinite loops or specify a number for limited loops

## License

ISC