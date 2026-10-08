"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone">
      <h1>Something went wrong.</h1>
      <p>Try loading the page again to return to your meetings.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
      <Link className="button secondary" href="/">
        Back to Home
      </Link>
    </main>
  );
}
