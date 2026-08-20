/**
 * OsNav — the os-viewing rail, listed from SECTIONS so nothing else enumerates
 * pages (the same rule the Astro `Nav.astro` held).
 *
 * One deviation from `sections.ts`: the projects board's section href is `/`,
 * which in this app is already the bcns front door. Its page is mounted at
 * `/projects` instead. Every other section keeps its real href, so
 * `fileHrefsFor()` (which mints `/files?file=…`) needs no rewriting.
 *
 * Sections whose pages were NOT ported — chat, insights, notes — are not
 * listed: they read `~/.claude`, which a server does not have.
 */
import Link from "next/link";
import { SECTIONS } from "@/lib/os/sections";

/** The `/`-is-taken exception, in one place. */
export function osHref(sectionHref: string): string {
  return sectionHref === "/" ? "/projects" : sectionHref;
}

/** Sections with a ported page. Everything else depends on unported libs. */
const PORTED = new Set(["/graph", "/", "/files"]);

export default function OsNav({ current }: { current: string }) {
  return (
    <nav aria-label="os sections">
      <ul>
        {SECTIONS.filter((s) => PORTED.has(s.href)).map((s) => (
          <li key={s.href}>
            {s.href === current ? (
              <span aria-current="page">{s.label}</span>
            ) : (
              <Link href={osHref(s.href)}>{s.label}</Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
