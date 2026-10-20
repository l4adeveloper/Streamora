const { randomBytes, randomUUID } = require("node:crypto");

class DemoError extends Error {}

async function runAuthDemo({
  apiUrl = "http://127.0.0.1:4000/api/v1",
  origin = "http://127.0.0.1:3000",
} = {}) {
  const base = new URL(apiUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new DemoError(
      "Demo cần API URL HTTP(S), không chứa thông tin đăng nhập hoặc query.",
    );
  const credentials = {
    email: `t01-demo-${randomUUID()}@example.test`,
    password: randomBytes(32).toString("base64url") + "A1!",
  };
  const steps = [];
  let cookie = "",
    token = "",
    active = false;
  async function request(
    path,
    expected,
    { method = "POST", body, bearer = false, requestOrigin = origin } = {},
  ) {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Origin: requestOrigin,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bearer ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    if (response.status !== expected)
      throw new DemoError(
        `${method} ${path}: cần status ${expected}, nhận ${response.status}.`,
      );
    const nextCookie = response.headers.get("set-cookie")?.split(";")[0];
    if (nextCookie) cookie = nextCookie;
    steps.push(`${method} ${path}: ${expected}`);
    return data;
  }
  try {
    await request("/auth/register", 201, {
      body: { ...credentials, fullName: "Người dùng demo T01" },
    });
    const duplicate = await request("/auth/register", 409, {
      body: { ...credentials, fullName: "Tên trùng email" },
    });
    if (duplicate.error?.code !== "EMAIL_EXISTS")
      throw new DemoError("Email trùng không trả EMAIL_EXISTS.");
    await request("/auth/login", 401, {
      body: { ...credentials, password: "Incorrect-test-password-123!" },
    });
    const login = await request("/auth/login", 200, { body: credentials });
    active = true;
    token = login.accessToken;
    if (!token || !cookie || login.user?.globalRole !== "USER")
      throw new DemoError("Login thiếu access/cookie hoặc sai role mặc định.");
    await request("/users/me", 200, { method: "GET", bearer: true });
    const fullName = "Họ tên demo đã cập nhật";
    const updated = await request("/users/me", 200, {
      method: "PATCH",
      bearer: true,
      body: { fullName },
    });
    if (updated.user?.fullName !== fullName)
      throw new DemoError("Họ tên Unicode chưa được lưu đúng.");
    const oldCookie = cookie;
    const refreshed = await request("/auth/refresh", 200);
    token = refreshed.accessToken;
    if (!token || cookie === oldCookie)
      throw new DemoError("Refresh chưa xoay cookie/cấp access token.");
    await request("/users/me", 200, { method: "GET", bearer: true });
    await request("/auth/logout", 204);
    active = false;
    await request("/users/me", 401, { method: "GET", bearer: true });
    await request("/auth/refresh", 401);
    const denied = await request("/auth/login", 403, {
      body: {},
      requestOrigin: "https://untrusted.example",
    });
    if (denied.error?.code !== "ORIGIN_NOT_ALLOWED")
      throw new DemoError("Origin không hợp lệ chưa bị chặn.");
    return { steps };
  } finally {
    if (active) {
      try {
        await request("/auth/logout", 204);
      } catch {
        /* Best effort on an interrupted demo. */
      }
    }
    token = "";
    cookie = "";
  }
}
if (require.main === module) {
  runAuthDemo({
    apiUrl: process.env.STREAMORA_DEMO_API_URL,
    origin: process.env.STREAMORA_DEMO_ORIGIN,
  })
    .then(({ steps }) => {
      for (const step of steps) console.log(`PASS ${step}`);
      console.log("DEMO_T01_OK");
    })
    .catch((error) => {
      console.error(
        error instanceof DemoError
          ? error.message
          : "Demo chưa hoàn tất. Kiểm tra API đang chạy, API URL, Origin và kết nối.",
      );
      process.exitCode = 1;
    });
}
module.exports = { runAuthDemo };
