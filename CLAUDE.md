# Video GIF Converter (vgif) Development Guide

## Commands
- Run main CLI: `node video-gif-converter.js`
- Create GIF from URL: `node video-gif-converter.js -u "URL" -o output.gif`
- Create GIF from file: `node video-gif-converter.js -i "file.mp4" -o output.gif`

## Code Style
- Use CommonJS modules with `require()`
- Prefer `const` over `let`, avoid `var`
- Use async/await with try/catch for error handling
- Verbose error messages with fallback options
- Use camelCase for variables and functions
- Document CLI options with clear descriptions
- Ensure error handling for all file operations
- Handle edge cases like invalid URLs and files

## Architecture
- CLI entry point: video-gif-converter.js
- Key dependencies: fluent-ffmpeg, @distube/ytdl-core, commander
- Input sources: YouTube URLs or local video files
- Output: Optimized looping GIFs