"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { BarChart3, Plus, X } from "lucide-react";
import { CLASS_POLL_LIMITS as limits } from "@streamora/contracts";
import type {
  ClassPoll,
  ClassPollResponse,
  ClassPollUpdated,
} from "@streamora/contracts";
import {
  InlineNotice,
  LoadingState,
  RequestError,
} from "@/components/common/feedback";
import { asApiError } from "@/lib/api";
import {
  closeClassPoll,
  createClassPoll,
  listClassPolls,
  voteClassPoll,
} from "@/lib/class-sessions/api";
import { useCursorList } from "@/lib/class-sessions/use-cursor-list";

type PollListener = (event: ClassPollUpdated) => void;
type Update = {
  publicPoll: ClassPollUpdated;
  choice?: { optionId: string | null; version: string };
  created: boolean;
};

export function ClassPolls({
  sessionId,
  canManage,
  live,
  revision,
  listener,
}: {
  sessionId: string;
  canManage: boolean;
  live: boolean;
  revision: number;
  listener: RefObject<PollListener | null>;
}) {
  const load = useCallback(
    (cursor?: string) => listClassPolls(sessionId, cursor),
    [sessionId],
  );
  const list = useCursorList(load, revision);
  const [updates, setUpdates] = useState(new Map<string, Update>());
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);

  const apply = useCallback(
    (event: ClassPollUpdated, optionId?: string | null) => {
      setUpdates((current) => {
        const before = current.get(event.pollId);
        const version = BigInt(event.version);
        const fresh = !before || version > BigInt(before.publicPoll.version);
        const choice =
          optionId !== undefined &&
          (!before?.choice || version >= BigInt(before.choice.version))
            ? { optionId, version: event.version }
            : before?.choice;
        const created = event.version === "1" || !!before?.created;
        if (!fresh && choice === before?.choice && created === before?.created)
          return current;
        const next = new Map(current);
        next.set(event.pollId, {
          publicPoll: fresh ? event : before.publicPoll,
          choice,
          created,
        });
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    listener.current = apply;
    return () => {
      listener.current = null;
    };
  }, [listener, apply]);

  function merge(base: ClassPoll | undefined, update: Update): ClassPoll {
    const { pollId, ...result } = update.publicPoll;
    const poll =
      !base || BigInt(result.version) > BigInt(base.version)
        ? { ...result, id: pollId }
        : base;
    const choice = update.choice;
    const myOptionId =
      choice && (!base || BigInt(choice.version) >= BigInt(base.version))
        ? choice.optionId
        : (base?.myOptionId ?? null);
    return { ...poll, myOptionId };
  }

  const listed = new Set(list.items.map(({ id }) => id));
  const recent = [...updates.values()].filter(
    ({ created, publicPoll }) => created && !listed.has(publicPoll.pollId),
  );
  const items = [
    ...recent.reverse().map((update) => merge(undefined, update)),
    ...list.items.map((poll) => {
      const update = updates.get(poll.id);
      return update ? merge(poll, update) : poll;
    }),
  ];

  async function run(key: string, work: () => Promise<ClassPollResponse>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      const {
        poll: { id, myOptionId, ...result },
      } = await work();
      apply({ ...result, pollId: id }, myOptionId);
      if (key === "create") {
        setCreating(false);
        setQuestion("");
        setOptions(["", ""]);
      }
    } catch (failure) {
      setError(failure);
      if (asApiError(failure).code === "POLL_CLOSED") void list.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="class-panel class-polls"
      aria-label="Bình chọn trong buổi học"
    >
      <div className="class-toolbar">
        <h2>
          <BarChart3 size={19} /> Bình chọn
        </h2>
        {canManage && live && !creating && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => setCreating(true)}
          >
            <Plus size={16} /> Tạo bình chọn
          </button>
        )}
      </div>
      {canManage && live && creating && (
        <form
          className="class-poll-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run("create", () =>
              createClassPoll(sessionId, {
                question: question.trim(),
                options: options.map((text) => ({ text: text.trim() })),
              }),
            );
          }}
        >
          <label>
            Câu hỏi
            <input
              required
              maxLength={limits.maxQuestionLength}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          {options.map((text, index) => (
            <div className="class-poll-input" key={index}>
              <label>
                Lựa chọn {index + 1}
                <input
                  required
                  maxLength={limits.maxOptionLength}
                  value={text}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOptions((current) =>
                      current.map((item, i) => (i === index ? value : item)),
                    );
                  }}
                />
              </label>
              {options.length > limits.minOptions && (
                <button
                  type="button"
                  className="button secondary compact"
                  aria-label={`Xóa lựa chọn ${index + 1}`}
                  onClick={() =>
                    setOptions((current) =>
                      current.filter((_, i) => i !== index),
                    )
                  }
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          <div className="class-actions">
            <button
              type="submit"
              className="button primary compact"
              disabled={
                !!pending ||
                !question.trim() ||
                options.some((option) => !option.trim())
              }
            >
              Mở bình chọn
            </button>
            {options.length < limits.maxOptions && (
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setOptions((current) => [...current, ""])}
              >
                Thêm lựa chọn
              </button>
            )}
            <button
              type="button"
              className="button secondary compact"
              disabled={pending === "create"}
              onClick={() => setCreating(false)}
            >
              Hủy
            </button>
          </div>
        </form>
      )}
      {!!error && <RequestError error={error} />}
      {!!list.error && (
        <RequestError error={list.error} onRetry={list.refresh} />
      )}
      {list.loading && !items.length && (
        <LoadingState message="Đang tải bình chọn…" />
      )}
      {!list.loading && !list.error && !items.length && (
        <InlineNotice>Chưa có bình chọn.</InlineNotice>
      )}
      {items.map((poll) => (
        <article key={poll.id} className="class-poll">
          <div className="class-toolbar">
            <h3>{poll.question}</h3>
            <span className="class-muted">
              {poll.status === "OPEN" ? "Đang mở" : "Đã đóng"} ·{" "}
              {poll.totalVotes} phiếu
            </span>
          </div>
          <ul>
            {poll.options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={poll.myOptionId === option.id}
                  disabled={!live || poll.status !== "OPEN" || !!pending}
                  onClick={() =>
                    void run(poll.id, () => voteClassPoll(poll.id, option.id))
                  }
                >
                  <span>
                    {option.text}
                    {poll.myOptionId === option.id && (
                      <small> · Phiếu của bạn</small>
                    )}
                  </span>
                  <strong>{option.count} phiếu</strong>
                </button>
              </li>
            ))}
          </ul>
          {canManage && live && poll.status === "OPEN" && (
            <button
              type="button"
              className="button secondary compact"
              disabled={!!pending}
              onClick={() => void run(poll.id, () => closeClassPoll(poll.id))}
            >
              Đóng bình chọn
            </button>
          )}
        </article>
      ))}
      {list.cursor && (
        <button
          type="button"
          className="button secondary compact"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          Xem thêm bình chọn
        </button>
      )}
    </section>
  );
}
