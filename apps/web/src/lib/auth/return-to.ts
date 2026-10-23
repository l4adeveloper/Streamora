/** Only the protected T04 destinations can be carried through the login form. */
export function safeReturnTo(value: string | null) {
  const uuid =
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  return value &&
    new RegExp(
      `^/(meet(?:/[a-zA-Z0-9]{12})?|sessions/${uuid}|groups/${uuid}/sessions)$`,
    ).test(value)
    ? value
    : "/workspace";
}
