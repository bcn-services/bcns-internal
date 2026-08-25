import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./nav";
import { getViewer } from "@/lib/supabase-server";
import { getServiceClient } from "@/lib/supabase-admin";
import { countUnread } from "@/lib/inbox";
import { cachedUnreadCount } from "@/lib/inbox-badge";

/*
 * next/font self-hosts both faces at build time, so the app makes no request
 * to fonts.googleapis.com at runtime and there is no swap flash. The CSS
 * variables it hands back are what --font-display / --font-mono resolve to;
 * globals.css names the families again as the fallback for the case where the
 * class never lands on <html>.
 */
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "bcns",
  description: "Internal command center for the bcns studio.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read here rather than in Nav so the sidebar stays a client component for
  // usePathname. A null role is the signed-out or unprovisioned case, and it
  // gets the member sidebar — the gate, not the nav, is what turns it away.
  const { role, userId } = await getViewer();

  /*
   * The badge, read ONCE here and cached — see lib/inbox-badge.ts for why it is
   * not a query per page. The count is taken through the SERVICE client rather
   * than the cookie-bound one on purpose: a cached function must not reach for
   * request-scoped state, and the id it counts is `userId` from the verified
   * session, so this reads nothing but the viewer's own unread total. No row
   * content crosses this boundary, only an integer.
   */
  const unread = userId
    ? await cachedUnreadCount(userId, async () => {
        const svc = getServiceClient();
        return svc ? countUnread(svc, userId) : 0;
      })
    : 0;

  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Nav role={role} unread={unread} />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
