import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Avatar AI – Deine lebendige KI-Assistentin",
  description:
    "Eine animierte, sprachfähige KI-Assistentin mit OAuth für OpenRouter, Hugging Face und Google Gemini.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className="antialiased">{children}</body>
    </html>
  );
}
