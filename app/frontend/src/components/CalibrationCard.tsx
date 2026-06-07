import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { api, type CalibrationSummary } from "@/api/client"

export function CalibrationCard() {
  const [data, setData] = useState<CalibrationSummary | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => { api.calibration.get().then(setData).catch(() => setError(true)) }, [])

  if (error) {
    return (
      <Card className="border-border/70 bg-card/80">
        <CardHeader>
          <CardTitle>Forecast calibration</CardTitle>
          <CardDescription className="text-destructive">Couldn't load calibration data.</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  if (!data) return null

  return (
    <Card className="border-border/70 bg-card/80">
      <CardHeader>
        <CardTitle>Forecast calibration</CardTitle>
        <CardDescription>How well past forecasts matched actual outcomes (resolved topics only).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No resolved forecasts yet. Mark a topic's actual outcome on its <span className="font-medium">Verdict</span> tab
            (Outcome &amp; calibration) to start scoring calibration with the Brier score.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-6 text-sm">
              <div><span className="text-muted-foreground">Resolved forecasts:</span> <span className="font-semibold text-foreground">{data.count}</span></div>
              <div><span className="text-muted-foreground">Mean Brier:</span> <span className="font-mono font-semibold text-foreground">{data.mean_brier?.toFixed(4)}</span> <span className="text-xs text-muted-foreground">(lower is better)</span></div>
              {data.mean_log_score != null && <div><span className="text-muted-foreground">Mean log score:</span> <span className="font-mono font-semibold text-foreground">{data.mean_log_score.toFixed(4)}</span></div>}
            </div>

            {data.reliability.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Reliability — predicted vs. observed</div>
                {data.reliability.map(r => (
                  <div key={r.bucket} className="flex items-center gap-3 text-xs">
                    <span className="w-16 text-muted-foreground">{r.bucket}</span>
                    <span className="w-28">predicted {Math.round(r.predicted_mean * 100)}%</span>
                    <span className="w-28">observed {Math.round(r.observed_rate * 100)}%</span>
                    <span className="text-muted-foreground">n={r.n}</span>
                  </div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground">Well-calibrated = predicted ≈ observed in each bucket.</p>
              </div>
            )}

            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Resolved topics</div>
              {data.resolutions.map(r => (
                <div key={`${r.topic_id}-${r.version}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{r.topic_title ?? r.topic_id} <span className="text-xs text-muted-foreground">v{r.version}</span></span>
                  <span className="font-mono text-xs text-muted-foreground">Brier {r.brier_score.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
