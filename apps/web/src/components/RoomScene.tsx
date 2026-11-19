/**
 * The Open Room illustration: a Highrise-style room seen from above. Visitors
 * walk in, Kojy's greeter bot welcomes them, someone asks !rules and it
 * answers. Used on the landing page and the sign-in page.
 * OWNERSHIP: apps/web/src/components
 *
 * Motion is pure CSS and only runs inside an element with the `or-motion`
 * class (set when the visitor hasn't asked for reduced motion). Without it
 * the scene shows its finished state: everyone in the room, the !rules reply.
 */

import "./room-scene.css";

type Props = {
  /** "light" sits on the page ground; "onBlue" sits on a cobalt panel. */
  tone?: "light" | "onBlue";
  /** Describes the scene for screen readers. */
  label?: string;
};

const TILE_LINES: ReadonlyArray<readonly [number, number, number, number]> = [
  [323.3, 141.7, 63.3, 271.7], [366.7, 163.3, 106.7, 293.3], [410, 185, 150, 315],
  [453.3, 206.7, 193.3, 336.7], [496.7, 228.3, 236.7, 358.3],
  [236.7, 141.7, 496.7, 271.7], [193.3, 163.3, 453.3, 293.3], [150, 185, 410, 315],
  [106.7, 206.7, 366.7, 336.7], [63.3, 228.3, 323.3, 358.3],
];

function Visitor({ x, y, color, walk, bob = "rs-bob" }: { x: number; y: number; color: string; walk?: string; bob?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={walk}>
        <ellipse cx="0" cy="0" rx="13" ry="4.5" fill="#0F1222" opacity="0.12" />
        <g className={bob}>
          <rect x="-10" y="-30" width="20" height="27" rx="9" fill={color} />
          <circle cx="0" cy="-39" r="9" fill={color} />
        </g>
      </g>
    </g>
  );
}

function Bubble({ x, y, w, text, cls, bot = true, hidden = false }: {
  x: number; y: number; w: number; text: string; cls: string; bot?: boolean; hidden?: boolean;
}) {
  const fill = bot ? "var(--rs-bubble)" : "#FFFFFF";
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={`rs-bubble ${cls}${hidden ? " rs-hid" : ""}`}>
        <rect x={-w / 2} y="-34" width={w} height="28" rx="10" fill={fill} className={bot ? undefined : "rs-edge"} />
        {bot
          ? <path d="M-5 -6 L0 2 L5 -6 Z" fill={fill} />
          : <path d="M-24 -6.5 L-32 3 L-14 -6.5 Z" fill={fill} />}
        <text x="0" y="-15.5" className={bot ? "rs-bt" : "rs-ut"}>{text}</text>
      </g>
    </g>
  );
}

export function RoomScene({ tone = "light", label }: Props) {
  const onBlue = tone === "onBlue";
  return (
    <div className={`rs rs--${tone}`}>
      {label ? <p className="rs-sr">{label}</p> : null}
      <svg viewBox="0 0 560 440" aria-hidden="true" className="rs-svg">
        <polygon points="20,250 280,120 280,24 20,154" fill={onBlue ? "#C9D3FF" : "#E8EBF2"} />
        <polygon points="280,120 540,250 540,154 280,24" fill={onBlue ? "#B4C2FF" : "#DDE1EA"} />
        <polygon points="98,181 163,148.5 163,98.5 98,131" fill={onBlue ? "#E9EDFF" : "#F5F6F8"} className="rs-edge" />
        <polygon points="462,211 498.4,229.2 498.4,163.2 462,145" fill={onBlue ? "#2A44D6" : "#C9D3FF"} />
        <polygon points="280,120 540,250 280,380 20,250" fill="#FFFFFF" className="rs-edge" />
        {TILE_LINES.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="rs-tile" />
        ))}
        <polygon points="262,226 326,258 262,290 198,258" fill="#E9EDFF" />

        <Visitor x={200} y={215} color="#AEB4C4" bob="rs-bob2" />

        <g transform="translate(262 258)">
          <ellipse cx="0" cy="0" rx="16" ry="5" fill="#0F1222" opacity="0.14" />
          <g className="rs-float">
            <rect x="-12" y="-34" width="24" height="31" rx="10" fill="#3B5BFD" />
            <circle cx="0" cy="-46" r="12" fill="#3B5BFD" />
            <g className="rs-eyes">
              <rect x="-6" y="-50" width="3" height="7" rx="1.5" fill="#FFFFFF" />
              <rect x="3" y="-50" width="3" height="7" rx="1.5" fill="#FFFFFF" />
            </g>
            <path d="M0 -58 V-64" className="rs-ant" />
            <circle cx="0" cy="-67" r="3" fill="#3B5BFD" />
          </g>
        </g>

        <Visitor x={345} y={270} color="#1F2433" walk="rs-v1" />
        <Visitor x={306} y={315} color="#7C8297" walk="rs-v2" />

        <Bubble x={262} y={186} w={148} text="Welcome in, mika_x!" cls="rs-b1" hidden />
        <Bubble x={262} y={186} w={190} text="Hey ren, glad you’re here!" cls="rs-b2" hidden />
        <Bubble x={262} y={186} w={196} text="Be kind. No spam. Have fun." cls="rs-b3" />
        <Bubble x={380} y={226} w={64} text="!rules" cls="rs-u1" bot={false} />
      </svg>
      {!onBlue ? (
        <div className="rs-chip" aria-hidden="true">
          <b>greeter-bot</b>
          <span><i className="rs-live" />Running</span>
        </div>
      ) : null}
    </div>
  );
}

/** Kojy's face: a cobalt circle with two eyes that blink now and then. */
export function KojyFace({ size = 28, className = "" }: { size?: number; className?: string }) {
  return <span className={`kj-face ${className}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
