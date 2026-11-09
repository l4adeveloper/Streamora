import { Module } from "@nestjs/common";
import { IvsEventsService } from "./ivs-events.service";
@Module({ providers: [IvsEventsService], exports: [IvsEventsService] })
export class IvsEventsModule {}
