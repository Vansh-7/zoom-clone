import type { Reaction } from "@/types";

export const reactions: { type: Reaction; label: string; emoji: string }[] = [
  { type: "clap", label: "Clap", emoji: "👏" },
  { type: "thumbs_up", label: "Thumbs Up", emoji: "👍" },
  { type: "laugh", label: "Laugh", emoji: "😂" },
  { type: "surprised", label: "Surprised", emoji: "😮" },
  { type: "heart", label: "Heart", emoji: "❤️" },
  { type: "celebrate", label: "Celebrate", emoji: "🎉" },
];
