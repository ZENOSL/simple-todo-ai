import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

/* ============================================================
   Next.js App Router Root Layout
   ============================================================ */

export const metadata: Metadata = {
  title: "Simple Todo AI",
  description: "用自然语言管理你的每日任务",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Simple Todo AI",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#4C6EF5",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
