"use client";

import type { ReactNode } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ProtectedRoute from "@/components/common/ProtectedRoute";

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <div className="app-shell flex min-h-screen w-full">
        <Sidebar />
        <main className="app-content flex min-w-0 flex-1 flex-col md:ml-60">
          <Topbar />
          <div className="w-full flex-1">{children}</div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
