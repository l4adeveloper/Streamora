"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Crown, Plus, Search, Trash2, Users } from "lucide-react";
import type {
  AssignableRole,
  GroupPermissions,
  Membership,
} from "@streamora/contracts";
import { ApiError, asApiError } from "@/lib/api";
import {
  addMember,
  changeMemberRole,
  listMembers,
  lookupMember,
  removeMember,
} from "@/lib/memberships/api";
import { useToast } from "@/components/common/toast-provider";
import {
  InlineNotice,
  LoadingState,
  RequestError,
  SubmitButton,
} from "@/components/common/feedback";
import "./memberships.css";

export function MembersPanel({
  groupId,
  permissions,
  revision = 0,
  allowManagement = false,
}: {
  groupId: string;
  permissions: GroupPermissions;
  revision?: number;
  allowManagement?: boolean;
}) {
  const canManage = allowManagement && permissions.canManageMembers;
  const { notify } = useToast();
  const [members, setMembers] = useState<Membership[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("VIEWER");
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Membership | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setMoreLoading(false);
    setError(null);
    try {
      const page = await listMembers(groupId, { q: queryRef.current.trim() });
      if (request !== sequence.current || !alive.current) return;
      setMembers(page.items);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (request === sequence.current && alive.current) setError(cause);
    } finally {
      if (request === sequence.current && alive.current) setLoading(false);
    }
  }, [groupId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 300 : 0);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [query, load, revision]);
  async function loadMore() {
    if (!cursor || loading || moreLoading) return;
    const request = ++sequence.current;
    setMoreLoading(true);
    setError(null);
    try {
      const page = await listMembers(groupId, {
        q: queryRef.current.trim(),
        cursor,
      });
      if (request !== sequence.current || !alive.current) return;
      setMembers((current) => [
        ...current,
        ...page.items.filter(
          (item) => !current.some((member) => member.userId === item.userId),
        ),
      ]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (request === sequence.current && alive.current) setError(cause);
    } finally {
      if (request === sequence.current && alive.current) setMoreLoading(false);
    }
  }
  async function act(
    id: string,
    work: () => Promise<unknown>,
    success: string,
  ) {
    if (pending || !canManage) return;
    setPending(id);
    setActionError("");
    try {
      await work();
      if (!alive.current) return;
      notify(success, { tone: "success" });
      setRemoving(null);
      if (id === "add") setEmail("");
      await load();
    } catch (cause) {
      if (alive.current) setActionError(asApiError(cause).message);
    } finally {
      if (alive.current) setPending(null);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void act(
      "add",
      async () => {
        const found = await lookupMember(groupId, email.trim().toLowerCase());
        if (!found.user)
          throw new ApiError(
            404,
            "USER_NOT_FOUND",
            "Không tồn tại người dùng với email này.",
          );
        await addMember(groupId, found.user.id, role);
      },
      "Đã thêm thành viên vào nhóm.",
    );
  }
  return (
    <section
      className="membership-panel"
      aria-label={canManage ? "Quản lý thành viên" : "Danh sách thành viên"}
    >
      <div className="membership-heading">
        <span className="membership-icon">
          <Users size={22} />
        </span>
        <div>
          <h2>Thành viên</h2>
          <p>Cùng học tập trong không gian của nhóm.</p>
        </div>
      </div>
      <label className="membership-search">
        <Search size={17} aria-hidden="true" />
        <input
          aria-label="Tìm thành viên theo tên hoặc email"
          placeholder="Tìm theo tên hoặc email…"
          maxLength={254}
          value={query}
          onChange={(event) => {
            sequence.current++;
            queryRef.current = event.target.value;
            setQuery(event.target.value);
            setLoading(true);
            setCursor(null);
          }}
        />
      </label>
      {canManage && (
        <form className="membership-add" onSubmit={submit}>
          <h3>
            <Plus size={16} /> Thêm thành viên
          </h3>
          <label>
            Email đã đăng ký
            <input
              aria-label="Email thành viên mới"
              type="email"
              required
              maxLength={254}
              placeholder="ten@vidu.com"
              value={email}
              disabled={Boolean(pending)}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className="membership-add-actions">
            <label>
              Vai trò
              <select
                aria-label="Vai trò thành viên mới"
                value={role}
                disabled={Boolean(pending)}
                onChange={(event) =>
                  setRole(event.target.value as AssignableRole)
                }
              >
                <option value="VIEWER">Viewer</option>
                <option value="HOST">Host</option>
              </select>
            </label>
            <SubmitButton
              pending={pending === "add"}
              disabled={Boolean(pending)}
            >
              Thêm thành viên
            </SubmitButton>
          </div>
        </form>
      )}
      {actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}
      {loading ? (
        <LoadingState message="Đang tải thành viên…" />
      ) : error ? (
        <RequestError error={error} onRetry={load} />
      ) : (
        <>
          <div className="membership-list" aria-live="polite">
            {members.length === 0 && (
              <div className="membership-empty">
                <Users size={28} />
                <h3>Không tìm thấy thành viên</h3>
                <p>Thử một tên hoặc địa chỉ email khác.</p>
              </div>
            )}
            {members.map((member) => (
              <article className="membership-row" key={member.userId}>
                <span className="membership-avatar" aria-hidden="true">
                  {member.fullName
                    .trim()
                    .split(/\s+/)
                    .slice(-2)
                    .map((part) => part[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <div className="membership-person">
                  <b title={member.fullName}>{member.fullName}</b>
                  <small title={member.email}>{member.email}</small>
                  <span
                    className={`membership-role role-${member.role.toLowerCase()}`}
                  >
                    {member.role === "OWNER" && <Crown size={12} />}
                    {member.role === "OWNER"
                      ? "Owner"
                      : member.role === "HOST"
                        ? "Host"
                        : "Viewer"}
                  </span>
                  {canManage && member.role !== "OWNER" && (
                    <div className="membership-controls">
                      <select
                        aria-label={`Vai trò của ${member.fullName}`}
                        value={member.role}
                        disabled={Boolean(pending)}
                        onChange={(event) =>
                          void act(
                            member.userId,
                            () =>
                              changeMemberRole(
                                groupId,
                                member.userId,
                                event.target.value as AssignableRole,
                              ),
                            `Đã đổi vai trò của ${member.fullName}.`,
                          )
                        }
                      >
                        <option value="VIEWER">Viewer</option>
                        <option value="HOST">Host</option>
                      </select>
                      <button
                        type="button"
                        className="membership-remove"
                        aria-label={`Xóa ${member.fullName} khỏi nhóm`}
                        disabled={Boolean(pending)}
                        onClick={() => {
                          setRemoving(member);
                          setActionError("");
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          {cursor && (
            <button
              type="button"
              className="button secondary membership-more"
              disabled={moreLoading}
              onClick={() => void loadMore()}
            >
              {moreLoading ? "Đang tải…" : "Xem thêm thành viên"}
            </button>
          )}
        </>
      )}
      {removing && canManage && (
        <div
          className="membership-confirm"
          role="alertdialog"
          aria-label="Xác nhận xóa thành viên"
          aria-describedby="membership-remove-description"
        >
          <p id="membership-remove-description">
            Xóa <b>{removing.fullName}</b> khỏi nhóm? Người này sẽ mất quyền vào
            lớp, xem tài liệu và bản ghi.
          </p>
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(pending)}
              onClick={() => setRemoving(null)}
            >
              Hủy
            </button>
            <button
              type="button"
              className="button membership-danger"
              disabled={Boolean(pending)}
              onClick={() =>
                void act(
                  removing.userId,
                  () => removeMember(groupId, removing.userId),
                  "Đã xóa thành viên và thu hồi quyền truy cập.",
                )
              }
            >
              {pending ? "Đang xóa…" : "Xác nhận xóa"}
            </button>
          </div>
        </div>
      )}
      {allowManagement && !permissions.canManageMembers && (
        <p className="membership-footnote">
          Chỉ chủ nhóm và quản trị viên được thêm, xóa hoặc đổi vai trò thành
          viên.
        </p>
      )}
    </section>
  );
}

export function NoGroupSelected() {
  return (
    <div className="membership-empty">
      <Users size={30} />
      <h2>Chọn nhóm học tập</h2>
      <p>Tạo hoặc tham gia nhóm để xem thành viên.</p>
      <Link className="button primary" href="/groups">
        Nhóm học tập
      </Link>
    </div>
  );
}
