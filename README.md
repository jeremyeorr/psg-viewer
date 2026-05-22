# PSG Viewer

A lightweight, local-only browser viewer for polysomnography review. The app loads EDF/EDF+ signal files and external scoring files from the user's machine, displays stacked PSG waveforms on a canvas, and overlays sleep stages and scored events without uploading data anywhere.

## Current Features

- Local browser file loading for EDF/EDF+ signals.
- Scoring import for RML, XML, XLS, XLSX, CSV, TSV, and TXT tabular files.
- Absolute clock-time alignment between EDF start time and scoring timestamps.
- Standard PSG display order with four EEG channels and two EOG channels when available.
- Channel sidebar with visibility toggles, autoscaling, and manual range/center controls.
- Draggable vertical reordering from the displayed channel labels in the waveform view.
- Event sidebar with visibility toggles by event label/category.
- Separate overlay lanes for sleep stage, body position, respiratory events, and other events.
- Hover labels for events and a vertical time cursor over the main display.
- Zoom windows for 30s, 1m, 2m, 5m, 10m, and full-night view.
- Scroll, drag, wheel/trackpad, timeline, and keyboard navigation.
- Windowed EDF decoding through `File.slice` so the full signal file is not eagerly decoded into memory.
- UI preferences, including channel order, stored in browser local storage only.

## Run Locally

This app is currently dependency-free and can be served as static files.

```sh
npm run dev
```

Then open:

```text
http://127.0.0.1:5173/
```

Do not open `index.html` directly as a `file://` URL. The app uses browser ES modules and a Web Worker, which need a local HTTP server.

You can also run the equivalent command directly:

```sh
python3 -m http.server 5173
```

## Load A Study

1. Choose an EDF or EDF+ file with the `EDF / EDF+` picker.
2. Choose an external scoring file with the `Scoring` picker.
3. Use `Channels` to show, hide, and scale signal lanes.
4. Drag displayed channel labels in the waveform view to vertically reorder visible channels.
5. Use `Events` to show or hide scored event categories.
6. Use the zoom buttons and timeline to review the recording.

Files stay in the browser process. The app does not upload or persist study data.

## Compatible Exports

Validated:

- Nox / Noxturnal: EDF signal export with XLS scoring export.
- Philips Respironics Sleepware G3: EDF signal export with RML scoring export. The RML importer reads Sleepware stages, respiratory events, arousals, comments, SpO2 desaturation events, limb events, and body-position overrides. The `*-AT.xml` file seen in one sample appears to be an audit log, not a scoring file.

## Timing Model

EDF recording start time is read from the EDF header. Scoring timestamps are treated as absolute clock times when the scoring file provides absolute values, such as Excel serial dates/times. The viewer plots scoring relative to the EDF recording start only internally so that signal samples and scoring annotations share the same absolute time axis.

## Tests

```sh
npm test
```

The current tests cover:

- EDF header parsing.
- Digital-to-physical scaling.
- Mixed sample rates.
- Visible-window EDF slicing.
- Min/max downsampling.
- XML and tabular scoring normalization.
- Sleepware RML scoring normalization.
- Excel serial timestamp preservation for EDF alignment.
- Default PSG channel ordering.

## V1 Scope

Included:

- Scored-study review.
- Waveform viewing.
- Sleep stage and event overlays.
- Configurable channel and event visibility.
- Autoscale and manual channel amplitude scale.
- Whole-night overview.

Not included yet:

- Event editing.
- Exporting.
- Filtering.
- Montage or re-reference tools.
- Clinical archive integration.
- Multi-study sessions.
- Persistent study storage.

## Implementation Notes

- `src/edf/` contains EDF parsing, windowed signal reads, and the Web Worker client.
- `src/scoring/` contains XML, XLS, XLSX, CSV/TSV import and scoring normalization.
- `src/domain/channels.js` contains PSG channel classification, display ordering, and zoom presets.
- `src/viewer/canvasRenderer.js` contains the canvas waveform and overlay renderer.
- `src/main.js` wires the UI, browser state, preferences, and viewer interactions.
