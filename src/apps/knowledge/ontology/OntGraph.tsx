// 本体图谱画布：对象类型为节点、关系类型为带箭头连线。
// 力导向初始布局（结果可拖拽微调并回存），纯 SVG 自绘，不引图谱库依赖。
import { useEffect, useRef, useState } from "react";
import type { OntEdge, OntType } from "../api";

const W = 1000;
const H = 620;
const NODE_W = 152;
const NODE_H = 48;

type Pos = Record<string, [number, number]>;

const PALETTE = [
  "#1677ff",
  "#722ed1",
  "#13c2c2",
  "#52c41a",
  "#fa8c16",
  "#eb2f96",
  "#2f54eb",
  "#faad14",
];

function colorOf(t: OntType): string {
  const key = t.category || t.name;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function forceLayout(
  types: OntType[],
  edges: OntEdge[],
  seed?: Record<string, number[]> | null,
): Pos {
  const ids = types.map((t) => t.id);
  const pos: Pos = {};
  ids.forEach((id, i) => {
    const s = seed?.[id];
    if (s && s.length >= 2) {
      pos[id] = [s[0], s[1]];
    } else {
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2;
      pos[id] = [W / 2 + Math.cos(a) * 250, H / 2 + Math.sin(a) * 190];
    }
  });
  const k = 210;
  for (let iter = 0; iter < 300; iter++) {
    const fx: Record<string, number> = {};
    const fy: Record<string, number> = {};
    ids.forEach((id) => {
      fx[id] = 0;
      fy[id] = 0;
    });
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        let dx = pos[a][0] - pos[b][0];
        let dy = pos[a][1] - pos[b][1];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = 0.7;
          dy = 0.3;
          d2 = 0.6;
        }
        const d = Math.sqrt(d2);
        const f = 30000 / d2;
        fx[a] += (dx / d) * f;
        fy[a] += (dy / d) * f;
        fx[b] -= (dx / d) * f;
        fy[b] -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos[e.src_type];
      const b = pos[e.dst_type];
      if (!a || !b) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - k) * 0.03;
      fx[e.src_type] += (dx / d) * f;
      fy[e.src_type] += (dy / d) * f;
      fx[e.dst_type] -= (dx / d) * f;
      fy[e.dst_type] -= (dy / d) * f;
    }
    for (const id of ids) {
      fx[id] += (W / 2 - pos[id][0]) * 0.01;
      fy[id] += (H / 2 - pos[id][1]) * 0.01;
      const nx = pos[id][0] + Math.max(-16, Math.min(16, fx[id] * 0.03));
      const ny = pos[id][1] + Math.max(-16, Math.min(16, fy[id] * 0.03));
      pos[id] = [
        Math.max(NODE_W / 2 + 6, Math.min(W - NODE_W / 2 - 6, nx)),
        Math.max(NODE_H / 2 + 6, Math.min(H - NODE_H / 2 - 6, ny)),
      ];
    }
  }
  return pos;
}

interface Props {
  types: OntType[];
  edges: OntEdge[];
  layout: Record<string, number[]>;
  selectedTypeId: string | null;
  onSelect: (typeId: string | null) => void;
  onPositionsChange: (positions: Record<string, number[]>) => void;
}

