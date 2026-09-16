import type { Command } from "@whale-cal/shared/protocol";
import type { CalendarDatabase } from "@whale-cal/shared/types";
import { ApiError, type Principal } from "./auth";

export function authorize(user: Principal, command: Command, db: CalendarDatabase): void {
  const own = (owner: string | undefined) => {
    if ((owner ?? "local") !== user.id) throw new ApiError("Only the owner can modify this calendar or group.", "forbidden");
  };
  const calendar = (id?: string) => {
    const item = id === undefined ? db.calendars.find(c => (c.ownerUserId ?? "local") === user.id) : db.calendars.find(c => c.id === id);
    if (!item) throw new ApiError("Calendar not found. Create your own calendar first.");
    own(item.ownerUserId);
  };
  const group = (id: string) => {
    const item = db.groups?.find(g => g.id === id);
    if (!item) throw new ApiError("Calendar group not found.");
    own(item.ownerUserId);
  };
  switch (command.type) {
    case "restart_daemon": case "create_user": case "create_token": case "revoke_token": case "list_tokens": case "assign_owner":
      if (!user.admin) throw new ApiError("Administrator permission required.", "forbidden");
      return;
    case "create_event": calendar(command.event.calendarId); return;
    case "update_event": case "complete_event": case "delete_event": {
      const item = db.events.find(e => e.id === command.id);
      if (!item) throw new ApiError("Event not found.");
      calendar(item.calendarId);
      if (command.type === "update_event" && command.patch.calendarId !== undefined) calendar(command.patch.calendarId);
      return;
    }
    case "create_calendar":
      if (command.groupId) group(command.groupId);
      return;
    case "update_calendar":
      calendar(command.id);
      if (command.patch.groupId) group(command.patch.groupId);
      return;
    case "delete_calendar": calendar(command.id); return;
    case "update_group": case "delete_group": group(command.id); return;
  }
}
