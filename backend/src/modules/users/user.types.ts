export type { User as PublicUser } from "@streamora/contracts";
export type {
  AuthenticatedIdentity,
  AuthenticatedRequest,
} from "../../common/auth/auth.types";

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  globalRole: true,
} as const;
