import { useEffect, useState } from "react";

const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

export function useSystemTheme(): "light" | "dark" {
  const [dark, setDark] = useState(() => mql().matches);
  useEffect(() => {
    const m = mql();
    const on = () => setDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return dark ? "dark" : "light";
}
