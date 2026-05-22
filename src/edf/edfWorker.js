import { loadEdfStudy, readSignalWindow } from "./edfParser.js";

let activeFile = null;
let activeStudy = null;

self.addEventListener("message", async (event) => {
  const { id, type, file, request } = event.data;
  try {
    if (type === "load-study") {
      activeFile = file;
      activeStudy = await loadEdfStudy(file);
      self.postMessage({ id, ok: true, study: activeStudy });
      return;
    }

    if (type === "read-window") {
      if (!activeFile || !activeStudy) throw new Error("No EDF file has been loaded.");
      const result = await readSignalWindow(activeFile, activeStudy, request);
      self.postMessage({ id, ok: true, result });
      return;
    }

    throw new Error(`Unknown worker message: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
