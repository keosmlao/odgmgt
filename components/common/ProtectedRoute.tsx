"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/context/AuthContext";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, hydrated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !user) {
      router.replace("/login");
    }
  }, [hydrated, user, router]);

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-semibold text-slate-500 dark:bg-slate-950 dark:text-slate-300">
        Loading session...
      </div>
    );
  }

  if (!user) return null;

  return <>{children}</>;
}
