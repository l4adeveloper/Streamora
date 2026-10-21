const { randomBytes, randomUUID } = require("node:crypto");

class DemoError extends Error {}

async function runGroupsDemo({
  apiUrl = "http://127.0.0.1:4000/api/v1",
  origin = "http://127.0.0.1:3000",
} = {}) {
  const base = new URL(apiUrl);
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new DemoError("Demo cần API URL HTTP(S).");
  }

  const credentials = {
    email: `t02-demo-${randomUUID()}@example.test`,
    password: randomBytes(32).toString("base64url") + "A1!",
    fullName: "Sinh viên Demo T02",
  };

  const steps = [];
  let token = "";

  async function api(path, expected, { method = "GET", body, idempotencyKey } = {}) {
    const headers = {
      Origin: origin,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    if (response.status !== expected) {
      throw new DemoError(
        `${method} ${path}: cần status ${expected}, nhận ${response.status} (${JSON.stringify(data)})`,
      );
    }
    steps.push(`${method} ${path}: ${expected}`);
    return data;
  }

  try {
    // 1. Đăng ký & đăng nhập lấy Access Token
    await api("/auth/register", 201, { method: "POST", body: credentials });
    const login = await api("/auth/login", 200, {
      method: "POST",
      body: { email: credentials.email, password: credentials.password },
    });
    token = login.accessToken;

    // 2. T02-01: Tạo nhóm học tập
    const idempotencyKey = `demo-${randomUUID()}`;
    const createRes = await api("/groups", 201, {
      method: "POST",
      idempotencyKey,
      body: {
        name: "Nhóm Điện toán đám mây K69 Demo",
        description: "Thực hành bài tập lớn môn Điện toán đám mây",
      },
    });
    const groupId = createRes.group.id;
    if (!groupId || createRes.group.name !== "Nhóm Điện toán đám mây K69 Demo") {
      throw new DemoError("Tạo nhóm không trả đúng thông tin contract Group.");
    }

    // 3. T02-01: Kiểm tra tính Idempotent với cùng Idempotency-Key
    const repeatCreate = await api("/groups", 201, {
      method: "POST",
      idempotencyKey,
      body: { name: "Nhóm Điện toán đám mây K69 Demo" },
    });
    if (repeatCreate.group.id !== groupId) {
      throw new DemoError("Idempotency-Key không trả đúng nhóm đã tạo trước đó.");
    }

    // 4. T02-02: Danh sách nhóm
    const listRes = await api("/groups?limit=5", 200, { method: "GET" });
    if (!listRes.items.some((g) => g.id === groupId)) {
      throw new DemoError("Nhóm vừa tạo không xuất hiện trong danh sách.");
    }

    // 5. T02-03: Chi tiết nhóm
    const detailRes = await api(`/groups/${groupId}`, 200, { method: "GET" });
    if (detailRes.group.id !== groupId) {
      throw new DemoError("Không lấy được chi tiết nhóm.");
    }

    // 6. T02-04: Sửa nhóm
    const updatedName = "Nhóm Điện toán đám mây K69 (Đã đổi tên)";
    const updateRes = await api(`/groups/${groupId}`, 200, {
      method: "PATCH",
      body: { name: updatedName },
    });
    if (updateRes.group.name !== updatedName) {
      throw new DemoError("Cập nhật tên nhóm không thành công.");
    }

    // 7. T02-05: Xóa mềm nhóm
    await api(`/groups/${groupId}`, 204, { method: "DELETE" });

    // 8. Xác minh xóa mềm: không còn trong danh sách & GET trả 404
    const listAfterDelete = await api("/groups", 200, { method: "GET" });
    if (listAfterDelete.items.some((g) => g.id === groupId)) {
      throw new DemoError("Nhóm bị xóa mềm vẫn còn xuất hiện trong danh sách hoạt động.");
    }

    await api(`/groups/${groupId}`, 404, { method: "GET" });

    return { steps };
  } finally {
    token = "";
  }
}

if (require.main === module) {
  runGroupsDemo({
    apiUrl: process.env.STREAMORA_DEMO_API_URL,
    origin: process.env.STREAMORA_DEMO_ORIGIN,
  })
    .then(({ steps }) => {
      for (const step of steps) console.log(`PASS ${step}`);
      console.log("DEMO_T02_OK");
    })
    .catch((error) => {
      console.error(
        error instanceof DemoError
          ? error.message
          : `Lỗi khi chạy demo T02: ${error.message || error}`,
      );
      process.exitCode = 1;
    });
}

module.exports = { runGroupsDemo };
