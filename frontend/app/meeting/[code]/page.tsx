import { MeetingRoom } from "@/components/meeting-room";
export default async function MeetingPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <MeetingRoom code={code} />;
}
