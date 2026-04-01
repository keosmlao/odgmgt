"use client";

function joinClasses(...values: (string | undefined | null | false)[]) {
  return values.filter(Boolean).join(" ");
}

export function Button({
  className = "",
  variant = "default",
  size = "md",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost";
  size?: "md" | "icon";
}) {
  const variantClass =
    variant === "ghost"
      ? "bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      : "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white";

  const sizeClass =
    size === "icon"
      ? "inline-flex h-10 w-10 items-center justify-center"
      : "inline-flex items-center justify-center gap-2 px-4 py-2";

  return (
    <button
      type={type}
      className={joinClasses(
        "rounded-xl font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60",
        variantClass,
        sizeClass,
        className,
      )}
      {...props}
    />
  );
}
