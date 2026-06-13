"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import api from "@/service/api";
import type { AuthUser } from "@/lib/types";

interface AuthResponse {
  success: boolean;
  user?: AuthUser;
  token?: string;
  message?: string;
  [key: string]: unknown;
}

interface AuthContextValue {
  user: AuthUser | null;
  hydrated: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<AuthResponse>;
  bootstrap: (form: Record<string, unknown>) => Promise<AuthResponse>;
  logout: () => Promise<void>;
}

interface ApiError {
  response?: { data?: { message?: string } };
}

const TOKEN_KEY = "odg_token";
const USER_KEY = "odg_user";
const AuthContext = createContext<AuthContextValue | null>(null);

function persistAuth(user: AuthUser | null, token: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  }
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
}

function clearAuth() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  delete api.defaults.headers.common.Authorization;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    const savedUser = typeof window !== "undefined" ? localStorage.getItem(USER_KEY) : null;

    if (token) {
      api.defaults.headers.common.Authorization = `Bearer ${token}`;
    }
    if (savedUser) {
      try {
        setUser(JSON.parse(savedUser));
      } catch {
        clearAuth();
      }
    }

    if (!token) {
      setHydrated(true);
      return;
    }

    api
      .get("/auth/me")
      .then((response: { data?: AuthResponse }) => {
        if (response.data?.success && response.data.user) {
          setUser(response.data.user);
          persistAuth(response.data.user ?? null, token);
        } else {
          clearAuth();
          setUser(null);
        }
      })
      .catch(() => {
        clearAuth();
        setUser(null);
      })
      .finally(() => {
        setHydrated(true);
      });
  }, []);

  const login = async (username: string, password: string) => {
    try {
      const response = await api.post("/auth/login", { username, password });
      const payload: AuthResponse = response.data || { success: false };
      if (payload.success && payload.user && payload.token) {
        setUser(payload.user);
        persistAuth(payload.user, payload.token);
      }
      return payload;
    } catch (error: unknown) {
      const err = error as ApiError;
      return {
        success: false,
        message: err?.response?.data?.message || "Login failed",
      };
    }
  };

  const bootstrap = async (form: Record<string, unknown>) => {
    try {
      const response = await api.post("/auth/bootstrap", form);
      return (response.data || { success: false }) as AuthResponse;
    } catch (error: unknown) {
      const err = error as ApiError;
      return {
        success: false,
        message: err?.response?.data?.message || "Bootstrap failed",
      };
    }
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // Best effort only.
    } finally {
      clearAuth();
      setUser(null);
    }
  };

  const value = useMemo(
    () => ({
      user,
      hydrated,
      isAuthenticated: Boolean(user),
      login,
      bootstrap,
      logout,
    }),
    [user, hydrated],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
