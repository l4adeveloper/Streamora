export const THEME_STORAGE_KEY = "streamora-theme";

// Apply the saved palette before hydration; storage can be unavailable.
export const themeInitScript = `try {
  document.documentElement.dataset.theme = localStorage.getItem("${THEME_STORAGE_KEY}") === "dark" ? "dark" : "light";
} catch {}`;
