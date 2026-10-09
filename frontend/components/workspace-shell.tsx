"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode, type MouseEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleHelp,
  ContactRound,
  Globe2,
  Home,
  Info,
  Link2,
  Search,
  Settings,
  Video,
} from "lucide-react";
import { api } from "@/lib/api";
import { initials } from "@/lib/meetings";
import type { User } from "@/types";
import { Modal } from "./ui";
import { WorkplaceBrand } from "./workplace-brand";

export function WorkspaceShell({
  children,
  active = "meetings",
  user,
  loading = false,
  offline = false,
  query,
  onQueryChange,
  meeting = false,
  onNavigate,
}: {
  children: ReactNode;
  active?: "home" | "meetings";
  user?: User | null;
  loading?: boolean;
  offline?: boolean;
  query?: string;
  onQueryChange?: (value: string) => void;
  meeting?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const [profile, setProfile] = useState<User | null>(null);
  const [availability, setAvailability] = useState("connecting");
  const [dialog, setDialog] = useState<"profile" | "settings" | "help" | null>(
    null,
  );
  useEffect(() => {
    if (user !== undefined) return;
    let current = true;
    void api
      .user()
      .then((value) => {
        if (current) setProfile(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [user]);
  useEffect(() => {
    // All routes check database-backed health, including forms without dashboard data.
    let current = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        await api.health();
        if (current) setAvailability("available");
      } catch {
        if (current) setAvailability("offline");
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = setInterval(() => void check(), 15000);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
    };
  }, []);
  const unavailable = offline || availability === "offline";
  const connecting = loading || availability === "connecting";
  const organizer = user ?? profile;
  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (onNavigate) {
      event.preventDefault();
      onNavigate(href);
    }
  }
  return (
    <div className={`workspace ${meeting ? "workspace-in-call" : ""}`}>
      <a href="#workspace-content" className="skip-link">
        Skip to content
      </a>
      <header className="app-header">
        <Link
          className="wordmark"
          href="/"
          aria-label="Zoom Workplace Home"
          onClick={(event) => navigate(event, "/")}
        >
          <WorkplaceBrand />
        </Link>
        {!meeting && (
          <div className="header-history">
            <button
              className="icon-button"
              aria-label="Go back"
              onClick={() => window.history.back()}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Go forward"
              onClick={() => window.history.forward()}
            >
              <ArrowRight size={17} />
            </button>
          </div>
        )}
        {onQueryChange ? (
          <label className="header-search">
            <Search size={17} />
            <input
              aria-label="Search meetings"
              placeholder="Search meetings"
              value={query ?? ""}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <span className="search-hint">Meetings</span>
          </label>
        ) : (
          <Link
            href="/meetings"
            className="header-search search-link"
            onClick={(event) => navigate(event, "/meetings")}
          >
            <Search size={17} />
            <span>Search meetings</span>
          </Link>
        )}
        <div className="header-right">
          <span
            className={`connection-label ${unavailable ? "connection-offline" : connecting ? "connection-pending" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span />
            {unavailable
              ? "Offline"
              : connecting
                ? "Connecting"
                : meeting
                  ? "In a meeting"
                  : "Available"}
          </span>
          <button
            className="icon-button header-settings"
            aria-label="Open settings"
            onClick={() => setDialog("settings")}
          >
            <Settings size={20} />
          </button>
          <button
            className="profile-avatar"
            aria-label="Open profile"
            onClick={() => setDialog("profile")}
          >
            {initials(organizer?.name ?? "Organizer")}
            <span />
          </button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Main navigation">
        <nav>
          <Link
            className={`nav-item ${active === "home" && !meeting ? "nav-active" : ""}`}
            href="/"
            aria-current={active === "home" && !meeting ? "page" : undefined}
            onClick={(event) => navigate(event, "/")}
          >
            <Home size={21} />
            <span>Home</span>
          </Link>
          <Link
            className={`nav-item ${active === "meetings" && !meeting ? "nav-active" : ""}`}
            href="/meetings"
            aria-current={
              active === "meetings" && !meeting ? "page" : undefined
            }
            onClick={(event) => navigate(event, "/meetings")}
          >
            <Video size={21} />
            <span>Meetings</span>
          </Link>
          <button
            className="nav-item nav-disabled"
            disabled
            title="Contacts are not part of this workspace"
          >
            <ContactRound size={21} />
            <span>Contacts</span>
          </button>
          <button
            className="nav-item mobile-settings"
            onClick={() => setDialog("settings")}
          >
            <Settings size={21} />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setDialog("help")}>
            <CircleHelp size={21} />
            <span>Help</span>
          </button>
          <button className="nav-item" onClick={() => setDialog("settings")}>
            <Settings size={21} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <div className="workspace-content" id="workspace-content">
        {children}
      </div>
      {dialog === "profile" && (
        <Modal title="Your profile" onClose={() => setDialog(null)}>
          <div className="placeholder-content">
            <div className="large-avatar">
              {initials(organizer?.name ?? "Organizer")}
            </div>
            <h3>{organizer?.name ?? "Default organizer"}</h3>
            <p>{organizer?.email ?? "Profile unavailable"}</p>
            <div className="schedule-info">
              <Info size={18} />
              <span>
                This workspace uses a default organizer. Profile editing and
                login are not enabled.
              </span>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal
          title="Settings"
          subtitle="Workspace preferences"
          onClose={() => setDialog(null)}
        >
          <div className="placeholder-content settings-content">
            <div>
              <Globe2 size={20} />
              <span>
                Time zone
                <strong>
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}
                </strong>
              </span>
            </div>
            <div>
              <Video size={20} />
              <span>
                Audio & video
                <strong>Check your devices before joining a meeting.</strong>
              </span>
            </div>
            <p>
              Additional preferences are placeholders. Your browser manages
              camera and microphone permissions.
            </p>
          </div>
        </Modal>
      )}
      {dialog === "help" && (
        <Modal
          title="A little help getting started"
          onClose={() => setDialog(null)}
        >
          <div className="help-content">
            <p>
              <strong>New Meeting</strong> creates an instant room. Continue
              through the preview to connect audio and video.
            </p>
            <p>
              <strong>Join</strong> accepts an 11-digit ID or an invitation from
              this app. Enter your name before joining.
            </p>
            <p>
              <strong>Schedule</strong> saves a future meeting in your device’s
              timezone. Only the creating browser can start it.
            </p>
            <p>
              <strong>Start Meeting</strong> also gives this browser host access
              to an unclaimed sample meeting. Each sample can be claimed once.
            </p>
            <p className="form-note">
              <Link2 size={17} />
              Use Copy Invitation to invite someone in a different browser.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
