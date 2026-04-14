import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/stores/**/*.{ts,tsx}",
    "./src/hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#4C6EF5",
        background: "#F8F9FA",
        brand: {
          primary: "#4C6EF5",
          warning: "#F97316",
        },
      },
      spacing: {
        // 4px 基础单位扩展
        "0.5": "2px",
        "1": "4px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "8": "32px",
        "10": "40px",
        "12": "48px",
        "16": "64px",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
        "3xl": "24px",
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
        panel:
          "0 -4px 24px rgba(0,0,0,0.08), 0 -1px 4px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [],
};

export default config;
