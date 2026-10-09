"use client";

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/meetings";
import { Spinner, useToast } from "./ui";

export function CalendarButton({ code }: { code: string }) {
  const [pending, setPending] = useState(false);
  const notify = useToast();
  async function download() {
    setPending(true);
    try {
      const file = await api.calendar(code);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `meeting-${code}.ics`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Calendar invitation downloaded");
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <button
      className="button secondary"
      disabled={pending}
      onClick={() => void download()}
    >
      {pending ? <Spinner size={16} /> : <CalendarPlus size={16} />}Add to
      Calendar
    </button>
  );
}
