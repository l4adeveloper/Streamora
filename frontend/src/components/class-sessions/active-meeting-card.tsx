"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, LoaderCircle, PhoneOff, Video } from "lucide-react";

type Position = { x: number; y: number };

function currentPosition(card: HTMLElement): Position {
  return { x: card.offsetLeft, y: card.offsetTop };
}

function constrain(card: HTMLElement, position: Position): Position {
  const parent = card.offsetParent as HTMLElement;
  const margin = 16;
  return {
    x: Math.max(
      margin,
      Math.min(position.x, parent.clientWidth - card.offsetWidth - margin),
    ),
    y: Math.max(
      margin,
      Math.min(position.y, parent.clientHeight - card.offsetHeight - margin),
    ),
  };
}

export function ActiveMeetingCard({
  title,
  leaving,
  onReturn,
  onLeave,
}: {
  title: string;
  leaving: boolean;
  onReturn: () => void;
  onLeave: () => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const positionRef = useRef<Position | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    start: Position;
    origin: Position;
  } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const move = useCallback((next: Position) => {
    const card = cardRef.current;
    if (!card) return;
    const bounded = constrain(card, next);
    if (
      bounded.x === positionRef.current?.x &&
      bounded.y === positionRef.current?.y
    )
      return;
    positionRef.current = bounded;
    setPosition(bounded);
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !card.offsetParent) return;
    const observer = new ResizeObserver(() => {
      move(positionRef.current ?? currentPosition(card));
    });
    observer.observe(card);
    observer.observe(card.offsetParent);
    return () => observer.disconnect();
  }, [move]);

  function stopDragging() {
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <aside
      ref={cardRef}
      className="active-meeting-banner"
      aria-label="Cuộc họp đang diễn ra"
      style={
        position
          ? { left: position.x, top: position.y, right: "auto", bottom: "auto" }
          : undefined
      }
    >
      <button
        type="button"
        className="active-meeting-banner-left"
        aria-label="Di chuyển thông báo cuộc họp"
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        title="Kéo để di chuyển hoặc dùng các phím mũi tên"
        data-dragging={dragging || undefined}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || !cardRef.current)
            return;
          dragRef.current = {
            pointerId: event.pointerId,
            start: { x: event.clientX, y: event.clientY },
            origin: currentPosition(cardRef.current),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          move({
            x: drag.origin.x + event.clientX - drag.start.x,
            y: drag.origin.y + event.clientY - drag.start.y,
          });
        }}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={stopDragging}
        onKeyDown={(event) => {
          const direction = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          }[event.key];
          if (!direction || !cardRef.current) return;
          event.preventDefault();
          const current = currentPosition(cardRef.current);
          const step = event.shiftKey ? 48 : 16;
          move({
            x: current.x + direction[0] * step,
            y: current.y + direction[1] * step,
          });
        }}
      >
        <span className="live-meeting-indicator" />
        <span className="active-meeting-title" role="status">
          Đang trong cuộc họp: <strong>{title}</strong>
        </span>
        <GripVertical size={18} aria-hidden="true" />
      </button>
      <div className="active-meeting-banner-actions">
        <button
          type="button"
          className="button primary compact"
          onClick={onReturn}
          disabled={leaving}
        >
          <Video size={14} /> Quay lại cuộc họp
        </button>
        <button
          type="button"
          className="button danger compact"
          onClick={onLeave}
          disabled={leaving}
          aria-busy={leaving}
          title="Rời phòng họp"
        >
          {leaving ? (
            <LoaderCircle size={14} className="ui-spinner" aria-hidden="true" />
          ) : (
            <PhoneOff size={14} aria-hidden="true" />
          )}
          {leaving ? "Đang rời…" : "Rời phòng"}
        </button>
      </div>
    </aside>
  );
}
