"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Meeting } from "@/types";
import { JoinForm, ScheduleForm } from "./meeting-forms";
import { MeetingDetails } from "./meeting-dialogs";
import { WorkspaceShell } from "./workspace-shell";
import { useToast } from "./ui";

export function JoinPage() {
  const router = useRouter();
  return (
    <WorkspaceShell>
      <main className="workflow-main join-page">
        <Link className="back-link" href="/">
          <ArrowLeft size={16} />
          Back to Home
        </Link>
        <div className="join-page-content">
          <h1>Join Meeting</h1>
          <p>Enter a meeting ID or invitation link to join.</p>
          <JoinForm onCancel={() => router.push("/")} />
        </div>
      </main>
    </WorkspaceShell>
  );
}

export function SchedulePage() {
  const router = useRouter();
  const notify = useToast();
  const [scheduled, setScheduled] = useState<Meeting | null>(null);
  return (
    <WorkspaceShell>
      <main className="workflow-main schedule-page">
        <div className="schedule-page-content">
          <Link className="back-link" href="/meetings">
            <ArrowLeft size={16} />
            Back to Meetings
          </Link>
          <h1>Schedule Meeting</h1>
          <ScheduleForm
            onCancel={() => router.push("/meetings")}
            onScheduled={(meeting) => {
              setScheduled(meeting);
              notify("Meeting scheduled successfully");
            }}
          />
        </div>
      </main>
      {scheduled && (
        <MeetingDetails
          meeting={scheduled}
          scheduled
          onClose={() => router.push("/meetings")}
        />
      )}
    </WorkspaceShell>
  );
}
