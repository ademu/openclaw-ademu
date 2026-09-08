// Sender roles (design decision 5). ONE function decides who the sender is to this agent; it is the
// seam for a future `contact` tier (Contacts/authority arc). Today: the owner, or anyone else.
import { normalizeId } from "./grammar.js";

export type SenderRole = "owner" | "other";

export function resolveSenderRole(senderUserId: string, ownerUserId: string | undefined): SenderRole {
  if (!ownerUserId) return "other";
  return normalizeId(senderUserId) === normalizeId(ownerUserId) ? "owner" : "other";
}