export default function OntGraph({
  types,
  edges,
  layout,
  selectedTypeId,
  onSelect,
  onPositionsChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pos, setPos] = useState<Pos>(() => forceLayout(types, edges, layout));
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 数据变化（新增/删除类型）时重排；已有坐标的类型保留原位。
  useEffect(() => {
    setPos((prev) => forceLayout(types, edges, { ...layout, ...prev }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, edges]);

  const clientToSvg = (clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    const offX = (rect.width - W * scale) / 2;
    const offY = (rect.height - H * scale) / 2;
    return [(clientX - rect.left - offX) / scale, (clientY - rect.top - offY) / scale];
  };

  useEffect(() => {
    function onMove(ev: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const [x, y] = clientToSvg(ev.clientX, ev.clientY);
      drag.moved = true;
      setPos((prev) => ({
        ...prev,
        [drag.id]: [
          Math.max(NODE_W / 2, Math.min(W - NODE_W / 2, x - drag.offsetX)),
          Math.max(NODE_H / 2, Math.min(H - NODE_H / 2, y - drag.offsetY)),
        ],
      }));
    }
    function onUp() {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.moved) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          setPos((latest) => {
            onPositionsChange(latest);
            return latest;
          });
        }, 600);
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = (typeId: string) =>
    edges.some((e) => e.src_type === typeId || e.dst_type === typeId);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", height: "100%", userSelect: "none", background: "var(--ant-color-bg-container)" }}
      onClick={() => onSelect(null)}
    >
      <defs>
        <marker
          id="onto-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--ant-color-text-tertiary)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const a = pos[e.src_type];
        const b = pos[e.dst_type];
        if (!a || !b) return null;
        const label = e.display_name || e.name;
        const dim = selectedTypeId !== null && e.src_type !== selectedTypeId && e.dst_type !== selectedTypeId;
        if (e.src_type === e.dst_type) {
          // 自环：节点上方一个小圆弧
          const cx = a[0];
          const cy = a[1] - NODE_H / 2 - 26;
          const d = `M ${cx - 26} ${a[1] - NODE_H / 2 + 4} C ${cx - 40} ${cy - 24}, ${cx + 40} ${cy - 24}, ${cx + 26} ${a[1] - NODE_H / 2 + 4}`;
          return (
            <g
              key={e.id}
              opacity={dim ? 0.35 : 1}
              onMouseEnter={() => setHoverEdge(e.id)}
              onMouseLeave={() => setHoverEdge(null)}
            >
              <path
                d={d}
                fill="none"
                stroke={hoverEdge === e.id ? "var(--ant-color-primary)" : "var(--ant-color-text-tertiary)"}
                strokeWidth={hoverEdge === e.id ? 2 : 1.4}
                markerEnd="url(#onto-arrow)"
              />
              <text x={cx} y={cy - 18} textAnchor="middle" fontSize={12} fill="var(--ant-color-text-secondary)" stroke="var(--ant-color-fill-quaternary)" strokeWidth={4} paintOrder="stroke">
                {label}
              </text>
            </g>
          );
        }
        // 裁剪到节点边缘，箭头不压在节点上
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.max(1, Math.hypot(dx, dy));
        const ux = dx / len;
        const uy = dy / len;
        const x1 = a[0] + ux * (NODE_W / 2);
        const y1 = a[1] + uy * (NODE_H / 2);
        const x2 = b[0] - ux * (NODE_W / 2 + 10);
        const y2 = b[1] - uy * (NODE_H / 2 + 10);
        return (
          <g
            key={e.id}
            opacity={dim ? 0.35 : 1}
            onMouseEnter={() => setHoverEdge(e.id)}
            onMouseLeave={() => setHoverEdge(null)}
          >
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={hoverEdge === e.id ? "var(--ant-color-primary)" : "var(--ant-color-text-tertiary)"}
              strokeWidth={hoverEdge === e.id ? 2 : 1.4}
              markerEnd="url(#onto-arrow)"
            />
            <text
              x={(x1 + x2) / 2}
              y={(y1 + y2) / 2 - 6}
              textAnchor="middle"
              fontSize={12}
              fill="var(--ant-color-text-secondary)"
              stroke="var(--ant-color-fill-quaternary)"
              strokeWidth={4}
              paintOrder="stroke"
            >
              {label}
            </text>
          </g>
        );
      })}
      {types.map((t) => {
        const p = pos[t.id];
        if (!p) return null;
        const color = colorOf(t);
        const dim = selectedTypeId !== null && selectedTypeId !== t.id && !connected(t.id);
        const selected = selectedTypeId === t.id;
        return (
          <g
            key={t.id}
            transform={`translate(${p[0]}, ${p[1]})`}
            opacity={dim ? 0.4 : 1}
            style={{ cursor: "pointer" }}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              const [x, y] = clientToSvg(ev.clientX, ev.clientY);
              dragRef.current = { id: t.id, offsetX: x - p[0], offsetY: y - p[1], moved: false };
            }}
            onClick={(ev) => {
              ev.stopPropagation();
              onSelect(selected ? null : t.id);
            }}
          >
            <rect
              x={-NODE_W / 2}
              y={-NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill="var(--ant-color-bg-container)"
              stroke={selected ? color : "var(--ant-color-border-secondary)"}
              strokeWidth={selected ? 2.5 : 1.2}
            />
            <rect x={-NODE_W / 2} y={-NODE_H / 2} width={6} height={NODE_H} rx={3} fill={color} />
            <text
              x={-NODE_W / 2 + 14}
              y={-4}
              fontSize={14}
              fontWeight={600}
              fill="var(--ant-color-text)"
            >
              {t.display_name || t.name}
            </text>
            <text x={-NODE_W / 2 + 14} y={14} fontSize={11} fill="var(--ant-color-text-tertiary)">
              {t.name} · {t.instance_count} 实例
            </text>
          </g>
        );
      })}
    </svg>
  );
}
