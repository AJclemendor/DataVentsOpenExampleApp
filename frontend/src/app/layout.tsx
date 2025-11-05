import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./AppShell";

export const metadata: Metadata = {
  title: "DataVents",
  description: "Minimal web client for DataVents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="text-gray-900 bg-white antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
