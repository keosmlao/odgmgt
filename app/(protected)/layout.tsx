"use client";

import type { ReactNode } from "react";
import Sidebar from "@/components/Sidebar";
import ProtectedRoute from "@/components/common/ProtectedRoute";

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <div className="flex min-h-screen w-full overflow-hidden bg-slate-50 dark:bg-slate-950">
        <Sidebar />

        {/* Main Content */}
        <main className="flex min-w-0 flex-1 flex-col md:ml-64">
          <div className="h-full w-full flex-1 overflow-y-auto pt-14 md:pt-0">
            {children}
          </div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
