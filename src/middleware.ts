import { NextRequest, NextResponse } from "next/server";

/**
 * Einfache HTTP Basic Auth für das gesamte Frontend + die API.
 * Aktiv, sobald BOOKSCOUT_PASSWORD gesetzt ist. Wenn nicht, ist die Seite
 * wie bisher ungeschützt öffentlich zugänglich.
 *
 * ENV:
 *   BOOKSCOUT_USER      (optional, default "admin")
 *   BOOKSCOUT_PASSWORD  (zwingend für Auth-Aktivierung)
 */

export function middleware(req: NextRequest) {
  const password = process.env.BOOKSCOUT_PASSWORD;
  if (!password) return NextResponse.next();

  const user = process.env.BOOKSCOUT_USER ?? "admin";

  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("basic ")) {
    const encoded = auth.slice(6).trim();
    let decoded = "";
    try {
      // atob ist in der Edge-Runtime verfügbar
      decoded = atob(encoded);
    } catch {
      decoded = "";
    }
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1);
      if (u === user && p === password) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentifizierung erforderlich.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="BookScout DE", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export const config = {
  // Alles schützen außer statische Next-Assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
