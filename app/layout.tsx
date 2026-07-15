import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Painel Faturamento" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
