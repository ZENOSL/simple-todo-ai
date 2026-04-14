"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { getStoredToken, setStoredToken, getOrCreateDeviceId } from "../lib/auth";

/* ============================================================
   全局 Providers
   - TanStack Query：服务器状态管理
   - Zustand 无需 Provider（模块级单例）
   ============================================================ */

export function Providers({ children }: { children: React.ReactNode }) {
  // mount 时若无 token，自动完成匿名登录
  useEffect(() => {
    if (getStoredToken()) return;
    fetch("/api/auth/anonymous", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: getOrCreateDeviceId() }),
    })
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<{ access_token: string }>;
      })
      .then((data) => {
        if (data?.access_token) setStoredToken(data.access_token);
      })
      .catch(() => {
        // 静默失败，apiFetch 在首次 401 时会再次尝试
      });
  }, []);

  // 每个请求创建独立的 QueryClient，防止服务端数据污染
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 30 秒内数据视为新鲜，不重复请求
            staleTime: 30_000,
            // 网络错误最多重试 2 次
            retry: 2,
            retryDelay: (attemptIndex) =>
              Math.min(1000 * 2 ** attemptIndex, 10_000),
          },
          mutations: {
            // Mutation 默认不重试（防止重复写库）
            retry: 0,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
