// Public server-side integration surface for the next tasks.
export { ClassSessionsModule } from "./class-sessions.module";
export {
  ClassParticipantService,
  type ClassSessionActor,
} from "./class-participant.service";
export {
  ClassParticipantGuard,
  RequireClassParticipation,
  CurrentClassParticipant,
} from "./class-participant.guard";
export { ClassSessionEventsModule } from "./class-session-events.module";
export {
  ClassSessionEventsService,
  type ClassSessionEndedHandler,
} from "./class-session-events.service";
