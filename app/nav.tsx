"use client";

/**
 * nav.tsx — the shell sidebar. Client component only because the active row
 * needs the current pathname; nothing else here is interactive.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/leads", label: "Leads" },
  { href: "/clients", label: "Clients" },
  { href: "/projects", label: "Projects" },
  { href: "/notes", label: "Notes" },
  { href: "/insights", label: "Insights" },
  { href: "/files", label: "Files" },
  { href: "/graph", label: "Graph" },
  { href: "/chat", label: "Chat" },
] as const;

export default function Nav() {
  const pathname = usePathname();

  // Signed-out page: no shell chrome, the content takes the full width.
  if (pathname === "/login") return null;

  return (
    <nav className="sidebar" aria-label="Main">
      <Link href="/" className="sidebar-brand">
        bcns<span>internal</span>
      </Link>
      <div className="sidebar-links">
        {LINKS.map(({ href, label }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined}>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
