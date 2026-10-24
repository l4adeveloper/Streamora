export const AUTH_CONSTRAINTS = Object.freeze({
  emailMaxLength: 254,
  fullNameMinLength: 1,
  fullNameMaxLength: 100,
  passwordMinLength: 12,
  passwordMaxLength: 128,
});

export type GlobalRole = "USER" | "ADMIN";
export type GroupRole = "OWNER" | "HOST" | "VIEWER";

export interface User {
  id: string;
  email: string;
  fullName: string;
  globalRole: GlobalRole;
}

export interface RegisterRequest {
  email: string;
  password: string;
  fullName: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface UpdateProfileRequest {
  fullName: string;
}
export interface UserResponse {
  user: User;
}
export type RegisterResponse = UserResponse;
export interface AccessTokenResponse {
  accessToken: string;
  /** Seconds remaining, never milliseconds. */
  expiresIn: number;
}
export interface LoginResponse extends AccessTokenResponse {
  user: User;
}
export type RefreshResponse = AccessTokenResponse;
/** HTTP 204: no JSON body. */
export type LogoutResponse = void;
