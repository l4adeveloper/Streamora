import { Module } from "@nestjs/common";
import { ClassSessionEventsService } from "./class-session-events.service";

/** A worker can import this module without starting auth/media/socket gateways. */
@Module({
  providers: [ClassSessionEventsService],
  exports: [ClassSessionEventsService],
})
export class ClassSessionEventsModule {}
