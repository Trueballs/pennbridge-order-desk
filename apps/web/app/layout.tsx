import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pennbridge Order Desk",
  description: "Review and prepare industrial purchase orders for approval.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-GB"><body>{children}</body></html>;
}
