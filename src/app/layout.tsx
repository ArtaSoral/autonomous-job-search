import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = {
  title: "Personal Job Finder",
  description: "Private job search command center",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <aside>
          <Link className="brand" href="/">
            Job Finder<span>PERSONAL COMMAND CENTER</span>
          </Link>
          <nav>
            {[
              ["/", "Dashboard"],
              ["/jobs/new", "Add a job"],
              ["/applications", "Applications"],
              ["/companies", "Companies"],
              ["/bank", "Resume bank"],
              ["/quality", "Quality & feedback"],
              ["/settings", "Settings"],
            ].map(([url, label]) => (
              <Link key={url} href={url}>
                {label}
              </Link>
            ))}
          </nav>
          <p className="privacy">
            LOCAL WORKSPACE
            <br />
            Your records are stored on this machine.
            <br />
            Selected facts go to OpenAI for model calls.
          </p>
        </aside>
        <main>{children}</main>
      </body>
    </html>
  );
}
