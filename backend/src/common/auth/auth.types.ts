import type { User } from "@streamora/contracts";
import type { ApiRequest } from "../http-context";

export interface AuthenticatedIdentity {
  user: User;
  sessionId: string;
}
export interface AuthenticatedRequest extends ApiRequest {
  auth?: AuthenticatedIdentity;
}
