import { AGENT_STYLE } from "../desk";

export function Avatar({ agent, size = 40, dim = false }: { agent: string; size?: number; dim?: boolean }) {
  const s = AGENT_STYLE[agent] ?? { initials: "?", color: "#57534e", soft: "#f5f5f4" };
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-white ${dim ? "opacity-40 grayscale" : ""}`}
      style={{ width: size, height: size, background: s.color, color: "white", fontSize: size * 0.36 }}
    >
      {s.initials}
    </span>
  );
}
