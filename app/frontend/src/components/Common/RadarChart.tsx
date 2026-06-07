interface RadarProps {
  data: Record<string, number>
  size?: number
}

const LABELS: Record<string, string> = {
  military_capacity: "Military",
  economic_control: "Economic",
  information_control: "Info",
  international_support: "Intl",
  internal_legitimacy: "Legit",
}

export function RadarChart({ data, size = 80 }: RadarProps) {
  const keys = Object.keys(data)
  const n = keys.length
  if (n < 3) return null

  const cx = size / 2
  const cy = size / 2
  const r = size * 0.36
  const labelR = size * 0.48

  function point(i: number, val: number): [number, number] {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    return [cx + r * (val / 100) * Math.cos(angle), cy + r * (val / 100) * Math.sin(angle)]
  }

  function labelPoint(i: number): [number, number] {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    return [cx + labelR * Math.cos(angle), cy + labelR * Math.sin(angle)]
  }

  // Grid rings at 25, 50, 75, 100
  const rings = [25, 50, 75, 100]

  const polyPoints = keys.map((k, i) => point(i, data[k])).map(([x, y]) => `${x},${y}`).join(" ")

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="text-muted-foreground">
      {/* Grid rings */}
      {rings.map(pct => {
        const pts = keys.map((_, i) => {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2
          return `${cx + r * (pct / 100) * Math.cos(angle)},${cy + r * (pct / 100) * Math.sin(angle)}`
        }).join(" ")
        return <polygon key={pct} points={pts} fill="none" stroke="currentColor" strokeWidth="0.5" opacity={0.4} />
      })}

      {/* Spokes */}
      {keys.map((_, i) => {
        const [x, y] = point(i, 100)
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" strokeWidth="0.5" opacity={0.4} />
      })}

      {/* Data polygon */}
      <polygon
        points={polyPoints}
        className="fill-primary/25 stroke-primary"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Data points */}
      {keys.map((k, i) => {
        const [x, y] = point(i, data[k])
        return <circle key={k} cx={x} cy={y} r="2.5" className="fill-primary" />
      })}

      {/* Labels */}
      {keys.map((k, i) => {
        const [lx, ly] = labelPoint(i)
        return (
          <text
            key={k}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="6"
            fill="currentColor"
          >
            {LABELS[k] ?? k.slice(0, 5)}
          </text>
        )
      })}
    </svg>
  )
}
