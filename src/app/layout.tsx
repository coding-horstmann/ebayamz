import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BookScout DE",
  description:
    "Online-Arbitrage für gebrauchte Bücher – Preisdifferenzen zwischen eBay.de und Amazon.de.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                    BookScout DE
                  </h1>
                  <p className="text-sm text-slate-500">
                    Gebrauchte Bücher – günstig auf eBay.de kaufen, teurer auf Amazon.de verkaufen.
                  </p>
                </div>
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto max-w-7xl px-4 py-4 text-xs text-slate-500 sm:px-6">
              Daten: Keepa &amp; eBay Browse API. Preise ohne Gewähr.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
