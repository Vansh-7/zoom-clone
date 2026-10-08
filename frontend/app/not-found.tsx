import Link from "next/link";
import { WorkplaceBrand } from "@/components/workplace-brand";
export default function NotFound() {
  return (
    <main className="standalone">
      <div className="wordmark">
        <WorkplaceBrand />
      </div>
      <h1>We couldn’t find that page.</h1>
      <p>Check the invitation link or return to your workspace.</p>
      <Link className="button primary" href="/">
        Back to Home
      </Link>
    </main>
  );
}
