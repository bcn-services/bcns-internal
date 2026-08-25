"use client";

/**
 * nav.tsx — the shell sidebar. Client component only because the active row
 * needs the current pathname; nothing else here is interactive.
 *
 * `/admin` is rendered from the role the server layout passes in, so a member
 * never sees a link they would only get a 403 from. That hiding is convenience,
 * not security: the real gate is routeAccessDecision() in lib/auth.ts, and
 * under it the RLS policies, which is what makes typing the URL useless.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@/lib/auth";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/leads", label: "Leads" },
  { href: "/clients", label: "Clients" },
  { href: "/tasks", label: "Tasks" },
  { href: "/inbox", label: "Inbox" },
] as const;

const ADMIN_LINK = { href: "/admin", label: "Admin" } as const;

/**
 * Not one of the five. /account is where an employee connects their own Claude
 * seat — a setting about themselves rather than a place work happens — so it
 * sits in the footer instead of taking a row beside the work surfaces.
 */
const ACCOUNT_LINK = { href: "/account", label: "Account" } as const;

export default function Nav({ role, unread = null }: { role: Role | null; unread?: number | null }) {
  const pathname = usePathname();

  // Signed-out page: no shell chrome, the content takes the full width.
  if (pathname === "/login") return null;

  const links = role === "admin" ? [...LINKS, ADMIN_LINK] : LINKS;

  return (
    <nav className="sidebar" aria-label="Main">
      <Link href="/" className="sidebar-brand">
        {/* Unoptimized: next/image would want a loader config for one static
            33KB mark that never changes size. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/bcns-mark.png" alt="" width={30} height={30} />
        <b>
          bcns<span>{role ?? "member"}</span>
        </b>
      </Link>
      <div className="sidebar-links">
        {links.map(({ href, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          // The count is passed in from the layout, already cached — this
          // component never fetches. See lib/inbox-badge.ts.
          const badge = href === "/inbox" && unread !== null && unread > 0 ? unread : 0;
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined}>
              {label}
              {badge > 0 && (
                <span className="nav-badge" aria-label={`${badge} unread`}>
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <Link
          href={ACCOUNT_LINK.href}
          aria-current={pathname.startsWith(ACCOUNT_LINK.href) ? "page" : undefined}
        >
          {ACCOUNT_LINK.label}
        </Link>
      </div>
    </nav>
  );
}
