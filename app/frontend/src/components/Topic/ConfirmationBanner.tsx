interface ConfirmationBannerProps {
  message: string
  detail?: string
  actionLabel: string
  onConfirm: () => void
  loading?: boolean
}

export function ConfirmationBanner({ message, detail, actionLabel, onConfirm, loading }: ConfirmationBannerProps) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-800">{message}</p>
        {detail && <p className="text-xs text-amber-600 mt-0.5">{detail}</p>}
      </div>
      <button
        className="shrink-0 text-sm px-4 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
        onClick={onConfirm}
        disabled={loading}
      >
        {loading ? "Processing..." : actionLabel}
      </button>
    </div>
  )
}
