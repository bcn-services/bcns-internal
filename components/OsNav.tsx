/**
 * OsNav — the os-viewing rail, listed from SECTIONS so nothing else enumerates
 * pages (the same rule the Astro `Nav.astro` held).
 *
 * One deviation from `sections.ts`: the projects board's section href is `/`,
 * which in this app is already the bcns front door. Its page is mounted at
 * `/projects` instead. Every other section keeps its real href, so
 * `fileHrefsFor()` (which mints `/files?file=…`) needs no rewriting.
 *
 * Every section now has a page. Chat, insights and notes were the three that
 * read a laptop; each was re-pointed at Postgres or at the model, so the
 * PORTED gate below is now the full section list and is kept only as the one
 * place that would narrow again if a section were removed.
 */
import Link from "next/link";
import { SECTIONS } from "@/lib/os/sections";

/** The `/`-is-taken exception, in one place. */
export function osHref(sectionHref: string): string {
  return sectionHref === "/" ? "/projects" : sectionHref;
}

/** Sections with a page. A section missing from here is listed nowhere. */
const PORTED = new Set(["/graph", "/", "/chat", "/files", "/insights", "/notes"]);

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
