"use client";

import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  Lock,
  Network,
  User,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useLanguage } from "@/context/LanguageContext";
import api from "@/service/api";

/* ── Types ── */
type View = "login" | "setup" | "register";

interface ActionForm {
  username: string;
  password: string;
  full_name: string;
  role: string;
  bu_code: string;
  channel_codes: string[];
}

interface OptionItem {
  code: string;
  name_1?: string | null;
  name?: string | null;
}

const ROLES = [
  { value: "ceo", label: "CEO" },
  { value: "gm", label: "GM" },
  { value: "sale_bu_manager", label: "Sale BU Manager" },
  { value: "sale_supervisor", label: "Sale Supervisor" },
  { value: "sale", label: "Sale" },
];

const LOCALE_FLAGS: Record<string, string> = {
  lo: "🇱🇦",
  th: "🇹🇭",
  en: "🇬🇧",
};

const BLANK_ACTION: ActionForm = {
  username: "",
  password: "",
  full_name: "",
  role: "sale",
  bu_code: "",
  channel_codes: [],
};

/* ── Shared input wrapper ── */
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
    <div className="space-y-1.5">
      <label className="block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </label>
      <div className="group flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-all focus-within:border-blue-500 focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.12)] dark:border-slate-700 dark:bg-slate-800/80 dark:focus-within:border-blue-400">
        {Icon && (
          <Icon className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-focus-within:text-blue-500" />
        )}
        {children}
      </div>
    </div>
  );
}

