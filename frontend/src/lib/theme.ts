export const THEME_STORAGE_KEY = "streamora-theme";
export const DEFAULT_THEME = "dark";

// Apply the saved palette before hydration; storage can be unavailable.
export const themeInitScript = `try {
  document.documentElement.dataset.theme = localStorage.getItem("${THEME_STORAGE_KEY}") === "light" ? "light" : "${DEFAULT_THEME}";
} catch {}`;
