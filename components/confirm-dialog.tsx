"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FaCheck,
  FaCheckCircle,
  FaExclamationTriangle,
  FaInfoCircle,
  FaSpinner,
  FaTimes,
  FaTrash,
} from "react-icons/fa";

type ConfirmTone = "default" | "danger" | "warning" | "info" | "success";

export interface ConfirmOptions {
  title?: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** If true, only show the confirm button (for notifications/alerts). */
  single?: boolean;
}

type ConfirmFn = (opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return fn;
}

const TONE_STYLES: Record<
  ConfirmTone,
  { icon: ReactNode; iconBg: string; confirmBtn: string }
> = {
  default: {
    icon: <FaInfoCircle />,
    iconBg: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    confirmBtn: "bg-teal-600 hover:bg-teal-700",
  },
  danger: {
    icon: <FaTrash />,
    iconBg: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    confirmBtn: "bg-rose-600 hover:bg-rose-700",
  },
  warning: {
    icon: <FaExclamationTriangle />,
    iconBg: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    confirmBtn: "bg-amber-600 hover:bg-amber-700",
  },
  info: {
    icon: <FaInfoCircle />,
    iconBg: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    confirmBtn: "bg-sky-600 hover:bg-sky-700",
  },
  success: {
    icon: <FaCheckCircle />,
    iconBg: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    confirmBtn: "bg-emerald-600 hover:bg-emerald-700",
  },
};

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        if (resolverRef.current) resolverRef.current(false);
        resolverRef.current = resolve;
        setPending({ ...(opts ?? {}), resolve });
      }),
    []
  );

  const close = (ok: boolean) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setPending(null);
    setSubmitting(false);
    r?.(ok);
  };

  const tone: ConfirmTone = pending?.tone ?? "default";
  const styles = TONE_STYLES[tone];
  const isSingle = pending?.single ?? tone === "success";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-in fade-in"
          onClick={() => !submitting && close(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="glass rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 text-center">
              <div
                className={`w-10 h-10 mx-auto rounded-full flex items-center justify-center text-base ${styles.iconBg}`}
              >
                {styles.icon}
              </div>
              <h3 className="mt-3 text-sm font-bold text-slate-800 dark:text-white">
                {pending.title ?? "ຢືນຢັນ?"}
              </h3>
              {pending.message && (
                <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap leading-relaxed">
                  {pending.message}
                </div>
              )}
            </div>
            <div className={`px-4 pb-4 flex gap-2 ${isSingle ? "justify-center" : ""}`}>
              {!isSingle && (
                <button
                  type="button"
                  onClick={() => close(false)}
                  disabled={submitting}
                  className="flex-1 px-3 py-2 rounded-lg text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 disabled:opacity-50 inline-flex items-center justify-center gap-1.5 transition-colors"
                >
                  <FaTimes size={10} />
                  {pending.cancelLabel ?? "ຍົກເລີກ"}
                </button>
              )}
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setSubmitting(true);
                  setTimeout(() => close(true), 0);
                }}
                disabled={submitting}
                className={`${isSingle ? "flex-1" : "flex-1"} px-3 py-2 rounded-lg text-[11px] font-semibold text-white disabled:opacity-50 inline-flex items-center justify-center gap-1.5 transition-colors ${styles.confirmBtn}`}
              >
                {submitting ? (
                  <FaSpinner className="animate-spin" size={10} />
                ) : (
                  <FaCheck size={10} />
                )}
                {pending.confirmLabel ?? (isSingle ? "ຕົກລົງ" : "ຢືນຢັນ")}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
