import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";

type Side = "left" | "right";
type Widths = Partial<Record<Side, number>>;
const storageKey = "paper30min.panel-widths";
const minimum = { left: 155, right: 240 };
const maximum = { left: 360, right: 560 };
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

function readWidths(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return Object.fromEntries(
      (["left", "right"] as const)
        .filter((side) => Number.isFinite(saved?.[side]))
        .map((side) => [
          side,
          clamp(saved[side], minimum[side], maximum[side]),
        ]),
    );
  } catch {
    return {};
  }
}

export function usePanelLayout(leftOpen: boolean, rightOpen: boolean) {
  const [preferred, setPreferred] = useState<Widths>(readWidths);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{
    side: Side;
    x: number;
    width: number;
    pointer: number;
  } | null>(null);

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!resizing) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(preferred));
      } catch (error) {
        console.warn("无法保存面板宽度", error);
      }
    }
  }, [preferred, resizing]);

  const overlay = viewport <= 900;
  const defaultLeft = viewport <= 640 ? 155 : viewport <= 1150 ? 205 : 232;
  const defaultRight = viewport <= 1150 ? 295 : 336;
  // Reserve a readable center; a narrow window keeps the Agent as an overlay.
  const centerMinimum = Math.min(360, Math.max(0, viewport - minimum.left - 9));
  const budget = viewport - 9 - centerMinimum - (rightOpen && !overlay ? 8 : 0);
  const rightWidth = clamp(
    preferred.right ?? defaultRight,
    minimum.right,
    Math.min(
      maximum.right,
      Math.max(minimum.right, budget - (leftOpen ? minimum.left : 10)),
    ),
  );
  const leftMax = Math.min(
    maximum.left,
    Math.max(minimum.left, budget - (rightOpen && !overlay ? rightWidth : 0)),
  );
  const leftWidth = clamp(preferred.left ?? defaultLeft, minimum.left, leftMax);
  const rightMax = Math.min(
    maximum.right,
    Math.max(minimum.right, budget - (leftOpen ? leftWidth : 10)),
  );
  const widths = { left: leftWidth, right: rightWidth };
  const limits = { left: leftMax, right: rightMax };

  function finish() {
    drag.current = null;
    setResizing(false);
  }
  function separator(side: Side): HTMLAttributes<HTMLDivElement> {
    const update = (width: number) =>
      setPreferred((old) => ({
        ...old,
        [side]: clamp(width, minimum[side], limits[side]),
      }));
    return {
      role: "separator",
      tabIndex: 0,
      "aria-label": side === "left" ? "调整左侧栏宽度" : "调整 Agent 宽度",
      "aria-orientation": "vertical",
      "aria-valuemin": minimum[side],
      "aria-valuemax": Math.round(limits[side]),
      "aria-valuenow": Math.round(widths[side]),
      onPointerDown(event) {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          side,
          x: event.clientX,
          width: widths[side],
          pointer: event.pointerId,
        };
        setResizing(true);
      },
      onPointerMove(event) {
        const start = drag.current;
        if (start?.pointer !== event.pointerId || start.side !== side) return;
        update(
          start.width + (event.clientX - start.x) * (side === "left" ? 1 : -1),
        );
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onKeyDown(event) {
        const direction = side === "left" ? 1 : -1;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          update(
            widths[side] +
              (event.key === "ArrowRight" ? 1 : -1) *
                direction *
                (event.shiftKey ? 40 : 10),
          );
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          update(event.key === "Home" ? minimum[side] : limits[side]);
        }
      },
    };
  }

  return {
    resizing,
    separator,
    style: {
      "--sidebar": `${leftWidth}px`,
      "--aside": `${rightWidth}px`,
    } as CSSProperties,
  };
}
