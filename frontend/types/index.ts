export interface User {
  id: number;
  name: string;
  email: string;
}
export interface Meeting {
  meeting_code: string;
  title: string;
  description: string;
  kind: "instant" | "scheduled";
  status: "scheduled" | "in_progress" | "ended" | "missed";
  host_name: string;
  scheduled_at: string | null;
  scheduled_timezone: string;
  duration_minutes: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  invite_url: string;
  can_claim: boolean;
}
export interface CreatedMeeting {
  meeting: Meeting;
  host_token: string;
}
export interface Participant {
  id: number;
  display_name: string;
  role: "host" | "guest";
  audio_enabled?: boolean;
  video_enabled?: boolean;
}
export interface Admission {
  participant: Participant;
  participant_token: string;
  meeting: Meeting;
}
export interface ScheduleInput {
  title: string;
  description: string;
  scheduled_at: string;
  scheduled_timezone: string;
  duration_minutes: number;
}
export interface RtcConfig {
  ice_servers: RTCIceServer[];
  max_participants: number;
}
