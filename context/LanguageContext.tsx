"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { type Locale, locales, localeLabels, createT } from "@/lib/i18n";

type LanguageContextType = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
  locales: readonly Locale[];
  localeLabels: Record<Locale, string>;
};

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("odg_locale") as Locale | null;
      if (saved && locales.includes(saved)) return saved;
    }
    return "lo";
  });

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    if (typeof window !== "undefined") {
      localStorage.setItem("odg_locale", newLocale);
    }
  }, []);

  const t = createT(locale);

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t, locales, localeLabels }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