/* ── Main ── */
export default function Login() {
  const router = useRouter();
  const { login, bootstrap, user } = useAuth() as any;
  const { t, locale, setLocale, locales: locs, localeLabels } = useLanguage();

  const [view, setView] = useState<View>("login");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState({ type: "", text: "" });
  const [initialized, setInitialized] = useState(true);
  const [showPw, setShowPw] = useState(false);

  const [buOptions, setBuOptions] = useState<OptionItem[]>([]);
  const [channelOptions, setChannelOptions] = useState<OptionItem[]>([]);

  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [setupForm, setSetupForm] = useState<ActionForm>({
    ...BLANK_ACTION,
    role: "ceo",
  });
  const [regForm, setRegForm] = useState<ActionForm>({ ...BLANK_ACTION });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get("/auth/status").catch(() => ({ data: { success: false } })),
      api.get("/bu").catch(() => ({ data: { data: [] } })),
      api.get("/sale-channel").catch(() => ({ data: { data: [] } })),
    ]).then(([statusRes, buRes, chRes]: any[]) => {
      if (cancelled) return;
      if (statusRes.data?.success) {
        const init = !!statusRes.data.initialized;
        setInitialized(init);
        if (!init) setView("setup");
      }
      if (buRes.data?.success) setBuOptions(buRes.data.data ?? []);
      if (chRes.data?.success) setChannelOptions(chRes.data.data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setMsg({ type: "", text: "" });
    setShowPw(false);
  }, [view]);

  const adminAccess = user?.role === "ceo" || user?.role === "gm";

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg({ type: "", text: "" });
    try {
      const res = await login(loginForm.username, loginForm.password);
      if (res.success) {
        router.push("/dashboard");
      } else {
        setMsg({ type: "error", text: res.message || t("login.errorUsername") });
      }
    } catch {
      setMsg({ type: "error", text: t("login.errorConnection") });
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (e: FormEvent, mode: "setup" | "register") => {
    e.preventDefault();
    setMsg({ type: "", text: "" });
    const isSetup = mode === "setup";
    const form = isSetup ? setupForm : regForm;
    const setForm = isSetup ? setSetupForm : setRegForm;

    if (form.role === "sale_bu_manager") {
      if (!form.bu_code) return setMsg({ type: "error", text: t("login.errorSelectBu") });
      if (!form.channel_codes.length)
        return setMsg({ type: "error", text: t("login.errorSelectChannel") });
    }

    setLoading(true);
    try {
      const res = isSetup
        ? await bootstrap(form)
        : (await api.post("/auth/register", form)).data;

      if (res?.success) {
        setMsg({
          type: "success",
          text: isSetup ? t("login.setupComplete") : t("login.regComplete"),
        });
        if (isSetup) setTimeout(() => setView("login"), 1400);
        else setForm({ ...BLANK_ACTION });
      } else {
        setMsg({ type: "error", text: res?.message || t("login.errorFailed") });
      }
    } catch {
      setMsg({ type: "error", text: t("login.errorConnection") });
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    "w-full bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-white dark:placeholder:text-slate-500";

  const setField = (
    setter: Dispatch<SetStateAction<ActionForm>>,
    key: keyof ActionForm,
    val: any,
  ) => setter((p) => ({ ...p, [key]: val }));

  /* ── Role fields for setup/register ── */
  const renderRoleFields = (form: ActionForm, setter: Dispatch<SetStateAction<ActionForm>>) => (
    <>
      <Field label={t("login.role")} icon={ChevronDown}>
        <select
          className="w-full appearance-none bg-transparent text-sm text-slate-900 outline-none dark:text-white"
          value={form.role}
          onChange={(e) => setField(setter, "role", e.target.value)}
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      {form.role === "sale_bu_manager" && (
        <div className="space-y-4 rounded-2xl border border-teal-200/60 bg-teal-50/40 p-4 dark:border-teal-800/40 dark:bg-teal-900/10">
          <p className="text-xs font-semibold text-teal-700 dark:text-teal-400">
            {t("login.buScope")}
          </p>
          <Field label={t("login.businessUnit")} icon={Building2}>
            <select
              className="w-full appearance-none bg-transparent text-sm text-slate-900 outline-none dark:text-white"
              value={form.bu_code}
              onChange={(e) => setField(setter, "bu_code", e.target.value)}
            >
              <option value="">{t("login.selectBu")}</option>
              {buOptions.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.name_1 || b.name || b.code}
                </option>
              ))}
            </select>
          </Field>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              {t("login.channels")}
            </label>
            <div className="flex items-start gap-2.5 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-700 dark:bg-slate-800/80">
              <Network className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              <select
                multiple
                className="h-24 w-full bg-transparent text-sm text-slate-900 outline-none dark:text-white"
                value={form.channel_codes}
                onChange={(e) => {
                  const vals = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setField(setter, "channel_codes", vals);
                }}
              >
                {channelOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name_1 || c.name || c.code}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="relative flex min-h-svh flex-col lg:flex-row" style={{ fontFamily: '"Noto Sans Lao","Noto Sans",system-ui,sans-serif' }}>
      {/* ── Ambient background ── */}
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-br from-slate-50 via-white to-blue-50/40 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950" />
      <div className="pointer-events-none fixed inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle, #94a3b8 1px, transparent 1px)", backgroundSize: "24px 24px" }} />

      {/* ── Left / Top brand panel ── */}
      <div className="relative flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-[#0f172a] to-blue-950 px-6 py-10 sm:py-14 lg:w-[46%] lg:py-0 xl:w-[44%]">
        {/* Glows */}
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-blue-500/15 blur-[100px]" />
        <div className="absolute -bottom-20 -right-20 h-64 w-64 rounded-full bg-emerald-500/15 blur-[100px]" />
        <div className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/10 blur-[80px]" />

        <div className="relative z-10 flex max-w-md flex-col items-center gap-6 text-center lg:items-start lg:gap-8 lg:text-left">
          <Image
            src="/ODG.png"
            alt="ODIEN GROUP"
            width={160}
            height={53}
            priority
            className="h-auto w-28 sm:w-36 lg:w-40"
          />

          <div className="space-y-3">
            <h1 className="text-2xl font-bold leading-tight tracking-tight text-white sm:text-3xl lg:text-4xl">
              {t("login.heroTitle")}
              <br />
              <span className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
                {t("login.heroSystem")}
              </span>
            </h1>
            <p className="text-sm leading-relaxed text-slate-400 lg:text-base lg:leading-relaxed">
              {t("login.heroDesc")}
            </p>
          </div>

          {/* Stats */}
          <div className="flex gap-3 sm:gap-4">
            {[
              { val: "6+", label: "BUs" },
              { val: "10+", label: "Channels" },
              { val: "18", label: "Provinces" },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 backdrop-blur sm:px-5 sm:py-3"
              >
                <p className="text-lg font-bold text-white sm:text-xl">{s.val}</p>
                <p className="text-[10px] uppercase tracking-wider text-slate-500 sm:text-[11px]">
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          {/* Trust line - desktop only */}
          <div className="hidden items-center gap-3 rounded-full border border-white/8 bg-white/5 px-4 py-2 backdrop-blur lg:flex">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            <span className="text-xs font-medium text-slate-400">
              Secure access &middot; Role-based permissions
            </span>
          </div>
        </div>
      </div>

      {/* ── Right / Bottom form panel ── */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-5 py-8 sm:px-8 sm:py-12 lg:px-12 xl:px-16">
        <div className="w-full max-w-[420px]">
          {/* ── Language switcher ── */}
          <div className="mb-6 flex items-center justify-end gap-1">
            <Globe className="h-3.5 w-3.5 text-slate-400" />
            {locs.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                  locale === l
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {LOCALE_FLAGS[l]} {localeLabels[l]}
              </button>
            ))}
          </div>

          {/* ── Toast ── */}
          {msg.text && (
            <div
              className={`mb-5 flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm font-medium ${
                msg.type === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-400"
                  : "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400"
              }`}
            >
              {msg.type === "error" ? (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              {msg.text}
            </div>
          )}

          {/* ════ LOGIN ════ */}
          {view === "login" && (
            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {t("login.welcome")}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {t("login.subtitle")}
                </p>
              </div>

              <Field label={t("login.username")} icon={User}>
                <input
                  className={inputCls}
                  placeholder={t("login.usernamePlaceholder")}
                  autoComplete="username"
                  value={loginForm.username}
                  onChange={(e) =>
                    setLoginForm((p) => ({ ...p, username: e.target.value }))
                  }
                />
              </Field>

              <Field label={t("login.password")} icon={Lock}>
                <input
                  className={inputCls}
                  type={showPw ? "text" : "password"}
                  placeholder={t("login.passwordPlaceholder")}
                  autoComplete="current-password"
                  value={loginForm.password}
                  onChange={(e) =>
                    setLoginForm((p) => ({ ...p, password: e.target.value }))
                  }
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((p) => !p)}
                  className="shrink-0 text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </Field>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-blue-600 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-blue-600/30 active:scale-[0.98] disabled:opacity-60 disabled:shadow-none dark:bg-blue-500 dark:hover:bg-blue-600"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {t("login.signingIn")}
                  </span>
                ) : (
                  t("login.submit")
                )}
              </button>

              {(!initialized || adminAccess) && (
                <div className="flex flex-col items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                  {!initialized && (
                    <button
                      type="button"
                      onClick={() => setView("setup")}
                      className="text-xs font-medium text-rose-500 transition-colors hover:text-rose-600"
                    >
                      {t("login.setupRequired")}
                    </button>
                  )}
                  {adminAccess && (
                    <button
                      type="button"
                      onClick={() => setView("register")}
                      className="text-xs font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400"
                    >
                      {t("login.registerUser")}
                    </button>
                  )}
                </div>
              )}
            </form>
          )}

          {/* ════ SETUP / REGISTER ════ */}
          {(view === "setup" || view === "register") && (
            <form
              onSubmit={(e) => handleAction(e, view)}
              className="space-y-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                    {view === "setup" ? t("login.systemSetup") : t("login.createUser")}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {view === "setup" ? t("login.setupDesc") : t("login.createDesc")}
                  </p>
                </div>
                {view !== "setup" && (
                  <button
                    type="button"
                    onClick={() => setView("login")}
                    className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t("login.fullName")} icon={User}>
                  <input
                    className={inputCls}
                    placeholder="John Doe"
                    value={view === "setup" ? setupForm.full_name : regForm.full_name}
                    onChange={(e) => {
                      const v = e.target.value;
                      view === "setup"
                        ? setField(setSetupForm, "full_name", v)
                        : setField(setRegForm, "full_name", v);
                    }}
                  />
                </Field>
                <Field label={t("login.username")} icon={User}>
                  <input
                    className={inputCls}
                    placeholder="user.name"
                    value={view === "setup" ? setupForm.username : regForm.username}
                    onChange={(e) => {
                      const v = e.target.value;
                      view === "setup"
                        ? setField(setSetupForm, "username", v)
                        : setField(setRegForm, "username", v);
                    }}
                  />
                </Field>
              </div>

              <Field label={t("login.password")} icon={Lock}>
                <input
                  className={inputCls}
                  type={showPw ? "text" : "password"}
                  placeholder={t("login.setPassword")}
                  value={view === "setup" ? setupForm.password : regForm.password}
                  onChange={(e) => {
                    const v = e.target.value;
                    view === "setup"
                      ? setField(setSetupForm, "password", v)
                      : setField(setRegForm, "password", v);
                  }}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPw((p) => !p)}
                  className="shrink-0 text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
                >
                  {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </Field>

              {renderRoleFields(
                view === "setup" ? setupForm : regForm,
                view === "setup" ? setSetupForm : setRegForm,
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-2xl bg-emerald-600 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-700 hover:shadow-emerald-600/30 active:scale-[0.98] disabled:opacity-60 disabled:shadow-none dark:bg-emerald-500 dark:hover:bg-emerald-600"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    {t("login.processing")}
                  </span>
                ) : view === "setup" ? (
                  t("login.initSystem")
                ) : (
                  t("login.register")
                )}
              </button>
            </form>
          )}

          <p className="mt-8 text-center text-[11px] text-slate-400 dark:text-slate-600">
            ODIEN GROUP &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
