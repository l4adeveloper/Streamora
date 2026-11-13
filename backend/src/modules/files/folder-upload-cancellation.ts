import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";
// A wake-up hint only. ABORTING in PostgreSQL is the durable source of truth.
@Injectable()
export class FolderUploadCancellation {
  private readonly events = new EventEmitter();
  subscribe(listener: () => void) {
    this.events.on("cancel", listener);
    return () => {
      this.events.off("cancel", listener);
    };
  }
  requestCleanup() {
    this.events.emit("cancel");
  }
}
