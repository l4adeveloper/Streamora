import { Injectable, ParseUUIDPipe } from "@nestjs/common";
import { ApiError } from "../api-error";

@Injectable()
export class UUIDParamPipe extends ParseUUIDPipe {
  constructor() {
    super({
      exceptionFactory: () =>
        new ApiError(400, "VALIDATION_ERROR", "ID không hợp lệ.", {
          fields: [
            {
              field: "id",
              code: "INVALID_ID",
              message: "ID phải là UUID hợp lệ.",
            },
          ],
        }),
    });
  }
}
