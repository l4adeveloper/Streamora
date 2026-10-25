"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const controls = [
  ".button",
  ".icon-button",
  ".device-button",
  ".round-control",
  ".auth-tabs > button",
  ".file-filters > button",
  ".chat-form button",
  ".community-icon",
  ".add-community",
  ".channel",
  ".form-password-toggle",
  ".membership-remove",
  ".back-to-live",
].join(",");

/** A transient state layer; handlers, React-owned children and layout stay intact. */
export function InteractionFeedback() {
  const pathname = usePathname();

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const layers = new Map<HTMLElement, Animation>();
    const clear = () => {
      for (const [layer, animation] of layers) {
        animation.cancel();
        layer.remove();
      }
      layers.clear();
    };

    function respond(event: PointerEvent | KeyboardEvent) {
      if (preference.matches || !(event.target instanceof Element)) return;
      if (
        event instanceof PointerEvent &&
        (event.button !== 0 || !event.isPrimary)
      )
        return;
      if (
        event instanceof KeyboardEvent &&
        (event.repeat || !["Enter", " "].includes(event.key))
      )
        return;
      const control = event.target.closest<HTMLElement>(controls);
      if (!control || control.matches(":disabled, [aria-disabled='true']"))
        return;
      const bounds = control.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const style = getComputedStyle(control);
      const layer = document.createElement("span");
      layer.className = "interaction-feedback";
      layer.setAttribute("aria-hidden", "true");
      Object.assign(layer.style, {
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        borderRadius: style.borderRadius,
        color: style.color,
      });
      const ink = document.createElement("span");
      const diameter = Math.hypot(bounds.width, bounds.height) * 2;
      const pointer = event instanceof PointerEvent;
      Object.assign(ink.style, {
        width: `${diameter}px`,
        height: `${diameter}px`,
        left: `${(pointer ? event.clientX - bounds.left : bounds.width / 2) - diameter / 2}px`,
        top: `${(pointer ? event.clientY - bounds.top : bounds.height / 2) - diameter / 2}px`,
      });
      layer.append(ink);
      document.body.append(layer);
      const animation = ink.animate(
        [
          { transform: "scale(0.12)", opacity: 0.12 },
          { transform: "scale(1)", opacity: 0 },
        ],
        { duration: 360, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
      layers.set(layer, animation);
      const remove = () => {
        layer.remove();
        layers.delete(layer);
      };
      void animation.finished.then(remove, remove);
    }
    document.addEventListener("pointerdown", respond, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", respond, true);
    preference.addEventListener("change", clear);
    return () => {
      document.removeEventListener("pointerdown", respond, true);
      document.removeEventListener("keydown", respond, true);
      preference.removeEventListener("change", clear);
      clear();
    };
  }, [pathname]);

  return null;
}
