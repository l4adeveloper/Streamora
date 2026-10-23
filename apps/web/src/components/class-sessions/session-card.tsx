import Link from "next/link";
import { CalendarDays, ArrowUpRight } from "lucide-react";
import type { ClassSession, ClassSessionStatus } from "@streamora/contracts";
import {
  statusLabels,
  displayTime,
  sessionHref,
} from "@/lib/class-sessions/display";
export function SessionStatus({ status }: { status: ClassSessionStatus }) {
  return (
    <span className={`class-status ${status.toLowerCase()}`}>
      {statusLabels[status]}
    </span>
  );
}
export function SessionCard({ session }: { session: ClassSession }) {
  return (
    <article className="class-session-card">
      <div className="class-row">
        <SessionStatus status={session.status} />
        <span className="class-muted">
          {session.kind === "GROUP" ? "Buổi học của nhóm" : "Meet độc lập"}
        </span>
      </div>
      <h3>
        <Link href={sessionHref(session)}>{session.title}</Link>
      </h3>
      {session.description && <p>{session.description}</p>}
      <div className="class-row class-muted">
        <CalendarDays size={16} aria-hidden="true" />
        <span>{displayTime(session.scheduledAt)}</span>
      </div>
      <Link className="button secondary" href={sessionHref(session)}>
        Mở {session.kind === "GROUP" ? "buổi học" : "cuộc họp"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
    </article>
  );
}
