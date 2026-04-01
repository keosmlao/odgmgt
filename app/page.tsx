"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";

export default function Home() {
  const router = useRouter();
  const { user, hydrated } = useAuth();

  useEffect(() => {
    if (!hydrated) return;
    if (user) {
      router.replace("/dashboard");
    } else {
      router.replace("/login");
    }
  }, [hydrated, user, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="text-sm font-semibold text-slate-500">Loading...</div>
    </div>
  );
}
