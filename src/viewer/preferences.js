const STORAGE_KEY = "psg-viewer-preferences-v3";

export function loadPreferences() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function savePreferences(preferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
