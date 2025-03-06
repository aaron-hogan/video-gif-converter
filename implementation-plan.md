# Crossfade Implementation Plan

## Logic
- Base clip: Starts at (start_time + crossfade_duration), plays for (total_duration)
- Crossfade clip: Contains the first (crossfade_duration) of video starting at start_time
- Alignment: Crossfade clip starts at (total_duration - crossfade_duration)

## Todo List
- [x] Add crossfade option back to CLI arguments
- [x] ~Create function to generate temporary base clip~ (Simplified approach uses a single filter)
- [x] ~Create function to generate temporary crossfade clip~ (Simplified approach uses a single filter)
- [x] Implement positioning and alignment logic (Using FFmpeg complex filter)
- [x] Apply fade effect for smooth transition (Using overlay with eof_action=repeat)
- [x] Combine clips into final GIF (Using palette-based high-quality approach)
- [x] Add cleanup of temporary files (Already handled by existing code)
- [x] Update documentation with crossfade usage
- [x] Test with different duration and crossfade values
- [x] Test with various input sources (file, URL)