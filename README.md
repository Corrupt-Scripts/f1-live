# Corrupt Scripts F1 Live

Live F1 dashboard: timing tower, track map, projected championship with overtakes, per-driver telemetry, and race control with team radio and weather. Works with a keyboard, a mouse, or touch.

## Two data sources, both free

| When | Source | What you get |
|---|---|---|
| During a session | F1's own live timing feed, through the **live helper** on your PC | Running order, gaps, intervals, last/best laps, sectors (purple/green), tyres and tyre age, pit stops, speed traps, race control messages, track status (flags, SC/VSC), lap count, session clock, weather, team radio, overtakes and a projected championship. Car telemetry and the live track map appear only if F1 still sends them for free. |
| About 30 minutes after a session | OpenF1 free tier (built into the page) | A full replay with a time slider, including the track map, telemetry, overtakes and championship. |

## Running the live helper (Windows)

1. Install Node.js LTS from https://nodejs.org (one time).
2. Open the `live-helper` folder and double-click `start.bat`.
   It installs what it needs the first time, connects to F1, and opens http://localhost:5050.
3. Leave the window open while you watch. During a session the page switches to the **LIVE** tab automatically.

To run it without the batch file: `cd live-helper`, `npm install`, then `node f1-live.js`.

The Netlify version of the page also picks up the helper if it's running on the same PC. Chrome may ask for permission to access devices on your local network; allow it. If it can't connect, open http://localhost:5050 directly instead.

To view it on your phone or TV on the same Wi-Fi, start the helper with `set HOST=0.0.0.0` first, then open `http://<your-PC-IP>:5050`.

## Controls

`←` `→` or `1`–`5` change view · `[` `]` change session · `L` jump to live · `↑` `↓` change driver · type a code like `VER` to pick a driver · `Space` play/pause a replay · `Esc` back to timing. Click any driver row or car dot.

## Notes

- The live feed is F1's unofficial live timing feed. F1 can change or restrict it at any time. Since the 2025 Dutch GP some parts need F1 TV, and the page falls back gracefully when they're missing.
- The live projected championship uses the standings from Jolpica plus points for the current running order. Fastest-lap points are not included.
- Overtakes in live mode are worked out from position changes, and passes caused by pit stops are labelled.
- OpenF1's free tier allows 30 requests a minute, so replays refresh at a gentle pace.
