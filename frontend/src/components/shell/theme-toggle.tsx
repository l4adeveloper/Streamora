"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/lib/theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(DEFAULT_THEME === "dark");

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
    function syncTheme(event: StorageEvent) {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      const theme = event.newValue === "light" ? "light" : DEFAULT_THEME;
      document.documentElement.dataset.theme = theme;
      setDark(theme === "dark");
    }
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  function toggleTheme() {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(next === "dark");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Switching still works when the browser blocks persistent storage.
    }
  }

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label="Chế độ tối"
      aria-pressed={dark}
      title={dark ? "Chuyển sang chế độ sáng" : "Chuyển sang chế độ tối"}
      onClick={toggleTheme}
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
