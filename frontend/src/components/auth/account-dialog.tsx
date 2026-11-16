"use client";

import { AccountDetails } from "./account-page";
import { ModalDialog } from "@/components/common/modal-dialog";
import "./auth.css";
import "./account-dialog.css";

export function AccountDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog
      title="Tài khoản của bạn"
      description="Quản lý thông tin cá nhân ngay trong không gian học tập."
      className="account-dialog"
      onClose={onClose}
    >
      <AccountDetails />
    </ModalDialog>
  );
}
