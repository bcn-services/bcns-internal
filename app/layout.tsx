import type { Metadata } from "next";
import "./globals.css";
import Nav from "./nav";
import { getViewer } from "@/lib/supabase-server";

export const metadata: Metadata = {
  title: "bcns",
  description: "Internal command center for the bcns studio.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read here rather than in Nav so the sidebar stays a client component for
  // usePathname. A null role is the signed-out or unprovisioned case, and it
  // gets the member sidebar — the gate, not the nav, is what turns it away.
  const { role } = await getViewer();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav role={role} />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
