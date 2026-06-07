interface Props {
  score: number  // 0-100
  size?: number
}

export function CredibilityRing({ score, size = 32 }: Props) {
  const r = (size - 4) / 2
  const circ = 2 * Math.PI * r
  const filled = (score / 100) * circ
  const color = score >= 80 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444"

  return (
    <div className="relative flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f3f4f6" strokeWidth="3" />
        <circle
          cx={size/2} cy={size/2} r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-[9px] font-bold" style={{ color }}>{score}</span>
    </div>
  )
}
