// Public entry point for client-side feature modules. Auth mutations stay in useAuth.
import "client-only";
import type { AuthRequestOptions } from "./auth/api";
export type ApiRequestOptions = Omit<AuthRequestOptions, "token">;
export { authenticatedRequest as apiRequest } from "./auth/session";
export {
  AuthApiError as ApiError,
  asAuthError as asApiError,
} from "./auth/api";
