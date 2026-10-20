"use client";
// Copied into the isolated test build only.
import { useState } from "react";
export default function CrashProbe() {
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error("PRIVATE_ERROR_SAMPLE_DO_NOT_RENDER");
  return <button onClick={() => setCrash(true)}>Tạo lỗi render</button>;
}
