"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AlertCircle, Eye, EyeOff, Globe, Lock, User } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";

const LOCALE_FLAGS: Record<string, string> = { lo: "🇱🇦", th: "🇹🇭", en: "🇬🇧" };

const STATS = [
  { value: "6+", label: "BUs" },
  { value: "10+", label: "Channels" },
  { value: "18", label: "Provinces" },
];

/* ── Input row ── */
function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: React.ElementType;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <div
        className="flex items-center gap-2 rounded-[var(--r-md)] border px-3 py-2.5 transition-colors focus-within:border-[var(--brand)] focus-within:shadow-[0_0_0_3px_var(--info-bg)]"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}
      >
        {Icon && <Icon className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />}
        {children}
      </div>
    </div>
  );
}

export default function Login() {
  const router = useRouter();
  const { login } = useAuth() as any;
  const { t, locale, setLocale, locales: locs, localeLabels } = useLanguage();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await login(form.username, form.password);
      if (res.success) router.push("/dashboard");
      else setError(res.message || t("login.errorUsername"));
    } catch {
      setError(t("login.errorConnection"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      {/* ── Brand panel ── */}
      <div
        className="relative flex flex-col justify-center overflow-hidden px-6 py-10 sm:py-14 lg:w-[44%] lg:px-12 lg:py-0"
        style={{ background: "linear-gradient(150deg, var(--brand-deep) 0%, #04294c 55%, #0a3f70 100%)" }}
      >
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[var(--sky)]/15 blur-[90px]" />
        <div className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-[var(--accent)]/15 blur-[90px]" />
        <div className="pointer-events-none absolute -right-20 top-1/3 h-56 w-56 rounded-full border-[28px] border-white/[0.04]" />

        <div className="relative z-10 mx-auto flex w-full max-w-md flex-col items-center gap-7 text-center lg:mx-0 lg:items-start lg:text-left">
          <Image src="/ODG.png" alt="ODIEN GROUP" width={160} height={90} preload className="h-auto w-28 sm:w-32" />

          <div className="space-y-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--sky)]">ODIEN GROUP</p>
            <h1 className="text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl lg:text-[2.1rem]">
              {t("login.heroTitle")}
              <br />
              <span className="bg-gradient-to-r from-[var(--sky)] to-[var(--warm)] bg-clip-text text-transparent">
                {t("login.heroSystem")}
              </span>
            </h1>
            <p className="text-[13px] leading-relaxed text-white/55">{t("login.heroDesc")}</p>
          </div>

          <div className="flex gap-2.5">
            {STATS.map((stat) => (
              <div key={stat.label} className="rounded-[var(--r-md)] border border-white/10 bg-white/[0.06] px-4 py-2.5">
                <p className="num text-lg font-bold text-white">{stat.value}</p>
                <p className="text-[10px] uppercase tracking-wider text-white/45">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-1.5 lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--sky)]" />
            <span className="text-[11px] font-medium text-white/55">Secure access · Role-based permissions</span>
          </div>
        </div>
      </div>

      {/* ── Form panel ── */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-7 flex items-center justify-end gap-1">
            <Globe className="h-3.5 w-3.5" style={{ color: "var(--muted)" }} />
            {locs.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                className="rounded-[var(--r-xs)] px-2 py-1 text-[11px] font-semibold transition-colors"
                style={locale === l ? { background: "var(--brand-deep)", color: "#fff" } : { color: "var(--muted)" }}
              >
                {LOCALE_FLAGS[l]} {localeLabels[l]}
              </button>
            ))}
          </div>

          <div className="mb-6">
            <h2 className="text-xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
              {t("login.welcome")}
            </h2>
            <p className="page-sub mt-0.5">{t("login.subtitle")}</p>
          </div>

          {error && (
            <div
              className="mb-4 flex items-start gap-2 rounded-[var(--r-md)] border px-3 py-2.5 text-[12px] font-medium"
              style={{ borderColor: "var(--neg)", background: "var(--neg-bg)", color: "var(--neg)" }}
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <Field label={t("login.username")} icon={User}>
              <input
                className="w-full bg-transparent text-[13px] outline-none"
                style={{ color: "var(--ink)" }}
                placeholder={t("login.usernamePlaceholder")}
                autoComplete="username"
                value={form.username}
                onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              />
            </Field>

            <Field label={t("login.password")} icon={Lock}>
              <input
                className="w-full bg-transparent text-[13px] outline-none"
                style={{ color: "var(--ink)" }}
                type={showPw ? "text" : "password"}
                placeholder={t("login.passwordPlaceholder")}
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw((prev) => !prev)}
                className="shrink-0"
                style={{ color: "var(--muted)" }}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </Field>

            <button type="submit" disabled={loading} className="btn btn-primary w-full py-2.5 text-[13px]">
              {loading ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  {t("login.signingIn")}
                </>
              ) : (
                t("login.submit")
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-[10.5px]" style={{ color: "var(--muted)" }}>
            ODIEN GROUP &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
