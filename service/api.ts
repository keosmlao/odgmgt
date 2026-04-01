import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL || "/api",
  timeout: 30000,
  withCredentials: false,
});

api.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("odg_token");
    if (token && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    if (status === 401) {
      if (typeof window !== "undefined") {
        localStorage.removeItem("odg_token");
        localStorage.removeItem("odg_user");
        delete api.defaults.headers.common.Authorization;
        if (window.location?.pathname !== "/login") {
          window.location.assign("/login");
        }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
